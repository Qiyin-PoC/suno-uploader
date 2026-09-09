#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::Mutex as AsyncMutex;

struct Job {
    id: String,
    child: Arc<Mutex<Child>>,
    cancel: PathBuf,
}
struct Core {
    token: String,
    sources: Vec<PathBuf>,
    output: Option<PathBuf>,
    job: Option<Job>,
}
struct Service {
    core: AsyncMutex<Core>,
    http: reqwest::Client,
    origin: String,
    device: String,
    data: PathBuf,
    runtime: PathBuf,
}

fn trusted_origin(raw: &str, preview: bool) -> Result<String, String> {
    if raw.is_empty() {
        return Ok(String::new());
    }
    let u = reqwest::Url::parse(raw).map_err(|_| "账号服务地址无效")?;
    let local = matches!(u.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
    if !u.username().is_empty()
        || u.password().is_some()
        || u.query().is_some()
        || u.fragment().is_some()
        || u.path() != "/"
        || !(u.scheme() == "https" || preview && local && u.scheme() == "http")
    {
        return Err("账号服务必须使用 HTTPS；仅本机验证构建允许本机 HTTP".into());
    }
    Ok(u.origin().ascii_serialization())
}
impl Service {
    async fn call(
        &self,
        token: &str,
        endpoint: &str,
        body: Option<Value>,
    ) -> Result<Value, String> {
        if self.origin.is_empty() {
            return Err("账号服务尚未配置".into());
        }
        let mut req = if let Some(b) = body {
            self.http
                .post(format!("{}{}", self.origin, endpoint))
                .json(&b)
        } else {
            self.http.get(format!("{}{}", self.origin, endpoint))
        };
        if !token.is_empty() {
            req = req.bearer_auth(token);
        }
        let mut res = req
            .send()
            .await
            .map_err(|_| "无法连接账号服务，请检查网络")?;
        let status = res.status();
        let mut bytes = Vec::new();
        while let Some(chunk) = res.chunk().await.map_err(|_| "账号服务响应中断")? {
            if bytes.len() + chunk.len() > 65536 {
                return Err("账号服务响应过大".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        let v: Value = serde_json::from_slice(&bytes).map_err(|_| "账号服务响应无效")?;
        if !status.is_success() {
            return Err(v["message"].as_str().unwrap_or("账号验证失败").into());
        }
        if !v.is_object() {
            return Err("账号服务响应无效".into());
        }
        Ok(v)
    }
    async fn authorize(&self, core: &Core, feature: &str) -> Result<(), String> {
        if core.token.is_empty() {
            return Err("请先登录期音账号".into());
        }
        let v = self
            .call(
                &core.token,
                "/v1/authorize",
                Some(json!({"feature":feature})),
            )
            .await?;
        if v["ok"] != true || v["valid"] != true {
            return Err(v["message"].as_str().unwrap_or("账号未开通或已到期").into());
        }
        Ok(())
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum AccountAction {
    Login,
    Register,
    Status,
    Logout,
}
#[tauri::command]
async fn account(
    action: AccountAction,
    email: Option<String>,
    password: Option<String>,
    state: tauri::State<'_, Service>,
) -> Result<Value, String> {
    let mut core = state.core.lock().await;
    match action {
        AccountAction::Login | AccountAction::Register => {
            if core.job.is_some() {
                return Err("请先停止当前任务再切换账号".into());
            }
            let login = matches!(action, AccountAction::Login);
            if login {
                core.token.clear();
            }
            let mut v=state.call("",if login {"/v1/login"} else {"/v1/register"},Some(json!({"email":email.unwrap_or_default(),"password":password.unwrap_or_default(),"device":state.device,"name":format!("Tauri {} {}",std::env::consts::OS,std::env::consts::ARCH)}))).await?;
            if login && v["ok"] == true {
                core.token = v["token"].as_str().unwrap_or_default().to_string();
            }
            v.as_object_mut().unwrap().remove("token");
            Ok(v)
        }
        AccountAction::Status => {
            if core.token.is_empty() {
                return Err("请登录期音账号；验证版重启后需重新登录".into());
            }
            state.call(&core.token, "/v1/session", None).await
        }
        AccountAction::Logout => {
            if core.job.is_some() {
                return Err("请先停止当前任务再退出账号".into());
            }
            let token = std::mem::take(&mut core.token);
            let result = state.call(&token, "/v1/logout", Some(json!({}))).await;
            Ok(
                json!({"ok":true,"message":if result.is_ok(){"已退出登录"}else{"本机已退出，服务端会话未能撤销"}}),
            )
        }
    }
}
#[tauri::command]
async fn choose(
    kind: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, Service>,
) -> Result<Option<Vec<String>>, String> {
    let folder = match kind.as_str() {
        "audio" => false,
        "folder" => true,
        _ => return Err("无效选择".into()),
    };
    let (tx, rx) = tokio::sync::oneshot::channel();
    let dialog = app.dialog().file();
    if folder {
        dialog.pick_folder(move |p| {
            let _ = tx.send(p.map(|p| vec![p]));
        });
    } else {
        dialog
            .add_filter("音频", &["wav", "mp3", "m4a", "flac", "ogg", "aiff"])
            .pick_files(move |p| {
                let _ = tx.send(p);
            });
    }
    let Some(paths) = rx.await.map_err(|_| "文件选择器已关闭")? else {
        return Ok(None);
    };
    if paths.len() > 100 { return Err("每批最多选择 100 首歌曲".into()); }
    let paths: Vec<PathBuf> = paths.into_iter().map(|p| p.into_path().map_err(|_| "请选择本机文件".to_string())).collect::<Result<_,_>>()?;
    let shown = paths.iter().map(|p| p.to_string_lossy().into_owned()).collect();
    let mut core = state.core.lock().await;
    if core.job.is_some() { return Err("任务进行中，不能更改文件".into()); }
    if folder { core.output = paths.into_iter().next(); }
    else { core.sources = paths; }
    Ok(Some(shown))
}
#[derive(Deserialize, Serialize, Clone)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Task {
    SunoLogin,
    Upload { title: String, #[serde(default)] index: usize },
    Download { url: String, format: String },
    Lyrics { mode: String, text: String },
    History,
}
fn arguments(
    task: &Task,
    core: &Core,
    data: &std::path::Path,
    runtime: &std::path::Path,
    cancel: &std::path::Path,
) -> Result<(String, Vec<String>), String> {
    let mut args = vec!["backend".into()];
    let feature = match task {
        Task::SunoLogin => {
            args.push("--login-only".into());
            "suno_upload"
        }
        Task::Upload { title, index } => {
            let source = core
                .sources
                .get(*index)
                .filter(|p| p.is_file())
                .ok_or("请先选择有效音频文件")?;
            if title.len() > 500 {
                return Err("歌曲名过长".into());
            }
            args.extend([
                "--source".into(),
                source.to_string_lossy().into_owned(),
                "--title".into(),
                title.clone(),
                "--speed".into(),
                "stable".into(),
            ]);
            "suno_upload"
        }
        Task::Download { url, format } => {
            if !["mp3", "wav", "m4a"].contains(&format.as_str()) || url.len() > 2048 {
                return Err("下载参数无效".into());
            }
            let u = reqwest::Url::parse(url).map_err(|_| "请粘贴 Suno 歌曲链接")?;
            if u.scheme() != "https"
                || !matches!(u.host_str(), Some("suno.com" | "www.suno.com"))
                || !u.username().is_empty()
                || u.password().is_some()
            {
                return Err("请粘贴 Suno HTTPS 歌曲链接".into());
            }
            let output = core
                .output
                .as_ref()
                .filter(|p| p.is_dir())
                .ok_or("请先选择保存文件夹")?;
            args = vec![
                "download".into(),
                "--url".into(),
                url.clone(),
                "--format".into(),
                format.clone(),
                "--output-dir".into(),
                output.to_string_lossy().into_owned(),
                "--work-root".into(),
                data.join("downloads").to_string_lossy().into_owned(),
                "--cancel-file".into(),
                cancel.to_string_lossy().into_owned(),
                "--ffmpeg".into(),
                runtime
                    .join(executable("ffmpeg"))
                    .to_string_lossy()
                    .into_owned(),
            ];
            "suno_download"
        }
        Task::Lyrics { mode, text } => {
            if ![
                "pinyin",
                "homophone",
                "cantonese",
                "english-pron",
                "korean-roman",
                "thai-roman",
            ]
            .contains(&mode.as_str())
                || text.len() > 16000
            {
                return Err("歌词格式无效或超过长度限制".into());
            }
            args.extend([
                "--lyrics-mode".into(),
                mode.clone(),
                "--lyrics".into(),
                text.clone(),
            ]);
            "lyrics_process"
        }
        Task::History => {
            args.push("--history".into());
            "suno_upload"
        }
    };
    Ok((feature.into(), args))
}
fn executable(name: &str) -> String {
    format!("{}{}", name, if cfg!(windows) { ".exe" } else { "" })
}
fn stop(job: &Job, force: bool) {
    let _ = std::fs::write(&job.cancel, b"cancel");
    if force {
        if let Ok(mut child) = job.child.lock() {
            // Each worker owns a process group, including FFmpeg. No unrelated process is killed.
            #[cfg(unix)]
            unsafe {
                libc::kill(-(child.id() as i32), libc::SIGTERM);
            }
            #[cfg(windows)]
            {
                let _ = Command::new("taskkill")
                    .args(["/PID", &child.id().to_string(), "/T", "/F"])
                    .output();
            }
            let _ = child.kill();
        }
    }
}
fn public_event(v: &Value) -> Value {
    let mut out = serde_json::Map::new();
    for k in [
        "type",
        "status",
        "message",
        "progress",
        "total",
        "done",
        "failed",
        "text",
        "songUrl",
        "localAudioPath",
        "outputPath",
        "filename",
        "loginOk",
        "ok",
        "items",
    ] {
        if let Some(value) = v.get(k) {
            out.insert(k.into(), value.clone());
        }
    }
    Value::Object(out)
}
fn terminal_success(v: &Value) -> bool {
    v["status"] == "succeeded"
        || v["type"] == "result"
        || v["ok"] == true && (v.get("text").is_some() || v.get("items").is_some())
}
#[tauri::command]
async fn start(
    task: Task,
    app: tauri::AppHandle,
    state: tauri::State<'_, Service>,
) -> Result<String, String> {
    let mut core = state.core.lock().await;
    if core.job.is_some() {
        return Err("请等待当前任务结束，或先停止它".into());
    }
    let id = uuid::Uuid::new_v4().to_string();
    let cancel = state.data.join(format!("cancel-{id}"));
    let (feature, args) = arguments(&task, &core, &state.data, &state.runtime, &cancel)?;
    // Connecting Suno is account setup, not a paid upload/download operation.
    if !matches!(task, Task::SunoLogin) {
        state.authorize(&core, &feature).await?;
    }
    let worker = state
        .runtime
        .join("qiyin-worker")
        .join(executable("qiyin-worker"));
    if !worker.is_file() || !state.runtime.join(executable("ffmpeg")).is_file() {
        return Err("安装包缺少音频引擎，请重新构建或安装".into());
    }
    let mut command = Command::new(worker);
    command
        .args(args)
        .current_dir(&state.runtime)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .env("GAOBAI_APP_DATA", &state.data)
        .env("GAOBAI_PROJECT_ROOT", &state.runtime)
        .env("GAOBAI_CANCEL_FILE", &cancel)
        .env("GAOBAI_CDP_PORT", "24932")
        .env(
            "GAOBAI_FFMPEG_EXE",
            state.runtime.join(executable("ffmpeg")),
        );
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn().map_err(|_| "无法启动音频引擎")?;
    let stdout = child.stdout.take().ok_or("无法读取音频引擎输出")?;
    let child = Arc::new(Mutex::new(child));
    core.job = Some(Job {
        id: id.clone(),
        child: child.clone(),
        cancel: cancel.clone(),
    });
    let job_id = id.clone();
    std::thread::spawn(move || {
        let mut success = false;
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if line.len() > 262144 {
                continue;
            }
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                if terminal_success(&v) {
                    success = true;
                }
                if v["type"] == "failed" || v["type"] == "cancelled" || v["status"] == "failed" {
                    success = false;
                }
                if v["type"] != "log" {
                    let _ = app.emit("worker", json!({"id":job_id,"event":public_event(&v)}));
                }
            }
        }
        let code = child.lock().ok().and_then(|mut c| c.wait().ok());
        let cancelled = cancel.exists();
        let _ = std::fs::remove_file(&cancel);
        tauri::async_runtime::block_on(async {
            let state = app.state::<Service>();
            let mut core = state.core.lock().await;
            if core.job.as_ref().map(|j| &j.id) == Some(&job_id) {
                core.job = None;
            }
        });
        let status = if cancelled {
            "cancelled"
        } else if success && code.is_some_and(|c| c.success()) {
            "succeeded"
        } else {
            "failed"
        };
        let _ = app.emit(
            "worker",
            json!({"id":job_id,"finished":true,"status":status}),
        );
    });
    Ok(id)
}
#[tauri::command]
async fn cancel(state: tauri::State<'_, Service>) -> Result<(), String> {
    let core = state.core.lock().await;
    if let Some(job) = &core.job {
        stop(job, true);
    }
    Ok(())
}
#[tauri::command]
fn info(state: tauri::State<'_, Service>) -> Value {
    json!({"version":"0.1.0","architecture":std::env::consts::ARCH,"configured":!state.origin.is_empty(),"localPreview":option_env!("QIYIN_LOCAL_PREVIEW")==Some("1"),"runtime":state.runtime.join("qiyin-worker").join(executable("qiyin-worker")).is_file()})
}
#[tauri::command]
async fn check_update() -> Result<Value, String> {
    // No production domain or signing key has been provided. Never report 'up to date'.
    Err("更新服务与签名公钥尚未配置；本验证版不能自动更新".into())
}
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let data = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&data, std::fs::Permissions::from_mode(0o700))?;
            }
            let device_file = data.join("device-id");
            let device = std::fs::read_to_string(&device_file)
                .ok()
                .filter(|s| uuid::Uuid::parse_str(s).is_ok())
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            std::fs::write(device_file, &device)?;
            let local = option_env!("QIYIN_LOCAL_PREVIEW") == Some("1");
            let origin =
                trusted_origin(option_env!("QIYIN_TAURI_LICENSE_URL").unwrap_or(""), local)?;
            let runtime = if cfg!(debug_assertions) {
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("runtime")
            } else {
                app.path().resource_dir()?.join("runtime")
            };
            let http = reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(20))
                .build()?;
            app.manage(Service {
                core: AsyncMutex::new(Core {
                    token: String::new(),
                    sources: Vec::new(),
                    output: None,
                    job: None,
                }),
                http,
                origin,
                device,
                data,
                runtime,
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                tauri::async_runtime::block_on(async {
                    let state = window.state::<Service>();
                    let core = state.core.lock().await;
                    if let Some(job) = &core.job {
                        stop(job, true);
                    }
                });
            }
        })
        .invoke_handler(tauri::generate_handler![
            account,
            choose,
            start,
            cancel,
            info,
            check_update
        ])
        .build(tauri::generate_context!())
        .expect("无法启动期音验证版")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
                tauri::async_runtime::block_on(async {
                    let state = app.state::<Service>();
                    let core = state.core.lock().await;
                    if let Some(job) = &core.job {
                        stop(job, true);
                    }
                });
            }
        });
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn production_rejects_untrusted_services() {
        for u in [
            "http://example.com",
            "http://127.0.0.1:18870",
            "https://user:pass@example.com",
            "https://example.com/path",
            "https://example.com/?secret=x",
        ] {
            assert!(trusted_origin(u, false).is_err(), "{u}");
        }
        assert!(trusted_origin("https://example.com", false).is_ok());
        assert!(trusted_origin("http://127.0.0.1:18870", true).is_ok());
        assert!(trusted_origin("http://evil.com", true).is_err());
    }
    #[test]
    fn exit_or_progress_does_not_prove_success() {
        assert!(!terminal_success(
            &json!({"type":"progress","done":1,"total":1})
        ));
        assert!(!terminal_success(&json!({"status":"running","ok":true})));
        assert!(!terminal_success(&json!({"type":"failed"})));
        assert!(terminal_success(&json!({"status":"succeeded"})));
    }
    #[test]
    fn tokens_never_reach_renderer() {
        let v = public_event(
            &json!({"type":"result","loginOk":true,"token":"secret","tokenCheck":{"token":"secret"}}),
        );
        assert!(!v.to_string().contains("secret"));
    }
    #[test]
    fn upload_queue_uses_only_selected_file_indices() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&root).unwrap();
        let files = vec![root.join("first.wav"), root.join("second.wav")];
        for file in &files { std::fs::write(file, b"audio").unwrap(); }
        let c = Core { token: String::new(), sources: files.clone(), output: None, job: None };
        let (_, args) = arguments(&Task::Upload { title: "second".into(), index: 1 }, &c, &root, &root, &root).unwrap();
        assert!(args.contains(&files[1].to_string_lossy().to_string()));
        assert!(!args.contains(&files[0].to_string_lossy().to_string()));
        assert!(arguments(&Task::Upload { title: "bad".into(), index: 2 }, &c, &root, &root, &root).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn arguments_reject_missing_files_bad_formats_and_non_suno_urls() {
        let c = Core {
            token: String::new(),
            sources: Vec::new(),
            output: None,
            job: None,
        };
        let p = PathBuf::from("/tmp");
        assert!(arguments(
            &Task::Upload {
                title: "test".into(), index: 0
            },
            &c,
            &p,
            &p,
            &p
        )
        .is_err());
        assert!(arguments(
            &Task::Download {
                url: "https://evil.com/song/x".into(),
                format: "mp3".into()
            },
            &c,
            &p,
            &p,
            &p
        )
        .is_err());
        assert!(arguments(
            &Task::Lyrics {
                mode: "shell".into(),
                text: "x".into()
            },
            &c,
            &p,
            &p,
            &p
        )
        .is_err());
    }
}

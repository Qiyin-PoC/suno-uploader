(() => {
  const api = window.gaobai;
  const byId = (id) => document.getElementById(id);
  const form = byId("sunoDownloadForm");
  if (!form || !api?.getSunoDownloadState) return;
  let snapshot = { running: false, taskId: "" };
  let submitting = false;
  let eventRevision = 0;
  const fields = [...form.querySelectorAll("input, textarea, button")];
  const message = byId("sunoDownloadMessage");
  const badge = byId("sunoDownloadBadge");
  const progress = byId("sunoDownloadProgress");
  const cancel = byId("sunoDownloadCancel");
  const reveal = byId("sunoDownloadReveal");

  function showError(result) {
    message.textContent = result?.message || "操作未能完成，请重试。";
  }

  function render(next) {
    snapshot = next;
    const list = byId("sunoDownloadItems");
    if (list) list.replaceChildren(...(next.items || []).map((item, index) => {
      const row = document.createElement("li");
      const label = ({pending:"等待",running:"下载中",succeeded:"已保存",failed:"失败",cancelled:"未下载"})[item.status] || item.status;
      row.textContent = `${label} · ${item.filename || item.url}${item.status === "failed" ? ` — ${item.message}` : ""}`;
      return row;
    }));
    const busy = Boolean(next.running || submitting);
    for (const field of fields) field.disabled = busy;
    byId("sunoDownloadStart").textContent = busy ? "下载处理中…" : next.status === "failed" ? "重新下载" : "开始下载";
    badge.textContent = ({ idle: "等待开始", running: "处理中", succeeded: "已保存", failed: "下载失败", cancelled: "已取消" })[next.status] || "准备中";
    badge.dataset.status = next.status || "idle";
    message.textContent = next.message || "粘贴歌曲链接，选择格式后开始下载。";
    byId("sunoDownloadDirectory").textContent = next.outputDirectory || "系统下载文件夹";
    byId("sunoDownloadTitle").textContent = next.filename || next.title || (busy ? "正在准备歌曲" : "准备好一首歌");
    if (next.running && (next.indeterminate || !Number.isFinite(next.progress))) progress.removeAttribute("value");
    else progress.value = next.status === "succeeded" ? 100 : Number(next.progress || 0);
    const mb = (value) => (Number(value) / 1024 / 1024).toFixed(1);
    byId("sunoDownloadBytes").textContent = next.receivedBytes > 0
      ? `已接收 ${mb(next.receivedBytes)} MB${next.totalBytes > 0 ? ` / ${mb(next.totalBytes)} MB` : ""}` : "";
    byId("sunoDownloadSupport").textContent = next.supportId ? `问题编号：${next.supportId}` : "";
    byId("sunoDownloadWarning").textContent = next.warningMessage || "";
    byId("sunoDownloadWarning").classList.toggle("hidden", !next.warningMessage);
    cancel.classList.toggle("hidden", !next.running);
    cancel.disabled = next.phase === "cancelling";
    cancel.textContent = cancel.disabled ? "正在取消…" : "取消下载";
    reveal.classList.toggle("hidden", next.running || !next.filename);
  }

  api.onSunoDownloadEvent((next) => {
    eventRevision += 1;
    const previous = snapshot;
    render(next);
    if (previous.running && !next.running && typeof playTaskSound === "function") {
      if (next.status === "succeeded") playTaskSound("success");
      else if (next.status === "failed") playTaskSound("failure");
    }
  });
  const initialRevision = eventRevision;
  api.getSunoDownloadState().then((next) => {
    if (eventRevision === initialRevision) render(next);
  }).catch(() => showError({ message: "下载模块初始化失败，请重新打开软件。" }));

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submitting || snapshot.running) return;
    if (typeof requireLicense === "function" && !requireLicense("歌曲下载")) return;
    const url = byId("sunoDownloadUrl").value.trim();
    const format = form.querySelector('input[name="sunoDownloadFormat"]:checked').value;
    submitting = true;
    render(snapshot);
    const revision = eventRevision;
    try {
      const result = await api.startSunoDownload({ url, format });
      if (result.taskId && revision === eventRevision) snapshot = result;
      submitting = false;
      render(snapshot);
      if (!result.ok) showError(result);
    } catch {
      submitting = false;
      render(snapshot);
      showError({ message: "下载未能启动，请重试。" });
    }
  });

  byId("sunoDownloadChooseDir").addEventListener("click", async () => {
    try {
      const result = await api.pickSunoDownloadDirectory();
      if (!result.ok) showError(result);
      else render(result);
    } catch { showError({ message: "无法打开文件夹选择窗口。" }); }
  });
  cancel.addEventListener("click", async () => {
    cancel.disabled = true;
    try {
      const result = await api.cancelSunoDownload(snapshot.taskId);
      if (!result.ok && !result.running) { render(snapshot); showError(result); }
    } catch { render(snapshot); showError({ message: "取消未能完成，请重试。" }); }
  });
  reveal.addEventListener("click", async () => {
    try {
      const result = await api.revealSunoDownload();
      if (!result.ok) showError(result);
    } catch { showError({ message: "无法打开文件位置，请到保存文件夹查看。" }); }
  });
})();

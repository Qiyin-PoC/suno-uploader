fn main() {
    for key in ["QIYIN_FREE_EXPERIENCE", "QIYIN_LOCAL_PREVIEW", "QIYIN_TAURI_LICENSE_URL", "TAURI_CONFIG"] {
        println!("cargo:rerun-if-env-changed={}", key);
    }
    tauri_build::build()
}

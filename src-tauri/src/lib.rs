#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Portable mode (feature `portable`): point WebView2's user-data folder NEXT TO the .exe so the
    // wallet's encrypted storage travels with the executable (e.g. on a USB stick) instead of living
    // in %AppData%. Must be set before the webview is created. No-op for the installed build.
    #[cfg(all(feature = "portable", target_os = "windows"))]
    {
        if std::env::var_os("WEBVIEW2_USER_DATA_FOLDER").is_none() {
            if let Ok(exe) = std::env::current_exe() {
                if let Some(dir) = exe.parent() {
                    let data = dir.join("KeryxWalletData");
                    let _ = std::fs::create_dir_all(&data);
                    std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", data);
                }
            }
        }
    }

    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

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
        .setup(|app| {
            size_to_monitor(app.handle());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Size the window from the monitor it opened on.
///
/// The configured width/height are a fixed fallback, so on a 3440x1440 display the app used a
/// small box in the middle of the screen. Instead take 82% of the monitor's logical height and
/// give the window a 16:10 shape, never wider than 90% of the display. Deliberately driven by
/// height, not width: on an ultrawide, scaling by width would produce a 2800px-wide window whose
/// rows are unreadably sparse, while height is what actually limits how much history fits.
///
/// Only the initial size — the user can resize or maximize freely afterwards.
fn size_to_monitor(app: &tauri::AppHandle) {
    use tauri::{LogicalSize, Manager};

    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    let Ok(Some(monitor)) = win.current_monitor() else {
        return; // no monitor info (headless/RDP edge cases) — keep the configured size
    };
    let screen = monitor.size().to_logical::<f64>(monitor.scale_factor());
    // Floors match the minWidth/minHeight in tauri.conf.json; ceilings keep the window sane on
    // a 4K/5K panel, where 82% would be larger than anyone wants a wallet to be.
    let height = (screen.height * 0.82).clamp(560.0, 1500.0);
    let width = (height * 1.6).min(screen.width * 0.90).max(420.0);
    if win.set_size(LogicalSize::new(width, height)).is_ok() {
        let _ = win.center();
    }
}

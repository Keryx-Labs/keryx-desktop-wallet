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

    #[cfg(target_os = "linux")]
    prefer_x11_on_wayland();

    tauri::Builder::default()
        .setup(|app| {
            size_to_monitor(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![krx_market_price])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// NonKYC public ticker for the KRX/USDT market. The webview cannot call this itself: the
/// exchange answers 403 to any request that carries an Origin header, and the 200 response
/// has no Access-Control-Allow-Origin. This process does not send Origin.
const KRX_TICKER_URL: &str = "https://api.nonkyc.io/api/v2/ticker/KRX_USDT";

#[derive(serde::Serialize)]
struct KrxTicker {
    last_price: String,
    change_percent: String,
}

#[derive(serde::Deserialize)]
struct TickerBody {
    last_price: String,
    change_percent: String,
}

/// Last traded KRX/USDT price and the 24h change, both as the exchange printed them.
///
/// Kept as strings on purpose: the frontend multiplies the balance by the price with integer
/// arithmetic, and a float round-trip here would be the only place that could drift.
///
/// A thread-pool job, not a main-thread call: the request can take up to its 8s timeout, and a
/// sync command would freeze the window for that long on every poll.
#[tauri::command]
async fn krx_market_price() -> Result<KrxTicker, String> {
    tauri::async_runtime::spawn_blocking(fetch_ticker)
        .await
        .map_err(|e| e.to_string())?
}

fn fetch_ticker() -> Result<KrxTicker, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .user_agent("KeryxWallet")
        .build()
        .map_err(|e| e.to_string())?;
    let body: TickerBody = client
        .get(KRX_TICKER_URL)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .map_err(|e| e.to_string())?;
    if !is_plain_decimal(&body.last_price) {
        return Err("ticker last_price is not a decimal".into());
    }
    // A missing or odd change must not blank the price. The hero simply omits the percent.
    let change_percent = if is_signed_decimal(&body.change_percent) {
        body.change_percent
    } else {
        String::new()
    };
    Ok(KrxTicker {
        last_price: body.last_price,
        change_percent,
    })
}

/// Non-negative decimal: "0.00084214" or "1". No sign, no exponent, no thousands separators.
fn is_plain_decimal(s: &str) -> bool {
    let mut dot = false;
    let mut digits = 0u32;
    for c in s.chars() {
        if c == '.' {
            if dot {
                return false;
            }
            dot = true;
        } else if c.is_ascii_digit() {
            digits += 1;
        } else {
            return false;
        }
    }
    digits > 0 && !s.starts_with('.') && !s.ends_with('.')
}

/// Decimal that may carry one leading '+' or '-'.
fn is_signed_decimal(s: &str) -> bool {
    let rest = s
        .strip_prefix('+')
        .or_else(|| s.strip_prefix('-'))
        .unwrap_or(s);
    is_plain_decimal(rest)
}

/// Run GTK through XWayland on a GNOME Wayland session with the NVIDIA driver.
///
/// On GNOME Wayland the compositor draws no titlebar, so GTK paints its own inside the same surface
/// as the WebKitGTK view. On NVIDIA that surface comes up with no titlebar at all and the window
/// can be neither moved nor minimized (WEBKIT_DISABLE_DMABUF_RENDERER does not help). Under X11
/// the compositor draws the decorations itself and the window behaves normally.
///
/// Limited to that stack: elsewhere native Wayland works, and XWayland would only cost crisp
/// rendering on fractional scaling. Must run before GTK initializes, i.e. before the Builder. An
/// explicit GDK_BACKEND wins, so `GDK_BACKEND=wayland keryx-wallet` still opts back into native
/// Wayland; and without an X display (no XWayland) we leave GTK alone rather than fail to open a
/// window.
#[cfg(target_os = "linux")]
fn prefer_x11_on_wayland() {
    use std::env;
    use std::path::Path;

    let wayland = env::var_os("WAYLAND_DISPLAY").is_some()
        || env::var("XDG_SESSION_TYPE").is_ok_and(|t| t.eq_ignore_ascii_case("wayland"));
    let gnome = env::var("XDG_CURRENT_DESKTOP").is_ok_and(|d| d.to_ascii_lowercase().contains("gnome"));
    let nvidia = Path::new("/proc/driver/nvidia/version").exists() || Path::new("/sys/module/nvidia").exists();
    if wayland && gnome && nvidia && env::var_os("GDK_BACKEND").is_none() && env::var_os("DISPLAY").is_some() {
        env::set_var("GDK_BACKEND", "x11");
    }
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

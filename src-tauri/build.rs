fn main() {
    // `allow-krx-market-price` in capabilities/default.json is generated from this list.
    // Without it the capability check only knows the core plugins, and the build rejects
    // the custom command.
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["krx_market_price"])),
    )
    .expect("failed to run tauri build script");
}

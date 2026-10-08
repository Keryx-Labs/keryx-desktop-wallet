fn main() {
    // The `allow-*` permissions in capabilities/default.json are generated from this list.
    // Without it the capability check only knows the core plugins, and the build rejects
    // the custom commands.
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&["save_escrow_cert", "krx_market_price"]),
        ),
    )
    .expect("failed to run tauri build script");
}

# Icon set

`master-1024.png` is the source: the round Keryx mark (neon K on a black disc, transparent
corners), upscaled from the 600px original. Everything else here is derived from it.

## Rebuilding

    npx tauri icon src-tauri/icons/master-1024.png

regenerates the PNG/icns set plus the Android and iOS sets. Then run the post-processing
script (see the session notes) for the small frames: the neon strokes are a hairline with a
bloom, so below 48px they are re-laid slightly bolder before downscaling (stroke mask dilated
by 8px in 1024-space up to 48px, 4px up to 96px, none above). That step also rebuilds
`icon.ico` with every size Windows asks for (16, 20, 24, 28, 32, 40, 48, 56, 64, 96, 128, 256);
`tauri icon` alone emits only 6 frames and lets Windows resample the rest.

Cargo does **not** re-run `tauri-build` when only image files change: touch `build.rs` or
`tauri.conf.json` first, or the exe keeps the icon it already had. Windows also caches icons
per path: if a pinned task bar entry still shows the old one, run `ie4uinit.exe -show` or
restart Explorer.

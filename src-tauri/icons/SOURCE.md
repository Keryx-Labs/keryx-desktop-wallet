# icon.ico

The artwork here is the original, unchanged. `icon.ico` is the one file **not** produced by
`npx tauri icon` — it is built from `icon.png` (the 512px master) by a script, for two
reasons, both about how the task bar looked:

**1. Every size Windows asks for now has its own frame:** 16, 20, 24, 28, 32, 40, 48, 56, 64,
96, 128, 256. Windows picks per DPI scale — 16/32 at 100%, 20/40 at 125%, 24/48 at 150%,
28/56 at 175% — and resamples any size it does not find. `tauri icon` emits only
16/24/32/48/64/256, so 40px, which is the task bar at 150% scaling and a very common setting,
was being scaled down from the 48px frame. Anything Windows resamples itself comes out soft.

**2. Below 48px the neon strokes are re-laid slightly bolder.** The art draws the K as a
hairline outline with a bloom; that line is about 10px wide at 512, so under a plain downscale
it lands on 0.6px at 32px and greys out into mush. Those frames composite the SAME stroke mask
back over the downscaled art, dilated by 4px in 512-space, in the art's own measured stroke
colour (37, 226, 24). The tile, the glow, the hexagon, the framing and the colours are
untouched — it is the same drawing with its lines holding together. Dilation is 4px up to
48px, 2px up to 96px, none above; more than that starts closing the counters and the hexagon
merges into a blob.

`scratchpad/icon-plain-frames.ico` (outside the repo) holds the same 12 frames with **no**
thickening, if the literal pixels of a plain downscale are ever preferred.

## Rebuilding

Cargo does **not** re-run `tauri-build` when only image files change — touch `build.rs` or
`tauri.conf.json` first, or the exe keeps the icon it already had. Verify what actually landed
in the binary rather than trusting the build output:

    [System.Drawing.Icon]::ExtractAssociatedIcon($exe).ToBitmap()

Windows also caches icons per path: if a pinned task bar entry still shows the old one, run
`ie4uinit.exe -show` or restart Explorer.

Re-running `npx tauri icon` regenerates the PNG/icns set from a square source, and will
overwrite `icon.ico` with the 6-frame version — rebuild it afterwards.

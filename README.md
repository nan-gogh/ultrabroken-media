# Ultrabroken Media

Cloudflare Worker + R2 backend for hosting media assets (screenshots, video clips, social cards) for the [Ultrabroken Archives](https://nan-gogh.github.io/ultrabroken-documentation/) wiki. Includes a browser-based video editor that works both locally (FFmpeg.wasm, no upload required) and remotely (GitHub Actions, full quality).

## Architecture

- **R2 bucket** — stores all media files (screenshots, video clips, social cards)
- **Worker** — serves files publicly, hosts a management UI at `/manage`
- **Cloudflare Access** — gates `/manage` with GitHub OAuth (editors log in with their GitHub account)
- **GitHub Actions** — runs remote video edits via `edit.yml` when dispatched by the Worker

## File Structure (in R2)

```
image/     → Screenshots (AVIF)
video/     → Video clips (H.264+AAC MP4)
social/    → Social card PNGs
```

## Public Interfaces (no auth)

| | URL |
|---|---|
| **Media Portal** | [`nan-gogh.github.io/ultrabroken-media/`](https://nan-gogh.github.io/ultrabroken-media/) |
| **Public R2 browser** | [`nan-gogh.github.io/ultrabroken-media/browser/`](https://nan-gogh.github.io/ultrabroken-media/browser/) |
| **Local video editor** | [`nan-gogh.github.io/ultrabroken-media/editor/`](https://nan-gogh.github.io/ultrabroken-media/editor/) |

All are static GitHub Pages — no login, no upload, no server calls. The portal is a gateway that links to both public and authenticated interfaces. The local editor runs entirely in-browser via FFmpeg.wasm.

## Authenticated Interfaces (GitHub OAuth via Cloudflare Access)

| | URL |
|---|---|
| **Media Vault** (manage) | [`ultrabroken-media.gl1tchcr4vt.workers.dev/manage/`](https://ultrabroken-media.gl1tchcr4vt.workers.dev/manage/) |
| **Remote video editor** | [`ultrabroken-media.gl1tchcr4vt.workers.dev/manage/editor/`](https://ultrabroken-media.gl1tchcr4vt.workers.dev/manage/editor/) |

The vault lets editors upload, browse, copy URLs, rename, and delete files. When uploading videos, the **Compression** slider sets the H.264 CRF (18 = near-lossless, 30 = smaller file). Check **Skip — upload as-is** to bypass transcoding entirely.

The remote editor pulls clips from R2, dispatches edit jobs to GitHub Actions, and uploads results back to R2.

## Video Editor Pipeline

### Local mode
All processing runs in the browser via **FFmpeg.wasm**.
- Trim, concat, and transcode clips entirely in-browser
- Uses `libx264` at CRF 30, preset `medium`
- Overlays rendered via `drawtext` with Texturina font (bundled as `public/js/vendor/texturina.ttf`)

### Remote mode
Processing is dispatched to **GitHub Actions** via the Worker API.
- Clips are downloaded from R2, trimmed to lossless MKV intermediates, then concatenated and transcoded
- Uses `libx264` at CRF 30, preset `slow` (higher quality, longer encode time)
- Overlays use the same `drawtext` VF chain, built client-side and sent to the workflow

### Unified pipeline
`public/js/ffmpeg-args.js` is the single source of truth for all FFmpeg arguments — both backends use it to build the video filter chain. The remote path sends the pre-built `-vf` string through the Worker to `edit.yml`, which applies it verbatim.

# Ultrabroken Media

Media assets (screenshots, video clips, social cards) for the [Ultrabroken Archives](https://nan-gogh.github.io/ultrabroken-documentation/) wiki. Deployed to Cloudflare Pages — git history is orphan-reset after each deploy so the repo never accumulates stale blobs.

## Structure

```
screens/   → Screenshots (AVIF, compressed locally before committing)
video/     → Video clips (AV1+Opus WebM, compressed locally before committing)
social/    → Social card PNGs (synced automatically from docs build)
```

## Adding Media

1. **Compress locally** before committing — use [Squoosh](https://squoosh.app/) for images (AVIF) and HandBrake or ffmpeg for video (AV1+Opus WebM).
2. Drop compressed files into `screens/` or `video/`.
3. Commit to `main` — CI deploys to Cloudflare Pages and resets history.
4. The `social/` folder is managed automatically by the docs repo build — don't edit it manually.

## Referencing Media from the Wiki

In the docs repo, use the `media:` prefix:

```markdown
![Nachoyah Shrine VD](media:screens/nachoyah-vd.avif)
```

The build hook expands this to the full Cloudflare Pages URL.

## Serving URL

```
https://ultrabroken-media.pages.dev/
```

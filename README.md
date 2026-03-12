# Ultrabroken Media

Cloudflare Worker + R2 backend for hosting media assets (screenshots, video clips, social cards) for the [Ultrabroken Archives](https://nan-gogh.github.io/ultrabroken-documentation/) wiki.

## Architecture

- **R2 bucket** — stores all media files (screens, video, social cards)
- **Worker** — serves files publicly, hosts a management UI at `/manage`
- **Cloudflare Access** — gates `/manage` with GitHub OAuth (editors log in with their GitHub account)

## File Structure (in R2)

```
image/     → Screenshots (AVIF)
video/     → Video clips (H.264+AAC MP4)
social/    → Social card PNGs
```

## Managing Media

Go to `https://ultrabroken-media.<your-subdomain>.workers.dev/manage` and log in with GitHub. From there you can upload, browse, copy URLs, and delete files.

## Referencing Media from the Wiki

In the docs repo, use the `media:` prefix:

```markdown
![Nachoyah Shrine VD](media:image/nachoyah-vd.avif)
```

The build hook expands this to the full Worker URL.

## Setup

See `SETUP.md` for initial Cloudflare dashboard configuration (R2 bucket, Access policy, secrets).

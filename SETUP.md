# Setup Guide — Ultrabroken Media (R2 + Worker)

Follow these steps in the Cloudflare dashboard before deploying.

---

## 1. Create the R2 Bucket

1. Go to **R2 Object Storage** → **Create bucket**
2. Name: `ultrabroken-media`
3. Location: Auto (or choose one near your audience)
4. Click **Create bucket**

---

## 2. Deploy the Worker (first time)

From your local clone of this repo:

```bash
npx wrangler deploy
```

This creates the Worker and binds it to the R2 bucket. Note the URL it outputs (e.g. `https://ultrabroken-media.<subdomain>.workers.dev`).

---

## 3. Set Up Cloudflare Access (GitHub OAuth)

This protects `/manage` so only authorized editors can upload/delete files.

### 3.1 Add GitHub as an Identity Provider

1. Go to **Zero Trust** → **Settings** → **Authentication** → **Login methods**
2. Click **Add new** → **GitHub**
3. You need a GitHub OAuth App:
   - Go to GitHub → **Settings** → **Developer settings** → **OAuth Apps** → **New OAuth App**
   - Application name: `Ultrabroken Media`
   - Homepage URL: your Worker URL
   - Callback URL: `https://<your-team-name>.cloudflareaccess.com/cdn-cgi/access/callback`
4. Copy the **Client ID** and **Client Secret** back into Cloudflare
5. Save

### 3.2 Create an Access Application

1. Go to **Zero Trust** → **Access** → **Applications** → **Add an application**
2. Type: **Self-hosted**
3. Application name: `Ultrabroken Media Manager`
4. Application domain: `ultrabroken-media.<subdomain>.workers.dev`
5. Path: `/manage`
6. Click **Next**

### 3.3 Add a Policy

1. Policy name: `Wiki Editors`
2. Action: **Allow**
3. Include rule: **Emails** — list the GitHub emails of your editors
4. Save

Now visiting `/manage` will show a "Login with GitHub" screen. Only listed emails get through.

---

## 4. GitHub Actions Secrets

The deploy workflow needs these secrets in the `ultrabroken-media` GitHub repo:

| Secret | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | API token with **Workers** permission (edit) |
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare account ID (visible in dashboard URL) |

You should already have these from the previous Pages setup.

---

## 5. Update the Docs Repo Media URL

If the Worker URL differs from the old Pages URL, update the `media:` hook base URL in the docs repo:

- `docs/hooks/media_links.py` → `_MEDIA_BASE`
- `docs/hooks/social_cards.py` → `_MEDIA_BASE`

---

## 6. Optional: Custom Domain

To serve media from e.g. `media.ultrabroken.wiki`:

1. Go to **Workers & Pages** → `ultrabroken-media` → **Settings** → **Triggers** → **Custom Domains**
2. Add your domain
3. Cloudflare handles SSL automatically

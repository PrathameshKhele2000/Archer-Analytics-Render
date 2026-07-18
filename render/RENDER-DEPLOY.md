# Deploying the Archer Analytics **demo** to Render (free tier)

This packages a **demo** build: 100,000 **synthetic** findings (fake CVEs, made-up hosts,
`@groupinfa.com` emails) — no real company data. The live Archer MS SQL sync stays **off**
(Render can't reach an internal corporate database), so the app runs entirely on the
pre-loaded demo data.

## What's in this folder
- **`demo_db.sql`** — a full database dump: schema + 100,000 findings + the sample
  dashboards, record views, field mappings, and users. Restores to a **~150 MB** database
  (well under Render's 1 GB free Postgres limit). Verified to restore cleanly on Postgres 16, 17 and 18.

## Login after deploy
- **admin@example.com** / **ChangeMe123!**  ← change this immediately after first login.

---

# Option A — One-click Blueprint (recommended)

The repo root has a **`render.yaml`** that provisions everything at once.

1. Push the repo to GitHub.
2. Render Dashboard → **New → Blueprint** → select this repo. Render reads `render.yaml`
   and creates the Postgres, cache, backend, and frontend, auto-wiring `DATABASE_URL`,
   `REDIS_URL`, and generated JWT secrets. Click **Apply**.
3. **Load the demo data** once, from your machine (Postgres → "Connect" → External URL):
   ```bash
   psql "<archer-db EXTERNAL_DATABASE_URL>" -v ON_ERROR_STOP=1 -f render/demo_db.sql
   ```
4. **Check the frontend proxy:** open the `archer-api` service, copy its real URL. If it isn't
   exactly `https://archer-api.onrender.com`, edit `render.yaml`'s `destination` (under
   `archer-web` → `routes`) to that URL, commit, and let the static site redeploy.
5. **Secure it:** log in as admin and change the password (Admin Panel → Users → Edit).

Open the **archer-web** URL — that's your app. Done.

> If you'd rather click through the dashboard manually (or the Blueprint errors on your
> account's Render version), use **Option B** below — same result, step by step.

---

# Option B — Manual setup

## Step 1 — Push the repo to GitHub
Render deploys from a Git repo. Commit and push the project (the dump can stay in the repo
or be uploaded separately — see Step 3).

## Step 2 — Create the database (free)
Render Dashboard → **New → Postgres** → Free plan. Pick **PostgreSQL 16** (or 17/18).
When it's ready, copy both connection strings from the database page:
- **Internal Database URL** — used by the backend service.
- **External Database URL** — used once, from your laptop, to load the data.

## Step 3 — Load the demo data
From your machine (needs `psql` installed), run the dump against the **External** URL:

```bash
psql "<EXTERNAL_DATABASE_URL>" -v ON_ERROR_STOP=1 -f render/demo_db.sql
```

It should finish with no errors. Verify:
```bash
psql "<EXTERNAL_DATABASE_URL>" -c "SELECT count(*) FROM fact_findings;"   # -> 100000
```

## Step 4 — (Optional) Redis cache
Render Dashboard → **New → Key Value** → Free plan. Copy its **Internal** URL for `REDIS_URL`.
The app works without Redis (it's only a cache); skip this if you like.

## Step 5 — Deploy the backend (Docker web service)
Render Dashboard → **New → Web Service** → connect the repo.
- **Runtime:** Docker  •  **Dockerfile path:** `backend/Dockerfile`  •  **Root dir:** `backend`
- **Plan:** Free
- **Environment variables:**

| Key | Value |
|---|---|
| `DATABASE_URL` | the Postgres **Internal** URL from Step 2 |
| `REDIS_URL` | the Key Value **Internal** URL (omit if you skipped Step 4) |
| `JWT_SECRET` | a long random string — generate with `openssl rand -hex 32` |
| `NODE_ENV` | `production` |

> Do **not** set any `MSSQL_*` variables — that keeps the Archer sync disabled, which is
> what we want for the demo. Render sets `PORT` automatically; the backend already reads it.

Note the backend's URL once it's live, e.g. `https://archer-api.onrender.com`.

## Step 6 — Deploy the frontend (Static Site)
Render Dashboard → **New → Static Site** → same repo.
- **Root dir:** `frontend`
- **Build command:** `npm ci && npm run build`
- **Publish directory:** `frontend/dist`
- **Rewrite rule** (Settings → Redirects/Rewrites): this makes the app's `/api` calls reach
  the backend on the same origin (so auth cookies work):

  | Source | Destination | Action |
  |---|---|---|
  | `/api/*` | `https://archer-api.onrender.com/api/:splat` | **Rewrite** |

Open the Static Site URL — that's your app.

## Step 7 — Secure it (do this first thing)
1. Log in as **admin@example.com / ChangeMe123!**, go to **Admin Panel → Users → Edit**, and
   set a new admin password.
2. Confirm `JWT_SECRET` is your own random value (Step 5), not a default.

---

## Free-tier notes
- **Web services sleep after ~15 min idle** → the first request wakes them (~30–50 s). Normal for free.
- **Free Postgres expires ~30 days** after creation (Render emails a warning). Fine for a demo;
  re-create + reload `demo_db.sql` if you need longer.
- Everything stays comfortably inside 1 GB (DB ≈ 150 MB).

## Want a smaller/larger dataset?
The dump is 100k rows. Ask and I can regenerate the dump at any size (e.g. 50k for even more
headroom, or 250k if you upgrade the DB) — the row generator is in
`scratchpad/gen_findings.sql`.

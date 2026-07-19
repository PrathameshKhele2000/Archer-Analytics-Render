# Configuration — the one place to understand every setting

This document is the **single source of truth** for how Archer Analytics is
configured: what every variable does, which file it lives in, and how to set it
locally and on **Azure**.

---

## 1. Which file is which (this used to be confusing — here's the map)

| File | Committed to git? | What it's for |
|---|---|---|
| **`.env.example`** | ✅ yes (template, no secrets) | The **complete, documented list** of every backend variable. Copy it to make a real `.env`. |
| **`.env`** | ❌ no (git-ignored) | Your **real backend values for local Docker**. |
| **`backend/.env`** | ❌ no (git-ignored) | Your **real backend values for running the backend natively** (`npm run start:dev`). Same values as `.env`, just `localhost` instead of `host.docker.internal`. |
| **`frontend/.env.example`** | ✅ yes (template) | The frontend's only setting (`VITE_API_BASE`). |
| **`frontend/.env`** | ❌ no (git-ignored) | Your real frontend value, if you build the frontend separately from the backend. |

> On **Azure you use NO `.env` files** — you set these same variables as
> **Application settings / environment variables** in the Azure portal.

The backend reads config in **`backend/src/config/configuration.ts`** — that file
is the code-level source of truth, and `.env.example` mirrors it exactly.

---

## 2. Every backend variable (complete reference)

| Variable | Required | What it does | Example |
|---|---|---|---|
| `DATABASE_URL` | **Yes** | PostgreSQL connection string (the app's own database). | `postgresql://user:pass@host:5432/db?sslmode=require` |
| `DB_POOL_MAX` | No | Max DB connections in the pool (default 20). | `20` |
| `REDIS_URL` | No | Redis cache. App works without it (degrades gracefully). | `redis://cache:6379/0` |
| `CACHE_TTL_SECONDS` | No | How long cached queries live. | `900` |
| `JWT_SECRET` | **Yes** | Signs login (access) tokens. Random 64-char string. | `openssl rand -hex 32` |
| `JWT_REFRESH_SECRET` | **Yes** | Signs refresh tokens. **Different** random string. | `openssl rand -hex 32` |
| `JWT_ACCESS_TTL` / `JWT_REFRESH_TTL` | No | Token lifetimes. | `15m` / `7d` |
| `PORT` | No | Port the API listens on. Azure sets this automatically. | `8000` |
| `FRONTEND_URL` | No | Public URL of the frontend (SSO redirects). | `https://analytics.company.com` |
| `OIDC_ISSUER` … | No | Single sign-on (leave `OIDC_ISSUER` blank to keep SSO off). | Entra/Google/Okta issuer URL |
| `MSSQL_HOST` … | No | The read-only Archer MS SQL feed. **Leave `MSSQL_HOST` blank to keep the live sync OFF.** | `sql.company.local` |
| `SYNC_INTERVAL_MINUTES` | No | How often the sync runs. `1440` = daily. | `15` |
| `MODULE_ALIAS` | No | Archer application/level alias to sync. | `Findings` |

**The frontend has exactly one variable:**

| Variable | When to set | What it does |
|---|---|---|
| `VITE_API_BASE` | Only when frontend & backend are on **different hosts** | Absolute backend URL, baked in at build time. Leave empty when they share an origin (nginx/vite proxy). |

---

## 3. Local run (Docker) — nothing to think about

```bash
cp .env.example .env        # then fill in DATABASE_URL + JWT secrets
docker compose up -d --build
```
`docker-compose.yml` passes `.env` to the backend and provides Postgres + Redis.
The frontend is served by nginx which proxies `/api` to the backend, so
`VITE_API_BASE` stays empty locally.

---

## 4. Deploying to Azure

You need four things. Everything is configured with the **variables in section 2** —
set on each Azure service as **Application settings** (no files).

### a) Database — Azure Database for PostgreSQL (Flexible Server)
1. Create a **PostgreSQL Flexible Server** + a database (e.g. `archer_analytics`).
2. Build the connection string and **append `?sslmode=require`** (Azure requires SSL):
   ```
   postgresql://<user>:<url-encoded-password>@<server>.postgres.database.azure.com:5432/archer_analytics?sslmode=require
   ```
3. Load the schema + data **once** from your machine:
   ```bash
   psql "<that connection string>" -f render/demo_db.sql     # demo (100k rows)
   # — or, for a clean empty system to sync real Archer into —
   psql "<that connection string>" -f db/install.sql
   ```

### b) Cache — Azure Cache for Redis (optional)
Create a Basic instance; use its connection string as `REDIS_URL`. Skip it if you
prefer — the app runs without a cache.

### c) Backend — Azure App Service (or Container Apps), Docker
- Deploy the image built from **`backend/Dockerfile`**.
- Under **Configuration → Application settings**, add every backend variable from
  section 2: `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `JWT_REFRESH_SECRET`,
  `NODE_ENV=production`, and (only when connecting real Archer) the `MSSQL_*` set.
- Azure injects `PORT` and terminates HTTPS for you. Note the backend URL,
  e.g. `https://archer-api.azurewebsites.net`.

### d) Frontend — Azure Static Web Apps (or App Service serving `frontend/dist`)
- Build command `npm ci && npm run build`, output `frontend/dist`.
- Set **`VITE_API_BASE`** to the backend URL from step (c) **before building**
  (it's baked in at build time — rebuild if you change it).
- The backend already allows CORS and auth uses Bearer tokens (no cookies), so the
  cross-origin call from the static site to the API works.

---

## 5. Security checklist (do before going live)
- [ ] `DATABASE_URL` points at **your** Azure Postgres, with `?sslmode=require`.
- [ ] `JWT_SECRET` and `JWT_REFRESH_SECRET` are fresh random values (not the examples).
- [ ] Change the seeded admin password (`admin@example.com` / `ChangeMe123!`) on first login.
- [ ] `MSSQL_*` uses a **read-only** (`db_datareader`) account — and only when you're
      ready to connect real Archer (otherwise leave `MSSQL_HOST` blank).
- [ ] Never commit a real `.env`. (A previously committed example with a live
      Render DB credential was removed — if that Render database still exists,
      rotate its password or delete it.)

# Archer Analytics — Go‑Live Runbook

A reporting layer that copies data **out of Archer’s flat reporting feed (MS SQL, read‑only)** into its own PostgreSQL and serves fast dashboards + reports.

```
 Archer  →  [flat reporting feed, MS SQL]  ──read-only, scheduled──►  PostgreSQL  ─►  Dashboards / Reports
            (maintained by your IT)              (this app copies it)                 (users, via SSO)
```

**Golden rules:** read‑only at the Archer side · one‑way copy · start on **DEV**, never PROD first · real company data lives on a **company server**, never a laptop.

---

## 1. Request first (hand this list to the right teams)

| # | Item | Team | Notes |
|---|------|------|-------|
| 1 | Read‑only account (`db_datareader`) on the **reporting** database | DBA | **DEV first.** Ideally on a replica, not live PROD. |
| 2 | Reporting **server/host + database name** | DBA | e.g. `sqlrep-dev`, `ArcherReporting` |
| 3 | The flat feed **table name(s)** for findings (and later Devices, Exceptions…) | Archer admin | e.g. `dbo.ArcherFindingsFeed`; confirm the **record‑id** and **last‑updated** columns |
| 4 | Multi‑value delimiter used in the feed | Archer admin | usually `;` |
| 5 | A **Linux VM** in the same network as Archer | Infra | 4–8 vCPU, 16–32 GB RAM, 200 GB+ SSD, Docker installed |
| 6 | **HTTPS cert + DNS** name | Infra | e.g. `analytics-dev.yourco.com` |
| 7 | **SSO** app registration (same IdP as Archer) + redirect URI | Identity | optional; password login works without it |
| 8 | Approval to copy Archer data to the reporting DB | Security | sign‑off before real data moves |

Nothing real moves until #1, #2, #3 and #8 exist.

---

## 2. Deploy — pick ONE of the two ways

Docker is **not required**. Both ways run the same app and end at the same place. You need, either way: **Node.js 20+**, **PostgreSQL 14+**, **Redis 7** (Redis can be Memurai on Windows, or a managed cache).

### Option A — Docker (simplest)

```bash
# 1. Get the code onto the VM, then:
cp .env.production.example .env
#    edit .env — see section 3 (secrets + DB + MSSQL)

# 2. Set a strong Postgres password in docker-compose.yml (POSTGRES_PASSWORD)
#    and make DATABASE_URL in .env match it.

# 3. Bring it up. The db container runs db/install.sql automatically on first
#    boot → an EMPTY, fully-structured system (no sample data).
docker compose up -d --build

# 4. Confirm the installer ran and the app is healthy
docker compose logs db | grep "Install complete"
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/health   # -> 200
```

Demo data (optional): `docker compose exec -T db psql -U archer -d archer_analytics -f /opt/archer-db/seed_findings_sample.sql`

### Option B — Native (no Docker: Linux systemd or Windows/IIS)

Install Node.js 20+, PostgreSQL 14+ and Redis (or Memurai) first, then:

```bash
# 1. Database — create it and run the installer ONCE (this is what Docker did for you)
createdb archer_analytics
psql "postgresql://USER:PASS@localhost:5432/archer_analytics" -f db/install.sql
# demo data (optional):  psql "...archer_analytics" -f db/seed_findings_sample.sql

# 2. Backend (NestJS) — build, then run under a process manager
cd backend
npm ci && npm run build
#   provide env vars (DATABASE_URL, REDIS_URL, JWT_*, MSSQL_*, SYNC_INTERVAL_MINUTES …)
#   from a .env or the service definition, then start dist/main.js:
node dist/main.js            # health: curl http://localhost:8000/api/health

# 3. Frontend (React) — build static files and serve them
cd ../frontend
npm ci && npm run build      # outputs frontend/dist/
#   serve dist/ with nginx / IIS and proxy /api → the backend (port 8000)
```

**Keep the backend running:**
- **Linux (systemd)** — create `/etc/systemd/system/archer-analytics.service`:
  ```ini
  [Service]
  WorkingDirectory=/opt/archer-analytics/backend
  EnvironmentFile=/opt/archer-analytics/backend/.env
  ExecStart=/usr/bin/node dist/main.js
  Restart=always
  User=archer
  [Install]
  WantedBy=multi-user.target
  ```
  `sudo systemctl enable --now archer-analytics`
- **Windows** — run `node dist/main.js` as a Windows Service (e.g. NSSM or `node-windows`), with the env vars set on the service. Serve `frontend/dist/` from **IIS** (the same server role Archer already uses) with a URL-rewrite/ARR rule sending `/api/*` to `http://localhost:8000`.

**nginx reverse-proxy snippet** (Linux) — serves the UI and forwards the API:
```nginx
server {
  listen 443 ssl;   # your cert here
  server_name analytics.yourco.com;
  root /opt/archer-analytics/frontend/dist;
  location /api/ { proxy_pass http://127.0.0.1:8000; }
  location /    { try_files $uri /index.html; }   # SPA fallback
}
```

The automatic sync, dataset registry, dashboards and reports all work identically — Docker only changes *how the three processes are started*, nothing about the app.

---

## 3. Secrets & hardening (do once, before real data)

In `.env` (see `.env.production.example`) — **generate fresh values, reuse nothing from dev/chat**:

```bash
openssl rand -hex 32   # -> JWT_SECRET
openssl rand -hex 32   # -> JWT_REFRESH_SECRET (must differ)
```

- `DATABASE_URL` → your Postgres, strong password.
- `MSSQL_*` → the read‑only account from step 1 (`MSSQL_ENCRYPT=true`, `MSSQL_TRUST_CERT=false` in prod).
- **Change the default admin.** Log in as `admin@example.com` / `ChangeMe123!`, create your own admin, then deactivate the default.
- Put the app behind the HTTPS reverse proxy; set `FRONTEND_URL` to the public URL.

---

## 4. Connect to Archer (in the app, no code)

1. **Admin → Data Sources** → open the *Vulnerability Findings* dataset → set its **Source table** to your real feed (e.g. `dbo.ArcherFindingsFeed`), and confirm the **record‑id** and **last‑updated** columns.
2. **Admin → Field Mapping** → click **⚡ Auto‑map** → fix any red/unmapped fields (one‑click suggestions) → **Save**.
3. **Admin → Sync** → the pull runs **automatically** on the schedule; click **Run** for an immediate first load.
4. Watch the first run complete; check row counts.

**Add another Archer application later** (Devices, Exceptions): Admin → Data Sources → **+ Add dataset** → point at its feed table → discover columns → Auto‑map → done. No redeploy.

---

## 5. Verify (the acceptance check)

- [ ] Sync shows **status ok** and a sensible **row count** for findings.
- [ ] Spot‑check 5–10 records in **Records** against Archer — values match.
- [ ] Total/Open/Closed counts on the **Overview** dashboard look right.
- [ ] A user with only the **viewer** role sees dashboards/reports but no Admin panel.
- [ ] SSO login works (if configured).

---

## 6. Promote: DEV → UAT → PROD

The **same build** runs in every environment — only `.env` changes. Because Archer field IDs/tables differ per environment, you re‑point + re‑map per environment (no code):

1. New `.env` with that environment’s `MSSQL_*` (read‑only) and secrets.
2. `docker compose up -d` → empty system builds itself.
3. Data Sources → point at that environment’s feed table.
4. Field Mapping → Auto‑map → Save.
5. Run section 5’s verify checklist.
6. Only after UAT passes, repeat for **PROD**.

---

## Safety / rollback

- The Archer‑side account is **read‑only** — the app cannot modify Archer.
- Sync is **idempotent** (upsert on record id) — re‑running never duplicates; a failed run leaves existing data intact.
- Datasets are **independent** — one pipe failing can’t affect the others.
- **Back up** the Postgres volume before upgrades (`pg_dump`). To rebuild from scratch: drop the db volume and `docker compose up` — the installer re‑creates an empty system, and the next sync re‑loads from Archer.

---

## One‑line status

**The application is feature‑complete and installs cleanly from empty.** Everything left is provisioning (steps 1–3) and DEV→UAT→PROD validation (steps 4–6) — which need the real Archer connection, not more code.

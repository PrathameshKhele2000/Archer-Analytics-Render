# Running without Docker (plain PostgreSQL)

Docker is **optional**. The app connects to any PostgreSQL through the standard
`DATABASE_URL` connection string, and Redis is fully optional (the cache degrades
gracefully to direct queries if it's absent). This guide runs the whole stack
against a normal Postgres — no containers.

You can also mix approaches (see [Hybrid](#hybrid-docker-db--local-app) below):
e.g. run the database in Docker but the backend/frontend locally, or vice-versa.

---

## Prerequisites

- **Node.js 20+** and npm
- **PostgreSQL 16** — local install, or a managed instance (AWS RDS, Azure
  Database, Google Cloud SQL, or your company's server)
- *(optional)* **Redis 7** — only for cache acceleration

Install locally on macOS:
```bash
brew install node postgresql@16
brew services start postgresql@16
# optional:
brew install redis && brew services start redis
```

---

## 1. Create the database and apply the schema

The quickest path is the helper script (idempotent — safe to re-run):

```bash
./scripts/setup-local.sh
```

It creates the `archer_analytics` database (if missing) and applies
`db/init.sql` (tables, partitions, materialized views, RBAC seed data, the
default admin user, and the seeded dashboard).

<details>
<summary>Or do it by hand</summary>

```bash
createdb archer_analytics                      # or: psql -c "CREATE DATABASE archer_analytics;"
psql "postgresql://USER:PASSWORD@HOST:5432/archer_analytics" -f db/init.sql
```
</details>

Configure connection details via standard PG env vars if your Postgres isn't the
local default:

```bash
export PGHOST=localhost PGPORT=5432 PGUSER=postgres PGPASSWORD=secret
./scripts/setup-local.sh
```

---

## 2. Run the backend (NestJS API on :8000)

```bash
cd backend
npm install

DATABASE_URL="postgresql://USER:PASSWORD@HOST:5432/archer_analytics" \
MOCK_MODE=true \
JWT_SECRET="change-me-to-something-long" \
JWT_REFRESH_SECRET="change-me-to-something-else-long" \
npm run start:dev
```

- **No `REDIS_URL`?** Fine — the API runs without a cache. To use Redis, add
  `REDIS_URL="redis://localhost:6379/0"`.
- On first boot with an empty warehouse it auto-loads 50,000 demo findings
  (`MOCK_MODE=true`). To connect real Archer instead, set `MOCK_MODE=false` and
  the `ARCHER_*` / `MODULE_ALIAS` vars (see the main README).
- Full env reference: [`.env.example`](../.env.example).

---

## 3. Run the frontend (Vite dev server on :5173)

```bash
cd frontend
npm install
npm run dev
```

Open **http://localhost:5173**. The dev server proxies `/api` → `http://localhost:8000`
(see `frontend/vite.config.ts`), so no extra config is needed. Sign in with the
seeded admin: `admin@example.com` / `ChangeMe123!`.

For a production build instead of the dev server:
```bash
cd frontend && npm run build      # static files in frontend/dist/, serve behind any web server
```

---

## Inspecting the data (no Docker)

```bash
# count
psql "postgresql://USER:PASSWORD@HOST:5432/archer_analytics" -c "SELECT count(*) FROM fact_findings;"

# interactive shell
psql "postgresql://USER:PASSWORD@HOST:5432/archer_analytics"
#   \dt            list tables
#   \d fact_findings   describe a table
#   \q             quit
```

Or point any GUI (DBeaver, TablePlus, pgAdmin) at host / 5432 / `archer_analytics`
/ your user / password.

---

## Hybrid: Docker DB + local app

Handy when you want a throwaway Postgres but iterate on the code locally.

```bash
# 1. Start ONLY the database (and optionally redis) in Docker
docker compose up -d db          # add 'cache' too if you want Redis

# 2. Point the local backend at it (Docker maps Postgres to localhost:5432)
cd backend && npm install
DATABASE_URL="postgresql://archer:archer@localhost:5432/archer_analytics" \
JWT_SECRET=dev JWT_REFRESH_SECRET=dev npm run start:dev

# 3. Local frontend
cd frontend && npm install && npm run dev
```

The reverse also works: run the app in Docker but point `DATABASE_URL` (in
`.env`) at an external managed Postgres, and remove the `db` service from
`docker-compose.yml`.

---

## Summary

| Piece | Docker | Without Docker |
|---|---|---|
| PostgreSQL | `db` service | local install or managed cloud DB |
| Redis (optional) | `cache` service | local install, or omit entirely |
| Backend API | `backend` service | `npm run start:dev` in `backend/` |
| Frontend | `frontend` service | `npm run dev` in `frontend/` |

The only thing the app truly requires is a reachable PostgreSQL via
`DATABASE_URL`. Everything else is a convenience.

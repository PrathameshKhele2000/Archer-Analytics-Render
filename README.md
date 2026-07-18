# Archer Analytics Platform

An enterprise reporting platform that syncs data out of RSA Archer into
PostgreSQL and serves sub-second, role-gated dashboards — built to replace slow
native Archer dashboards over multi-million-record applications.

**Stack:** React 18 + TypeScript + ECharts · NestJS (Node 20, TypeScript, JWT +
RBAC) · PostgreSQL 16 (star schema, partitioned facts, materialized views) ·
Redis · Docker Compose.

## Quickstart (demo mode, no Archer needed)

```bash
cp .env.example .env        # already done if you cloned this as-is
docker compose up --build
```

Then open **http://localhost:3000** and sign in with the seeded administrator:

```
email:    admin@example.com
password: ChangeMe123!
```

**Rotate this password immediately** (there's no self-service reset UI yet —
use `POST /api/admin/users/:id` or update `password_hash` directly). On first
boot the backend detects an empty warehouse and runs a full load of 50,000
generated findings (a few seconds per 10k), refreshes the materialized views,
and the dashboard lights up. Incremental sync then runs every 15 minutes; use
the sync tab under **Admin** to trigger one manually or watch run history.

To simulate scale, set `MOCK_RECORD_COUNT=5000000` in `.env` and restart —
the architecture (batched upserts, matviews, Redis) is what you'd run in production.

## Single Sign-On (OIDC)

SSO is a **generic OpenID Connect** integration — the same code works with
Google, Microsoft Entra/Azure AD, Okta, Keycloak, Auth0, etc. Enable it by
setting three env vars in `.env`:

```bash
OIDC_ISSUER=https://accounts.google.com          # or your Entra/Okta/Keycloak issuer
OIDC_CLIENT_ID=<from your IdP app registration>
OIDC_CLIENT_SECRET=<from your IdP app registration>
# redirect URI to register in the IdP: http://localhost:8000/api/auth/sso/callback
```

Leave `OIDC_ISSUER` blank to keep SSO off (password login still works — the
login screen only shows the "Sign in with SSO" button when it's configured).
Flow: Authorization Code + PKCE, state/nonce held in Redis for the round trip.
On first SSO login a user is **auto-provisioned** with the `OIDC_DEFAULT_ROLE`
(default `viewer`); an admin can then grant more roles. Password login and SSO
coexist, so the seeded local admin remains available for break-glass access.

## RBAC

Users, roles, and permissions are fully dynamic (stored in Postgres, editable
via `/api/admin/*`, no code changes needed). Four seeded roles' permissions:

| Role | Permissions |
|---|---|
| `admin` | everything, including user/role/dashboard/report management |
| `analyst` | view/build dashboards, view/export reports, trigger sync, read audit log |
| `viewer` | view + build dashboards, view reports |

All roles get `dashboard:create` so any user can build their own dashboards
(see below).

## Self-service dashboards + chart designer

Any signed-in user can build their **own** dashboards, each holding **multiple
charts** designed with an Archer-style chart builder. Flow: **Dashboards →
+ New dashboard** (name it) → you land inside the empty dashboard → **+ Add
chart** opens the designer:

- **Chart type** — column, bar, line, area, pie, donut, single number, or table
- **X axis** — pick the field/dimension (severity, status, business unit,
  category, owner, open/closed, created month/year, due month)
- **Y axis** — pick the value/aggregation (count, open count, overdue count,
  total risk, average risk, avg days to close)
- **Split by** — an optional second dimension for grouped/stacked/multi-series
- **Filters** — severity/status/BU/category/open-only
- **Show legend** and **row limit** (max groups returned, clamped 1–1000)
- **Drill-down path** — an ordered list of dimensions to descend into
  (e.g. Business unit → Category → Owner)
- An auto **caption** ("what compared to what", e.g. *Number of findings by
  Business unit, split by Status*) shown under the chart title
- **Live preview** updates as you choose

**Drill-down at view time:** any chart with a drill path shows a **🔍 Drill
toggle**. Turn it on and click a bar/slice — the chart filters to that value and
re-groups by the next level, with a breadcrumb to jump back, all the way to the
last level. Drilling only needs `dashboard:read`, so viewers of a shared
dashboard can explore too. The clicked path is validated server-side against the
chart's own stored drill sequence and every value is parameterized, so a viewer
can descend the predefined levels but cannot inject dimensions or SQL.

Charts are driven by a **safe aggregation engine**: the client only ever sends
catalog *keys*, and the backend composes a parameterized `GROUP BY` from
whitelisted SQL fragments (`backend/src/dashboard/query-builder.ts`) — Archer-flexible
but injection-proof (unknown keys → HTTP 400). New dashboards are **private to
the creator**; the owner can **share** to roles/users
(`POST /api/dashboards/:key/share`), **edit/remove** individual charts, or
**delete** the dashboard. Admins can also manage system/shared dashboards via
`/api/admin/dashboards`. To add a new field or measure to the palette, extend
the `DIMENSIONS` / `MEASURES` catalogs in `query-builder.ts`.

Dashboards and reports each have their own access-grant tables
(`dashboard_access`, `report_access`) keyed by role **or** individual user, so
an admin can expose a given dashboard/report to just one person without a new
role. Every dashboard widget and report column/filter is itself a DB row
(`dashboards`, `dashboard_widgets`, `reports`, `report_columns`,
`report_filters`) editable via `/api/admin/dashboards` and `/api/admin/reports` —
titles, ordering, and visibility change without a deploy. The underlying SQL
per widget/report is a fixed, vetted registry (not admin-authored raw SQL) to
keep the query surface injection-safe.

## Connecting your real Archer instance

1. Create a read-only Archer service account with API access to the target application.
2. In `.env`, set `MOCK_MODE=false` and fill in `ARCHER_BASE_URL`, `ARCHER_INSTANCE`,
   `ARCHER_USERNAME`, `ARCHER_PASSWORD` (and `ARCHER_USER_DOMAIN` if you use one).
3. Find your application's **level alias**: Archer → Application Builder → your
   application → Levels → Alias. Set it as `MODULE_ALIAS`.
4. Edit `backend/mapping.yaml` so the right-hand values match **your field
   aliases** as exposed by ContentAPI (browse `https://<archer>/contentapi/<LevelAlias>?$top=1`
   while logged in to see the exact field names). Also list your open statuses
   and severity names there.
5. `docker compose up --build -d` — the first run performs the full historical
   load via paged ContentAPI calls; subsequent runs are incremental using the
   `Last_Updated_Date` watermark (automatic re-login on session expiry included).

The integration uses only official, supported Archer surfaces:
`POST /api/core/security/login` for session tokens and the OData `contentapi`
endpoints for retrieval — no direct SQL Server access required.

## Why it's fast

- **Star schema** (`fact_findings` + small dimensions) instead of Archer's
  generic content storage; facts partitioned by created year with B-tree,
  BRIN, and trigram indexes.
- **One materialized view per dashboard widget**, refreshed after each sync
  with `REFRESH ... CONCURRENTLY` — dashboards read hundreds of rows, never millions.
- **Redis caching** of widget responses with a TTL matching the sync interval
  (cache-aside; a Redis outage degrades gracefully to direct queries).
- **Server-side pagination + keyset-paginated streaming CSV export** — the
  browser never receives more than one page of raw records, and exports use
  constant memory at any size.
- **Advanced filter builder** — a dynamic field/operator/value condition builder
  (`backend/src/reports/filterable-fields.ts`): each field has a type (text, number,
  date, datetime, enum, boolean) that drives the available operators (contains /
  equals / between / is any of / before / is empty / …) and the value input type.
  Conditions are **numbered (1, 2, 3…)** and combined with a **manual logic
  expression** you type yourself — e.g. `1 AND 2 OR 3` or `(1 OR 2) AND NOT 3`
  (AND/OR/NOT + parentheses; blank = AND all). The **same engine powers both the
  report register (and its exports) and the chart builder's filters**. The logic is
  parsed by a small recursive-descent parser (NOT > AND > OR precedence) that
  validates grammar and condition references; only whitelisted field keys map to SQL
  and every value is parameterized, so it's injection-proof (unknown field/operator,
  out-of-range or malformed logic → HTTP 400).

## API surface

All routes below require `Authorization: Bearer <accessToken>` except
`/api/health`, `/api/auth/login`, `/api/auth/refresh` — the JWT guard is global
(`backend/src/auth/guards/jwt-auth.guard.ts`), and a second guard enforces the
per-route `@Permissions(...)` requirement.

| Endpoint | Purpose | Permission |
|---|---|---|
| `POST /api/auth/login` · `/refresh` · `GET /me` | Auth | — |
| `GET /api/auth/sso/config` · `/login` · `/callback` | OIDC SSO (config probe, redirect, callback) | — |
| `GET /api/dashboards` · `GET /api/dashboards/:key` | Dashboard list / widgets + data | `dashboard:read` |
| `GET /api/dashboards/schema` · `POST /api/dashboards/query-preview` | Chart-builder catalog + live preview | `dashboard:create` |
| `POST/PATCH/DELETE /api/dashboards[/:key]` · `POST /:key/share` · `POST/PATCH/DELETE /:key/charts[/:id]` | Build/manage your own dashboards & charts | `dashboard:create` |
| `GET /api/reports` · `/:key/config` · `/:key/filters` · `/:key/data` | Report list / config / paginated data | `report:read` |
| `GET /api/reports/:key/export/{csv,excel,pdf}` | Streaming exports | `report:read`, `report:export` |
| `GET /api/sync/status` · `/history` · `POST /run` | ETL status, run history, manual trigger | `sync:read` / `sync:run` |
| `GET /api/audit` | Audit log search | `audit:read` |
| `/api/admin/users`, `/api/admin/roles` | User & role/permission management | `admin:users:manage` / `admin:roles:manage` |
| `/api/admin/dashboards`, `/api/admin/reports` | Dashboard/report/widget/column/filter/access CRUD | `admin:dashboards:manage` / `admin:reports:manage` |

## Project map

```
db/init.sql                    schema, partitions, indexes, matviews, refresh function, RBAC + config seed
backend/mapping.yaml           YOUR instance's field aliases -> platform columns
backend/src/archer/            real ContentAPI client + deterministic mock (MOCK_MODE switch)
backend/src/etl/               sync service (full/incremental, watermark, retry+backoff)
backend/src/auth/              JWT strategy, login/refresh/me, guards
backend/src/users|roles/       RBAC: users, roles, permissions (repository + service + admin API)
backend/src/audit/             audit interceptor (all mutations + exports/logins) + query API
backend/src/dashboard/         DB-backed dashboard/widget config, access-gated data endpoint
backend/src/reports/           DB-backed report/column/filter config, paginated data, CSV/Excel/PDF export
backend/src/sync/              health, sync status + history, manual trigger
backend/src/database|cache/    pg pool (unit-of-work transaction helper) + Redis cache-aside service
backend/src/common/            base repository, permission/public decorators
frontend/src/                  React app: login, RBAC-aware nav, generic dashboard/report renderers, admin panel
```

## Known gaps / next steps

- **Dashboards** have a self-service chart designer UI (create/edit/delete/share
  your own, multiple charts each, per-chart X/Y/series/filter selection).
  **Report** column/filter definitions are still managed via the
  `/api/admin/reports` API rather than a dedicated UI — the backend fully supports it.
- The chart designer builds on a curated field/measure catalog (safe by design).
  Fully free-form user-authored SQL is intentionally not exposed; new fields,
  measures, or chart types are added in `backend/src/dashboard/query-builder.ts`.
- No password-reset flow yet; rotate the seeded admin password via the API.
- Single Archer module (`Findings`) is wired end-to-end; adding a second module
  means extending `mapping.yaml` and registering its data sources.

## Local development without Docker

Docker is optional — the app connects to any PostgreSQL via `DATABASE_URL`, and
Redis is fully optional (the cache degrades gracefully if absent). Quick start:

```bash
# 1. create the DB and apply the schema against your local/managed Postgres
./scripts/setup-local.sh          # idempotent; honors PGHOST/PGPORT/PGUSER/PGPASSWORD

# 2. backend
cd backend && npm install
DATABASE_URL=postgresql://archer:archer@localhost:5432/archer_analytics \
MOCK_MODE=true JWT_SECRET=change-me JWT_REFRESH_SECRET=change-me-too npm run start:dev
# (add REDIS_URL=redis://localhost:6379/0 only if you want caching)

# 3. frontend (dev server on :5173, proxies /api to :8000)
cd frontend && npm install && npm run dev
```

Full walkthrough — including managed cloud Postgres and a **hybrid** setup
(Docker DB + local app, or Docker app + external DB) — is in
[docs/RUN_WITHOUT_DOCKER.md](docs/RUN_WITHOUT_DOCKER.md).

## Scaling past this

Benchmarked at **10M rows**: the standard (matview) dashboard serves in ~20ms, the
register in ~0.4s cold / ~15ms cached. **User-built charts each get their own
materialized view** (`mv_chart_<id>`, built on save, refreshed after every sync,
dropped on delete) so a heavy cold group-by that took ~2.9s live now reads in
**~18ms** — independent of row count. Reads fall back to live aggregation if a
matview is ever missing, so it self-heals.

For **thousands of concurrent users**, run multiple stateless backend replicas
behind a load balancer with **PgBouncer** in front of Postgres (JWT auth + shared
Redis make this a deployment change, not a code change).

If you later reach 100M+ rows or need ad-hoc slicing across many wide-table
dimensions, add ClickHouse as an analytics sidecar fed by the same ETL, keep
Postgres as the serving layer for the register, and nothing above the API changes.

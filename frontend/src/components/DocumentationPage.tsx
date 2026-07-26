/**
 * Full client-facing technical documentation, reachable from the Architecture page.
 * Pure presentational — no data fetching. Content reflects the ACTUAL codebase
 * (schema, routes, config) as of this build, not aspirational/marketing copy.
 */

const TOC = [
  { id: "exec", label: "1. Executive Summary & Architecture" },
  { id: "setup", label: "2. Technical Setup & Deployment" },
  { id: "data", label: "3. Data & Interaction Models" },
  { id: "security", label: "4. Security, Privacy & Compliance" },
  { id: "ops", label: "5. Operations, Maintenance & Backups" },
  { id: "roadmap", label: "6. Roadmap & Scalability" },
];

const STACK = [
  ["Backend", "NestJS 10 (Node 20, TypeScript)", "Dependency injection and first-class guards/interceptors give clean, centrally-enforced auth and audit logging on every route without repeating checks in each handler."],
  ["Frontend", "React 18 + TypeScript + ECharts", "Component model suits a data-dense admin/analytics UI; ECharts renders to canvas, so charts with hundreds or thousands of categories stay smooth without bloating the DOM the way SVG-per-bar libraries would."],
  ["Database", "PostgreSQL 16", "JSONB stores Archer's multi-value fields (owners, cross-references) natively; GIN trigram indexes give instant substring search over millions of rows; materialized views pre-aggregate chart data so dashboards don't scan raw tables."],
  ["Cache", "Redis 7", "Cache-aside layer for hot dashboard/report queries. Fully optional — the app runs correctly without it, just slower, so a cache outage never takes the platform down."],
  ["Auth", "JWT (access + refresh) + optional OIDC SSO", "Stateless tokens mean any number of backend replicas can validate a request without a shared session store, which is what makes horizontal scaling a deployment change rather than a code change."],
  ["Containers", "Docker Compose", "One `docker compose up` brings up Postgres, Redis, backend and frontend identically on a laptop, a DEV server, or in Azure Container Apps."],
];

const ENV_VARS: [string, string, string][] = [
  ["DATABASE_URL", "Yes", "PostgreSQL connection string. Azure requires `?sslmode=require` appended."],
  ["DB_POOL_MAX", "No", "Max pooled DB connections (default 20)."],
  ["REDIS_URL", "No", "Redis connection string. Omit to run without a cache (graceful degradation)."],
  ["CACHE_TTL_SECONDS", "No", "How long cached query results live (default 900s)."],
  ["JWT_SECRET", "Yes", "Signs access tokens. Generate with `openssl rand -hex 32`."],
  ["JWT_REFRESH_SECRET", "Yes", "Signs refresh tokens. Must be a different random value from JWT_SECRET."],
  ["JWT_ACCESS_TTL / JWT_REFRESH_TTL", "No", "Token lifetimes (default 15m / 7d)."],
  ["PORT", "No", "API listen port (default 8000; Azure sets this automatically)."],
  ["FRONTEND_URL", "No", "Public frontend URL, used to build SSO redirect links."],
  ["OIDC_ISSUER / OIDC_CLIENT_ID / OIDC_CLIENT_SECRET", "No", "Enables SSO. Leave OIDC_ISSUER blank to keep SSO off — password login always still works."],
  ["OIDC_REDIRECT_URI / OIDC_SCOPES / OIDC_DEFAULT_ROLE", "No", "SSO callback URL, requested scopes, and the role auto-assigned to a first-time SSO user."],
  ["MSSQL_HOST / MSSQL_PORT / MSSQL_DATABASE", "No", "The read-only Archer reporting feed. Leave MSSQL_HOST blank to keep live sync off (demo mode)."],
  ["MSSQL_USER / MSSQL_PASSWORD", "No", "Credentials for a read-only (db_datareader) Archer service account."],
  ["MSSQL_ENCRYPT / MSSQL_TRUST_CERT", "No", "TLS options for the MSSQL connection. Use encrypt=true, trust_cert=false in production."],
  ["SYNC_INTERVAL_MINUTES", "No", "How often incremental sync runs (default 1440 = daily; 15 = every 15 min)."],
  ["SYNC_MAX_RETRIES / SYNC_RETRY_BASE_MS", "No", "Retry/backoff tuning for a failed sync run."],
  ["MODULE_ALIAS", "No", "The Archer application/level alias this deployment syncs."],
  ["VITE_API_BASE (frontend only)", "No", "Absolute backend URL — set only when frontend and backend are on different hosts; baked in at build time."],
];

const SCHEMA_GROUPS: { title: string; blurb: string; tables: [string, string][] }[] = [
  {
    title: "Auth & RBAC",
    blurb: "Users don't hold permissions directly — permissions belong to roles, roles are granted to groups, and users belong to groups. A user's effective permissions are the union of every role held by every group they're in (plus any role assigned directly, kept for compatibility).",
    tables: [
      ["users", "Platform accounts — email, bcrypt password hash (nullable for SSO-only accounts), name, BU/SBU, auth provider, active flag, last login."],
      ["roles", "Named permission bundles (e.g. \"System Admin\"). `is_system` roles can't be deleted."],
      ["permissions", "The full catalog of permission codes (e.g. admin:users:manage, dashboard:read)."],
      ["role_permissions", "Which permissions a role grants."],
      ["user_group / user_group_member / user_group_role", "A group is a named set of users that carries a set of roles — the actual unit of access assignment in the admin UI."],
      ["user_roles", "Direct user→role assignment, bypassing groups. Kept for compatibility; groups are the primary mechanism."],
    ],
  },
  {
    title: "Datasets & Sync",
    blurb: "A \"dataset\" is one pipe pairing an Archer MS SQL feed table with a Postgres target table. Everything about a dataset's columns, types, and sync bookmark is metadata-driven — adding a new Archer module is a configuration action, not a code change.",
    tables: [
      ["dataset", "One row per pipe: source table, target table, key/watermark columns, active flag."],
      ["dataset_field", "The column catalog for a dataset — key, label, data type, and whether it's a filter dimension, chart measure, or searchable field. Drives the generated target table's DDL."],
      ["dataset_measure", "Structural (never raw-SQL) aggregate definitions per dataset, so measures can't become an injection surface."],
      ["dataset_sync_state", "One row per dataset: latest run status, watermark, row count, last error."],
      ["dataset_sync_history", "Append-only log of every sync run per dataset (for the Admin → Sync run history table)."],
      ["field_mapping", "Maps each Archer environment's own field names/ids onto this platform's column names — this is what makes the same build portable across DEV/UAT/PROD Archer instances."],
      ["fact_findings", "The flagship dataset's physical table — one row per Archer finding, 47 typed columns, JSONB for multi-value fields, and the full index set described in §3 below."],
    ],
  },
  {
    title: "Records Views (\"reports\")",
    blurb: "A View is a saved, role-scoped filter rule over a dataset — not a copy of the data. It stays live because it's just a WHERE clause plus a column list, evaluated fresh on every request.",
    tables: [
      ["reports", "One row per View: which dataset, its preset filter scope (JSON conditions + a logic expression like \"1 AND (2 OR 3)\"), and an optional row cap."],
      ["report_columns", "Which columns a View shows, and in what order."],
      ["report_filters", "Which fields a View exposes as end-user filters."],
      ["report_access", "Per-role or per-user grant of visibility into a View."],
    ],
  },
  {
    title: "Dashboards & Charts",
    blurb: "Every dashboard is owned by a user (or shared/system) and holds independent chart widgets, each with its own JSON spec (chart type, axes, filters, drill path) and its own pre-aggregated materialized view.",
    tables: [
      ["dashboards", "One row per dashboard: owner (null = shared/system), name, active flag."],
      ["dashboard_widgets", "One row per chart — its type, JSON config, and sort order. Its id is what `mv_chart_<id>` and chart_matview_state key off."],
      ["dashboard_access", "Per-role or per-user grant of visibility into a dashboard."],
      ["chart_matview_state", "Tracks whether a chart's matview covers its full breakdown or hit a safety cap, so the UI never has to re-probe the matview to know."],
    ],
  },
  {
    title: "Audit & Platform History",
    blurb: "Every mutating request is recorded automatically — nobody has to remember to call an audit API.",
    tables: [
      ["audit_log", "Who did what: user, action (LOGIN/CREATE/UPDATE/DELETE/EXPORT/SYNC_RUN), entity type/id, HTTP method/path/IP, status code, and a sanitized snapshot of the response (secrets stripped before storage)."],
      ["sync_history", "An older, module-level sync log, superseded per-dataset by dataset_sync_history but retained for continuity."],
    ],
  },
];

const RUNTIME_OBJECTS: [string, string][] = [
  ["ds_<dataset key> tables", "Generated automatically when an admin creates a dataset. Columns come entirely from that dataset's dataset_field rows — one physical column per field, typed via a fixed type map (text, integer, number, date, timestamp, boolean, json), plus a record_id primary key and a synced_at timestamp."],
  ["mv_chart_<widget id> materialized views", "Built (and rebuilt after every sync) from the chart's own group-by/measure config. Populated under a scratch name and swapped in atomically via rename, so a chart never serves a half-built view. This is the mechanism that keeps chart load times flat regardless of how many rows the underlying table has."],
];

const API_GROUPS: { title: string; perm: string; rows: [string, string][] }[] = [
  {
    title: "Auth",
    perm: "Public except /me",
    rows: [
      ["POST /api/auth/login, /refresh", "Password login and token refresh — returns an access + refresh JWT pair."],
      ["GET /api/auth/me", "Current user's profile (requires a valid token, no specific permission)."],
      ["GET /api/auth/sso/config, /login, /callback", "OIDC SSO probe, redirect to the identity provider, and callback handler."],
    ],
  },
  {
    title: "Dashboards — end user",
    perm: "dashboard:read / dashboard:create",
    rows: [
      ["GET /api/dashboards", "Dashboards visible to the current user."],
      ["GET /api/dashboards/:key/shell, /:key/charts/:id/data", "Split shell + per-widget data endpoints — the page paints immediately, each chart fills in independently."],
      ["POST /api/dashboards, PATCH/DELETE /:key, POST /:key/share", "Create/update/delete/share the caller's own dashboard."],
      ["POST /:key/charts, PATCH/DELETE /:key/charts/:id", "Add, edit, or remove a chart on an owned dashboard."],
      ["POST /:key/charts/:id/drill, /records", "Drill one level deeper, or fetch the raw records behind the deepest level (records supports a full export mode)."],
      ["POST /api/dashboards/query-preview(/drill)", "Live preview of an unsaved chart spec while building it."],
      ["POST /api/dashboards/charts/export", "Streams a chart as PDF or Excel."],
    ],
  },
  {
    title: "Dashboards — admin",
    perm: "admin:dashboards:manage",
    rows: [
      ["/api/admin/dashboards[/:id], /widgets[/:id], /access[/:id]", "Full CRUD over any dashboard, its widgets, and its role/user access grants — for dashboards not owned by the acting admin."],
    ],
  },
  {
    title: "Views (\"reports\") — end user",
    perm: "report:read (+ report:export)",
    rows: [
      ["GET /api/reports, /:key/config, /:key/filters, /:key/fields", "Views visible to the user, and each one's column/filter/field catalog."],
      ["GET /api/reports/:key/data", "Paginated, filtered, sorted, searched records — the Records tab's data source."],
      ["GET /api/reports/:key/export/{csv,excel,pdf}", "Streaming exports honoring the same filters as the current view."],
    ],
  },
  {
    title: "Views — admin",
    perm: "admin:reports:manage",
    rows: [
      ["/api/admin/reports/views[/:id]", "Create/update/delete a View (preset filter + columns + access)."],
      ["/api/admin/reports[/:id], /columns, /filters, /access", "Lower-level report/column/filter/access CRUD (the View endpoints above are the friendlier layer over this)."],
      ["POST /api/admin/reports/match-count", "Live \"this scope matches N records\" preview while building a View."],
    ],
  },
  {
    title: "Datasets — browse & admin",
    perm: "report:read · admin:datasets:manage",
    rows: [
      ["GET /api/datasets, /:key/schema, /:key/data, /:key/export/*", "Raw browse of a registered dataset's full table — the DataSets tab."],
      ["/api/admin/datasets[/:id], /preview, /:id/import", "Create/edit/delete a dataset, preview its generated DDL before running it, and CSV/manual row import."],
      ["/api/admin/mapping, /admin/source/*", "Field-mapping editor and read-only introspection of the Archer MSSQL feed (ping, list tables/columns)."],
    ],
  },
  {
    title: "Sync & Health",
    perm: "sync:read / sync:run",
    rows: [
      ["GET /api/health", "Public health check."],
      ["GET /api/sync/status, /history", "Per-dataset sync state and run history."],
      ["POST /api/sync/run", "Triggers a sync (single dataset or all) asynchronously — returns immediately, doesn't wait for completion."],
    ],
  },
  {
    title: "Admin: Users, Roles, Groups, Audit",
    perm: "admin:users:manage / admin:roles:manage / audit:read",
    rows: [
      ["/api/admin/users[/:id], /import", "User CRUD + bulk CSV import."],
      ["/api/admin/roles[/:id], /permissions, /resources, /:id/permissions, /:id/resources", "Role CRUD, the permission catalog, and per-role dashboard/view access grants."],
      ["/api/admin/groups[/:id]", "Group CRUD (the actual unit of access assignment)."],
      ["GET /api/audit", "Search the audit log by user, action, entity type, or date range."],
    ],
  },
];

const LIMITATIONS = [
  "No automated test suite exists yet (no unit/integration tests configured for either the backend or frontend).",
  "No centralized/structured logging or APM — the backend logs to stdout via NestJS's built-in Logger only.",
  "No automated backup schedule or retention policy configured; backups today are a manual `pg_dump` run before upgrades.",
  "No self-service password reset flow — an administrator must reset a user's password via the admin API.",
  "The full/initial bulk load of a very large dataset uses the same batched-upsert path as daily incremental sync. A COPY-based bulk-load path (benchmarked at ~15–20 minutes for 10M rows vs. several hours today) has been designed but not yet built as a real code path.",
  "Chart materialized-view refresh runs for every chart on every sync, not scoped to only the dataset that changed — fine at today's chart count, a growing cost as more charts are added.",
  "Single backend instance in the current deployment — no load balancer or PgBouncer configured yet (the architecture supports it; it's a deployment change, not a code change).",
  "No API rate limiting.",
  "Report/View column and filter definitions are managed through the admin API rather than a dedicated visual editor (Dashboards already have a full self-service builder UI; Views don't yet).",
  "Only one Archer module (Findings) is wired end-to-end today. Adding another (Devices, Exceptions, …) means adding a dataset + field mapping — supported by the platform, not yet done.",
];

const ROADMAP_SHORT = [
  "Build the real COPY-based bulk-load path for full/initial dataset syncs (drop indexes → COPY → rebuild indexes → refresh matviews) — the single biggest unbuilt performance lever.",
  "Scope chart matview refresh to only the dataset that just synced, instead of refreshing every chart on every run.",
  "Fix static-asset cache headers (immutable long-cache for hashed JS/CSS, no-cache for index.html) so a rebuild is never served stale by a returning browser.",
  "Stand up a baseline automated test suite (auth, RBAC enforcement, the filter/logic parser, and the aggregation query builder are the highest-value targets first).",
  "Centralized/structured logging (JSON logs shippable to a log aggregator) in place of console-only output.",
];

const ROADMAP_LONG = [
  "Horizontal scaling: multiple stateless backend replicas behind a load balancer, with PgBouncer in front of Postgres — enabled by the existing JWT (no server-side session) + shared Redis design.",
  "Read replicas for Postgres once concurrent read load grows past what a single primary comfortably serves.",
  "Table partitioning (e.g. by sync date) if a fact table grows well past its current ~10M-row scale toward 50–100M+.",
  "An analytics sidecar (e.g. ClickHouse) fed by the same ETL for ad-hoc slicing across many wide-table dimensions at 100M+ rows, with Postgres remaining the serving layer for the Records register.",
  "Self-service password reset, a dedicated Views column/filter editor UI, API rate limiting, and structured audit/log shipping to a SIEM.",
];

function Table({ head, rows }: { head: string[]; rows: (string | number)[][] }) {
  return (
    <div className="doc-table-wrap">
      <table className="doc-table">
        <thead><tr>{head.map((h) => <th key={h}>{h}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}
        </tbody>
      </table>
    </div>
  );
}

export default function DocumentationPage({ onBack }: { onBack: () => void }) {
  return (
    <div className="doc-shell">
      <div className="doc-topbar">
        <h1>Archer Analytics — Technical Documentation</h1>
        <button className="arch-back" onClick={onBack}>← Back to Architecture</button>
      </div>
      <p className="doc-meta">Reflects the current codebase. Prepared for internal and client technical review.</p>

      <div className="doc-body">
        <nav className="doc-toc">
          {TOC.map((t) => <a key={t.id} href={`#${t.id}`}>{t.label}</a>)}
        </nav>

        <div className="doc-content">

          {/* ============ 1. EXECUTIVE SUMMARY ============ */}
          <section className="doc-section" id="exec">
            <h2>1. Executive Summary & System Architecture</h2>

            <h3>1.1 Purpose & Business Logic</h3>
            <p>
              Archer Analytics is an enterprise reporting layer built on top of RSA Archer's GRC vulnerability-findings
              data. RSA Archer's own native reporting becomes slow over large, multi-million-record applications and
              exposes limited chart/drill-down flexibility. This platform solves that by <b>copying</b> Archer's data
              — read-only, one-way, on a schedule — into a purpose-built PostgreSQL warehouse, then serving
              sub-second, role-gated dashboards, an ad-hoc chart builder, a searchable/filterable records register,
              and streaming CSV/Excel/PDF exports, entirely independent of Archer's own performance.
            </p>
            <div className="doc-callout">
              <b>The one rule that shapes everything else:</b> the platform never writes back to Archer. The Archer
              side of the integration uses a least-privilege, read-only account, so the platform is architecturally
              incapable of modifying source data — this is true at the database-permission level, not just by convention.
            </div>
            <p>
              Data moves through a classic <b>ETL pipeline</b>: <b>Extract</b> only the rows changed since the last
              run (an incremental watermark, not a full re-copy), <b>Transform</b> them into typed, query-ready
              columns (multi-value fields become JSON arrays), and <b>Load</b> them into Postgres via an idempotent
              upsert keyed on Archer's own record id — so re-running a sync is always safe and never duplicates data.
            </p>

            <h3>1.2 Tech Stack & Justification</h3>
            <Table head={["Layer", "Technology", "Why"]} rows={STACK} />

            <p style={{ marginTop: 18 }}>
              <b>Three-tier shape:</b> an <b>Ingest</b> tier (the sync service, talking only to Archer's read-only
              MS SQL reporting feed), a <b>Store</b> tier (PostgreSQL for durable data + Redis for hot-query caching),
              and a <b>Serve</b> tier (the NestJS API plus the React single-page app). The Ingest and Serve tiers
              never talk to each other directly — they only ever meet in the shared Postgres store, which is what
              lets a slow or failed sync never affect a user actively viewing a dashboard, and vice versa.
            </p>
          </section>

          {/* ============ 2. TECHNICAL SETUP ============ */}
          <section className="doc-section" id="setup">
            <h2>2. Technical Setup & Deployment Guide</h2>

            <h3>2.1 Prerequisites & Local Environment</h3>
            <p><b>Option A — Docker (recommended, simplest):</b> Docker + Docker Compose only. Everything else
              (Postgres, Redis, the two app services) is provisioned by <code>docker compose up</code>.</p>
            <p><b>Option B — Native, no Docker:</b> Node.js 20+, PostgreSQL 14+, and Redis 7 (Redis can be Memurai on
              Windows, or any managed cache — it's optional either way).</p>
            <pre className="doc-code">{`cp .env.example .env        # fill in DATABASE_URL + JWT secrets
docker compose up --build

# open http://localhost:3000 — seeded admin:
#   email: admin@example.com   password: ChangeMe123!  (rotate immediately)`}</pre>
            <p>
              On first boot against an empty database, the installer creates the full schema and the app seeds a
              small demo dataset so the dashboards render immediately — nothing further to configure to evaluate
              the platform end-to-end before connecting real Archer data.
            </p>

            <h3>2.2 Environment Variables (sanitized reference)</h3>
            <p className="arch-muted">
              The complete, authoritative list lives in <code>.env.example</code> (committed, no real secrets) and is
              read by the backend from <code>backend/src/config/configuration.ts</code>. On Azure these are set as
              Application Settings instead of a file — nothing else changes.
            </p>
            <Table head={["Variable", "Required", "Purpose"]} rows={ENV_VARS} />

            <h3>2.3 Deployment & Build Pipeline</h3>
            <p><b>Backend build:</b> <code>nest build</code> → <code>node dist/main.js</code>. <b>Frontend build:</b>{" "}
              <code>tsc -b && vite build</code> → static files in <code>frontend/dist</code>, served by nginx
              (Docker) or any static host, with <code>/api</code> reverse-proxied to the backend.</p>
            <ol className="arch-steps">
              <li><b>Provision.</b> A read-only Archer service account (db_datareader) and the reporting feed's
                table/host/database — DEV first, never PROD first.</li>
              <li><b>Deploy the containers</b> (or native processes) with real secrets in place — see §4.3 for how
                secrets are generated and stored.</li>
              <li><b>Point at the real feed.</b> Admin → Data Sources sets the source table; Admin → Field Mapping
                → Auto-map resolves column names for that specific Archer environment.</li>
              <li><b>Verify.</b> Confirm sync status is "ok" with a sensible row count, spot-check records against
                Archer directly, and confirm role-based visibility (a viewer sees no Admin panel).</li>
              <li><b>Promote DEV → UAT → PROD.</b> The identical build is redeployed each time; only <code>.env</code>
                (secrets + that environment's Archer connection) changes — there is no code difference between
                environments.</li>
            </ol>
            <p className="arch-muted">Azure specifics (Postgres Flexible Server, Container Apps/App Service,
              Static Web Apps, required <code>sslmode=require</code>) are documented in full in the repository's
              <code> CONFIGURATION.md</code>.</p>
          </section>

          {/* ============ 3. DATA & INTERACTION MODELS ============ */}
          <section className="doc-section" id="data">
            <h2>3. Data & Interaction Models</h2>

            <h3>3.1 Core Database Schema & Relationships</h3>
            <p className="arch-muted">
              Schema is defined entirely by hand-run, idempotent SQL scripts under <code>db/</code> (there is no
              migration-tool dependency), plus a small boot-time drift guard that adds anything created after the
              fact. Tables group into five domains:
            </p>
            {SCHEMA_GROUPS.map((g) => (
              <div key={g.title} className="doc-schema-group">
                <h4>{g.title}</h4>
                <p className="arch-muted">{g.blurb}</p>
                <Table head={["Table", "What it holds"]} rows={g.tables} />
              </div>
            ))}
            <div className="doc-schema-group">
              <h4>Created dynamically at runtime</h4>
              <p className="arch-muted">
                Two kinds of database object are generated by the application itself rather than a setup script:
              </p>
              <Table head={["Object", "How it's generated"]} rows={RUNTIME_OBJECTS} />
            </div>
            <p className="arch-muted">
              Performance detail worth noting: <code>fact_findings</code> (the flagship dataset) carries composite
              <code> (column, record_id)</code> indexes for every default-visible column specifically so sorted paging
              is an index-only scan rather than a full sort — measured at 7.6s → 13ms at 10M rows — plus GIN JSONB
              indexes for multi-value field filters and GIN trigram indexes for instant substring search.
            </p>

            <h3>3.2 Main API Endpoints</h3>
            <p className="arch-muted">
              Every route is authenticated and permission-checked by default (a global JWT guard plus a global
              permissions guard), unless explicitly marked public (login, health check, SSO handshake). A route
              declares its required permission code(s) with a <code>@Permissions(...)</code> decorator; a route with
              none is reachable by any authenticated user.
            </p>
            {API_GROUPS.map((g) => (
              <div key={g.title} className="doc-schema-group">
                <h4>{g.title} <span className="doc-perm-badge">{g.perm}</span></h4>
                <Table head={["Route", "Description"]} rows={g.rows} />
              </div>
            ))}
          </section>

          {/* ============ 4. SECURITY ============ */}
          <section className="doc-section" id="security">
            <h2>4. Security, Data Privacy & Compliance</h2>

            <h3>4.1 Authentication & Authorization (RBAC / JWT)</h3>
            <p>
              Sign-in issues a short-lived <b>access token</b> (default 15 minutes) and a longer-lived <b>refresh
              token</b> (default 7 days), both JWTs — stateless by design, so any number of backend instances can
              validate a request without a shared session store. Passwords are hashed with <b>bcrypt</b> (cost
              factor 10) and never stored or logged in plain text. Optional <b>OIDC single sign-on</b> (Authorization
              Code + PKCE) works with any standards-compliant identity provider — Entra ID, Okta, Google, Keycloak,
              Auth0 — with state/nonce held in Redis for the round trip; a first-time SSO user is auto-provisioned
              with a configurable default role, and password login remains available in parallel for break-glass access.
            </p>
            <p>
              Authorization is fully role-based and entirely data-driven — no permission is hard-coded into a
              screen. A user's effective permissions are the union of every role held by every group they belong to.
              Every single API route is covered by a global permission guard by default; a route only becomes
              reachable when explicitly marked public or annotated with the permission code(s) it requires, so a
              new endpoint is secure by default rather than by remembering to add a check. Dashboards and Views
              additionally carry their own row-level access grants (to a specific role <i>or</i> a specific
              individual user), so an admin can expose one dashboard to one person without inventing a new role.
            </p>

            <h3>4.2 Data Protection (in transit & at rest)</h3>
            <ul className="doc-list">
              <li><b>In transit:</b> HTTPS is terminated at the reverse proxy / hosting layer in front of both the
                frontend and the API; the Postgres connection uses <code>sslmode=require</code> in the Azure/managed
                configuration, and the Archer MS SQL connection is encrypted (<code>MSSQL_ENCRYPT=true</code>) in
                production.</li>
              <li><b>Source system:</b> the Archer-side account is provisioned read-only (<code>db_datareader</code>)
                — the platform is not merely instructed not to write back, it is not permitted to at the database
                level.</li>
              <li><b>At rest:</b> data at rest protection (disk/volume encryption) is provided by the hosting
                platform (e.g. Azure Database for PostgreSQL's encryption-at-rest) rather than by application code —
                this should be confirmed as enabled wherever the database is finally hosted.</li>
              <li><b>Audit redaction:</b> the automatic audit trail (below) strips password, password hash, and
                token fields from any request/response body before it's ever written to storage.</li>
            </ul>

            <h3>4.3 Secure Credential Management</h3>
            <p>
              Every secret — database credentials, JWT signing keys, Archer service-account credentials, OIDC client
              secret — is supplied exclusively via environment variables, never committed to source control. Locally
              this is a git-ignored <code>.env</code> file; in Azure these are Application Settings. JWT secrets are
              generated fresh per environment (<code>openssl rand -hex 32</code>) and the access/refresh secrets are
              required to differ. The repository's own configuration guide documents a security-hygiene practice
              worth highlighting: an earlier example credential was found committed to a template file and was
              rotated and removed — the current process (a sanitized <code>.env.example</code> with a documented
              pre-launch checklist) exists specifically to prevent a repeat.
            </p>
            <div className="doc-callout warn">
              <b>Pre-launch checklist:</b> fresh JWT secrets · real Postgres connection string with SSL · rotated
              seeded admin password · read-only Archer account confirmed · no secrets committed to git.
            </div>

            <h3>Audit trail</h3>
            <p>
              Every mutating request (create/update/delete), every export, and every login is recorded automatically
              by a global interceptor — no developer has to remember to call an audit API. Each entry captures the
              acting user, the action taken, the entity type/id affected, HTTP method/path/IP, the resulting status
              code, and a sanitized snapshot of the response, searchable by an administrator under Admin → Audit.
            </p>
          </section>

          {/* ============ 5. OPERATIONS ============ */}
          <section className="doc-section" id="ops">
            <h2>5. Operations, Maintenance & Backups</h2>

            <h3>5.1 Backup Schedule & Disaster Recovery</h3>
            <p>
              PostgreSQL is a genuine <b>source of truth</b> for everything the platform itself owns — dashboards,
              views, users, roles, audit history — even though it is only a <b>copy</b> of Archer's findings data.
              That distinction matters for recovery: the findings data can always be rebuilt by re-running sync
              against Archer, but dashboards/users/audit history cannot be recreated from Archer at all and must be
              backed up in their own right.
            </p>
            <p>
              Today, backups are a <b>manual</b> <code>pg_dump</code> of the Postgres volume, taken before upgrades —
              there is no automated backup schedule or retention policy configured yet (tracked in §5.3 and §6 as
              the top operational gap to close). Full environment rebuild is otherwise self-healing: dropping the
              database volume and re-running <code>docker compose up</code> re-creates an empty, fully-structured
              system from the installer scripts, and the next sync reloads findings data from Archer.
            </p>

            <h3>5.2 Automated Testing & Logging</h3>
            <p>
              <b>Testing:</b> there is no automated test suite in the codebase today (no unit or integration tests
              configured for either the backend or the frontend). This is the most significant piece of technical
              debt in the platform and is called out explicitly rather than glossed over — see §5.3 and the
              short-term roadmap in §6.
            </p>
            <p>
              <b>Logging:</b> the backend logs via NestJS's built-in console logger (stdout). There is no structured
              (JSON) log format and no shipping to a centralized log aggregator or APM tool configured yet — logs are
              read directly from the running container/process today.
            </p>

            <h3>5.3 Known Limitations & Technical Debt</h3>
            <ul className="doc-list">
              {LIMITATIONS.map((l) => <li key={l}>{l}</li>)}
            </ul>
          </section>

          {/* ============ 6. ROADMAP ============ */}
          <section className="doc-section" id="roadmap">
            <h2>6. Product Roadmap & Scalability</h2>

            <h3>6.1 Near-term Enhancements</h3>
            <ul className="doc-list">
              {ROADMAP_SHORT.map((l) => <li key={l}>{l}</li>)}
            </ul>

            <h3>6.2 Longer-term & Infrastructure Scalability</h3>
            <ul className="doc-list">
              {ROADMAP_LONG.map((l) => <li key={l}>{l}</li>)}
            </ul>

            <h3>What's already built to scale</h3>
            <p>
              Benchmarked at 10 million rows: the standard dashboard serves in roughly 20ms and the records register
              in well under a second cold (single-digit milliseconds cached), because every user-built chart gets its
              own materialized view — refreshed after each sync, dropped when the chart is deleted, and falling back
              to a live query automatically if a matview is ever missing, so the system self-heals rather than
              erroring. Server-side pagination, keyset-paginated deep paging, and streaming exports mean the browser
              and the export process both use constant memory regardless of table size. None of this requires a
              schema or architecture change to keep scaling further — the roadmap above is about extending it
              (bulk-load speed, matview refresh scoping) and about the operational maturity (testing, logging,
              backups) that should sit alongside it before a large-scale production rollout.
            </p>
          </section>

        </div>
      </div>

      <div className="arch-footer">
        <button className="arch-back" onClick={onBack}>← Back to Architecture</button>
      </div>
    </div>
  );
}

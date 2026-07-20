-- =====================================================================
--  Archer Analytics — platform schema (users, roles, dashboards, reports, audit)
--
--  This file creates the PLATFORM only. The findings/dataset tables are created
--  by the files that install.sql runs after this one.
--
--  NOTE: the original demo schema (a partitioned fact_findings with dim_* tables
--  and mv_* widget views) was retired when the real Archer field model landed.
--  It must NOT be recreated here: it would win the CREATE TABLE IF NOT EXISTS
--  race against the real fact_findings and leave the app querying columns that
--  do not exist.
--
--  Run db/install.sql — not this file directly.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- pg_trgm powers fast "contains" search. Some managed providers (notably Azure
-- Database for PostgreSQL) block extensions unless they're allow-listed, and a hard
-- failure here would abort the WHOLE installer. Warn and continue instead: everything
-- else installs, and the trigram search indexes are skipped automatically.
-- To enable it on Azure: Server parameters -> azure.extensions -> add PG_TRGM -> Save.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'pg_trgm unavailable (%) — text-search indexes will be skipped. Allow-list it for fast search.', SQLERRM;
END $$;
-- =====================================================================
-- RBAC: users, roles, permissions, and grants on dashboards/reports
-- =====================================================================
CREATE TABLE IF NOT EXISTS users (
    id            BIGSERIAL PRIMARY KEY,
    email         TEXT UNIQUE NOT NULL,
    password_hash TEXT,                         -- NULL for SSO-only accounts
    full_name     TEXT NOT NULL,
    auth_provider TEXT NOT NULL DEFAULT 'local',-- 'local' | 'oidc'
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    last_login_at TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Idempotent upgrades for databases created before these columns existed:
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_provider TEXT NOT NULL DEFAULT 'local';
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

CREATE TABLE IF NOT EXISTS roles (
    id          SERIAL PRIMARY KEY,
    name        TEXT UNIQUE NOT NULL,
    description TEXT,
    is_system   BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS permissions (
    id          SERIAL PRIMARY KEY,
    code        TEXT UNIQUE NOT NULL,   -- e.g. 'dashboard:read', 'admin:users:manage'
    description TEXT
);

CREATE TABLE IF NOT EXISTS role_permissions (
    role_id       INT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permission_id INT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
    PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS user_roles (
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_id INT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, role_id)
);

-- ============ Dashboard & report configuration (admin-editable) ============
CREATE TABLE IF NOT EXISTS dashboards (
    id            SERIAL PRIMARY KEY,
    key           TEXT UNIQUE NOT NULL,
    name          TEXT NOT NULL,
    description   TEXT,
    owner_user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,  -- NULL = system/shared dashboard
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order    INT NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE dashboards ADD COLUMN IF NOT EXISTS owner_user_id BIGINT REFERENCES users(id) ON DELETE CASCADE;

CREATE TABLE IF NOT EXISTS dashboard_widgets (
    id            SERIAL PRIMARY KEY,
    dashboard_id  INT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
    key           TEXT NOT NULL,          -- 'kpi_summary' | 'by_severity' | 'by_business_unit' | 'trend' | 'aging'
    title         TEXT NOT NULL,
    widget_type   TEXT NOT NULL,          -- 'kpi' | 'donut' | 'bar' | 'line' | 'stacked_bar'
    data_source   TEXT NOT NULL,          -- name of the registered query this widget renders
    sort_order    INT NOT NULL DEFAULT 0,
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    config        JSONB NOT NULL DEFAULT '{}',
    UNIQUE (dashboard_id, key)
);

CREATE TABLE IF NOT EXISTS dashboard_access (
    id           SERIAL PRIMARY KEY,
    dashboard_id INT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
    role_id      INT REFERENCES roles(id) ON DELETE CASCADE,
    user_id      BIGINT REFERENCES users(id) ON DELETE CASCADE,
    CHECK (num_nonnulls(role_id, user_id) = 1)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_dash_access_role ON dashboard_access (dashboard_id, role_id) WHERE role_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_dash_access_user ON dashboard_access (dashboard_id, user_id) WHERE user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS reports (
    id          SERIAL PRIMARY KEY,
    key         TEXT UNIQUE NOT NULL,
    name        TEXT NOT NULL,
    description TEXT,
    data_source TEXT NOT NULL DEFAULT 'fact_findings',
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS report_columns (
    id                 SERIAL PRIMARY KEY,
    report_id          INT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
    key                TEXT NOT NULL,
    label              TEXT NOT NULL,
    sortable           BOOLEAN NOT NULL DEFAULT TRUE,
    is_default_visible BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order         INT NOT NULL DEFAULT 0,
    UNIQUE (report_id, key)
);

CREATE TABLE IF NOT EXISTS report_filters (
    id          SERIAL PRIMARY KEY,
    report_id   INT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
    key         TEXT NOT NULL,
    label       TEXT NOT NULL,
    filter_type TEXT NOT NULL,   -- 'select' | 'text' | 'boolean' | 'date_range'
    source      TEXT,            -- e.g. 'dim_severity.severity_name' for select options
    sort_order  INT NOT NULL DEFAULT 0,
    UNIQUE (report_id, key)
);

CREATE TABLE IF NOT EXISTS report_access (
    id        SERIAL PRIMARY KEY,
    report_id INT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
    role_id   INT REFERENCES roles(id) ON DELETE CASCADE,
    user_id   BIGINT REFERENCES users(id) ON DELETE CASCADE,
    CHECK (num_nonnulls(role_id, user_id) = 1)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_rep_access_role ON report_access (report_id, role_id) WHERE role_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_rep_access_user ON report_access (report_id, user_id) WHERE user_id IS NOT NULL;

-- ============ Audit log ============
CREATE TABLE IF NOT EXISTS audit_log (
    id           BIGSERIAL PRIMARY KEY,
    user_id      BIGINT REFERENCES users(id) ON DELETE SET NULL,
    user_email   TEXT,
    action       TEXT NOT NULL,        -- LOGIN | CREATE | UPDATE | DELETE | EXPORT | SYNC_RUN ...
    entity_type  TEXT,
    entity_id    TEXT,
    method       TEXT,
    path         TEXT,
    ip_address   TEXT,
    before_state JSONB,
    after_state  JSONB,
    status_code  INT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_audit_user     ON audit_log (user_id);
CREATE INDEX IF NOT EXISTS ix_audit_created  ON audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS ix_audit_entity   ON audit_log (entity_type, entity_id);

-- ============ Sync run history (append-only; sync_state stays as "latest") ============
CREATE TABLE IF NOT EXISTS sync_history (
    id               BIGSERIAL PRIMARY KEY,
    module_alias     TEXT NOT NULL,
    run_type         TEXT NOT NULL,        -- 'full' | 'incremental'
    status           TEXT NOT NULL,        -- 'running' | 'success' | 'error'
    attempt          INT NOT NULL DEFAULT 1,
    rows_synced      BIGINT NOT NULL DEFAULT 0,
    watermark_before TIMESTAMPTZ,
    watermark_after  TIMESTAMPTZ,
    error_detail     TEXT,
    started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at      TIMESTAMPTZ,
    duration_ms      INT
);
CREATE INDEX IF NOT EXISTS ix_sync_history_module ON sync_history (module_alias, started_at DESC);

-- =====================================================================
-- Seed data: permissions, roles, admin user, default dashboard/report
-- =====================================================================
INSERT INTO permissions (code, description) VALUES
    ('dashboard:read',        'View dashboards and widgets'),
    ('dashboard:create',      'Create and manage your own dashboards'),
    ('report:read',           'View and query reports'),
    ('report:export',         'Export report data (CSV/Excel/PDF)'),
    ('sync:read',             'View ETL sync status and history'),
    ('sync:run',              'Trigger manual ETL sync runs'),
    ('audit:read',            'View audit log'),
    ('admin:users:manage',    'Create/update/deactivate users'),
    ('admin:roles:manage',    'Create/update roles and permission grants'),
    ('admin:dashboards:manage','Create/update dashboards, widgets, and access grants'),
    ('admin:reports:manage',  'Create/update reports, columns, filters, and access grants')
ON CONFLICT (code) DO NOTHING;

INSERT INTO roles (name, description, is_system) VALUES
    ('admin',   'Full platform administrator', TRUE),
    ('analyst', 'Can view dashboards/reports, export, and trigger sync', TRUE),
    ('viewer',  'Read-only access to dashboards and reports', TRUE)
ON CONFLICT (name) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p WHERE r.name = 'admin'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p
  ON p.code IN ('dashboard:read','dashboard:create','report:read','report:export','sync:read','sync:run','audit:read')
WHERE r.name = 'analyst'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p
  ON p.code IN ('dashboard:read','dashboard:create','report:read')
WHERE r.name = 'viewer'
ON CONFLICT DO NOTHING;

-- Default admin user: admin@example.com / ChangeMe123!  (rotate immediately after first login)
INSERT INTO users (email, password_hash, full_name, is_active)
VALUES ('admin@example.com', crypt('ChangeMe123!', gen_salt('bf', 10)), 'Platform Administrator', TRUE)
ON CONFLICT (email) DO NOTHING;

INSERT INTO user_roles (user_id, role_id)
SELECT u.id, r.id FROM users u JOIN roles r ON r.name = 'admin' WHERE u.email = 'admin@example.com'
ON CONFLICT DO NOTHING;

-- Default dashboard mirroring the existing widget set
-- (The findings overview dashboard is seeded by overview_dashboard.sql, built on the
--  real Archer fields. The old mv_* widget dashboard was retired with that schema.)

-- Default report mirroring the existing findings register
INSERT INTO reports (key, name, description, data_source)
VALUES ('findings-register', 'Findings Register', 'Paginated, filterable register of all findings', 'fact_findings')
ON CONFLICT (key) DO NOTHING;

INSERT INTO report_columns (report_id, key, label, sortable, sort_order)
SELECT r.id, c.key, c.label, c.sortable, c.sort_order
FROM reports r CROSS JOIN (VALUES
    ('record_id',        'Record ID',       TRUE,  0),
    ('device_name',      'Device Name',     TRUE,  1),
    ('computer_name',    'Computer Name',   TRUE,  2),
    ('cve',              'CVE',             TRUE,  3),
    ('cve_type',         'CVE Type',        TRUE,  4),
    ('priority',         'Priority',        TRUE,  5),
    ('age',              'Age',             TRUE,  6),
    ('device_status',    'Device Status',   TRUE,  7),
    ('record_status',    'Record Status',   TRUE,  8),
    ('days_open',        'Days Open',       TRUE,  9),
    ('first_found_date', 'First Found',     TRUE, 10),
    ('closed_date',      'Closed',          TRUE, 11)
) AS c(key, label, sortable, sort_order)
WHERE r.key = 'findings-register'
ON CONFLICT (report_id, key) DO NOTHING;

-- (Filter fields/options now come from the dataset catalog + dropdown_option.)

INSERT INTO report_access (report_id, role_id)
SELECT r.id, ro.id FROM reports r CROSS JOIN roles ro
WHERE r.key = 'findings-register' AND ro.name IN ('admin','analyst','viewer')
ON CONFLICT DO NOTHING;

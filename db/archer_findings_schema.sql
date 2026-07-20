-- =====================================================================
--  Archer Analytics — Vulnerability Findings schema
--  Target: PostgreSQL 14+
--
--  Run this ONCE on an empty database. It is idempotent (safe to re-run):
--  every object uses IF NOT EXISTS / ON CONFLICT.
--
--  What it creates:
--    * fact_findings        - one row per Archer finding (all 48 fields)
--    * dropdown_option       - the valid values for each dropdown field
--                              (drives the UI filter/pick-lists)
--    * sync_state            - bookmark for incremental Archer sync
--    * indexes               - for fast filtering, sorting and text search
--
--  Design notes:
--    * Single-select dropdowns  -> TEXT columns (value stored as-is from Archer)
--    * Multi-user / cross-ref    -> JSONB columns (arrays of values/emails)
--    * Dates                     -> DATE (Last Updated is a TIMESTAMP for sync)
--    * record_id                 -> Archer Content ID (the unique system key)
-- =====================================================================

-- Fast "contains" text search. Optional: managed hosts (Azure) may block it unless
-- allow-listed, so never let it abort the install — the trigram indexes below are
-- created only if the extension is actually present.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'pg_trgm unavailable (%) — text-search indexes will be skipped.', SQLERRM;
END $$;

-- ---------------------------------------------------------------------
-- Main table: one row per finding
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fact_findings (
    record_id                     BIGINT PRIMARY KEY,   -- Archer Content ID

    -- 1  Age (dropdown: Red / High / Yellow / Green)
    age                           TEXT,
    -- 2  Application Owner (one or more user emails)
    application_owner             JSONB DEFAULT '[]'::jsonb,
    -- 3  Approved Exception
    approved_exception            TEXT,
    -- 4  Asset ID
    asset_id                      TEXT,
    -- 5  BU Leaders (user emails)
    bu_leaders                    JSONB DEFAULT '[]'::jsonb,
    -- 6  BU Vulnerability Coordinator (user emails)
    bu_vulnerability_coordinator  JSONB DEFAULT '[]'::jsonb,
    -- 7  Business Unit (JSON / values list)
    business_unit                 JSONB DEFAULT '[]'::jsonb,
    -- 8  Client Engagement Manager (CEM) (user emails)
    client_engagement_manager     JSONB DEFAULT '[]'::jsonb,
    -- 9  Closed Date
    closed_date                   DATE,
    -- 10 Comments
    comments                      TEXT,
    -- 11 Computer Name
    computer_name                 TEXT,
    -- 12 Criteria
    criteria                      TEXT,
    -- 13 CrowdStrike Device OS
    crowdstrike_device_os         TEXT,
    -- 14 CVE
    cve                           TEXT,
    -- 15 CVE - Vulnerability Library (cross-reference list)
    cve_vulnerability_library     JSONB DEFAULT '[]'::jsonb,
    -- 16 CVE Type (dropdown)
    cve_type                      TEXT,
    -- 17 Days Open
    days_open                     INTEGER,
    -- 18 Default Record Permission (user emails)
    default_record_permission     JSONB DEFAULT '[]'::jsonb,
    -- 19 Details
    details                       TEXT,
    -- 20 Detection ID
    detection_id                  TEXT,
    -- 21 Device IP Address
    device_ip_address             TEXT,
    -- 22 Device Name
    device_name                   TEXT,
    -- 23 Device Status (dropdown)
    device_status                 TEXT,
    -- 24 Evidence
    evidence                      TEXT,
    -- 25 Exception Request (cross-reference list)
    exception_request             JSONB DEFAULT '[]'::jsonb,
    -- 26 False Positive - Approved
    false_positive_approved       TEXT,
    -- 27 False Positive - Rejected
    false_positive_rejected       TEXT,
    -- 28 False Positive - Requested
    false_positive_requested      TEXT,
    -- 29 Findings (Vulnerability Scan Results)
    findings_scan_results         TEXT,
    -- 30 First Found Date
    first_found_date              DATE,
    -- 31 First Published
    first_published               DATE,
    -- 32 History Log
    history_log                   TEXT,
    -- 33 Impacted Device (cross-reference list)
    impacted_device               JSONB DEFAULT '[]'::jsonb,
    -- 34 Impacted Solution (cross-reference list)
    impacted_solution             JSONB DEFAULT '[]'::jsonb,
    -- 35 Inquiry Ticket (cross-reference list)
    inquiry_ticket                JSONB DEFAULT '[]'::jsonb,
    -- 36 Last Updated (used as the incremental-sync watermark)
    last_updated                  TIMESTAMPTZ,
    -- 37 OS Engineering Owner (user emails)
    os_engineering_owner          JSONB DEFAULT '[]'::jsonb,
    -- 38 OS Patching Owner (user emails)
    os_patching_owner             JSONB DEFAULT '[]'::jsonb,
    -- 39 Priority (dropdown: 1..7 / Client Restricted / Data Missing)
    priority                      TEXT,
    -- 40 Rationale
    rationale                     TEXT,
    -- 41 Reassign Vulnerability (dropdown)
    reassign_vulnerability        TEXT,
    -- 42 Record Status
    record_status                 TEXT,
    -- 43 Rejected Exception
    rejected_exception            TEXT,
    -- 44 Remediation Overview
    remediation_overview          TEXT,
    -- 45 SBP (user emails)
    sbp                           JSONB DEFAULT '[]'::jsonb,
    -- 46 SBU CID
    sbu_cid                       TEXT,
    -- 47 SBU President (user emails)
    sbu_president                 JSONB DEFAULT '[]'::jsonb,
    -- 48 SBU Vulnerability Coordinator (user emails)
    sbu_vulnerability_coordinator JSONB DEFAULT '[]'::jsonb,

    -- housekeeping (set by the sync job, not from Archer)
    synced_at                     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Dropdown option catalog: valid values for each pick-list field.
-- The app reads this to populate filter dropdowns. Add/adjust freely.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dropdown_option (
    -- Pick-lists belong to a dataset: Devices' "device_status" is not Findings'.
    dataset_key TEXT NOT NULL DEFAULT 'archer-findings',
    field_key   TEXT NOT NULL,     -- e.g. 'age', 'priority'
    value       TEXT NOT NULL,     -- what is stored in the dataset's table
    label       TEXT NOT NULL,     -- what the user sees
    sort_order  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (dataset_key, field_key, value)
);

-- Upgrade path for installs created before pick-lists were dataset-scoped.
ALTER TABLE dropdown_option ADD COLUMN IF NOT EXISTS dataset_key TEXT NOT NULL DEFAULT 'archer-findings';
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'dropdown_option' AND c.contype = 'p'
      AND pg_get_constraintdef(c.oid) LIKE '%dataset_key%'
  ) THEN
    ALTER TABLE dropdown_option DROP CONSTRAINT IF EXISTS dropdown_option_pkey;
    ALTER TABLE dropdown_option ADD PRIMARY KEY (dataset_key, field_key, value);
  END IF;
END $$;

INSERT INTO dropdown_option (field_key, value, label, sort_order) VALUES
    -- Age
    ('age', 'Red',    'Red (greater than 6 months)',                    1),
    ('age', 'High',   'High (90 to 180 days)',                          2),
    ('age', 'Yellow', 'Yellow (greater than 30 days, less than 6 mo.)', 3),
    ('age', 'Green',  'Green (less than 30 days)',                      4),
    -- CVE Type
    ('cve_type', 'Application',                     'Application',                      1),
    ('cve_type', 'OS Engineering',                  'OS Engineering',                   2),
    ('cve_type', 'OS Patching',                     'OS Patching',                      3),
    ('cve_type', 'Tier 1A - OS Patching',           'Tier 1A - OS Patching',            4),
    ('cve_type', 'Tier 1B - OS Patching (App Impact)', 'Tier 1B - OS Patching (App Impact)', 5),
    -- Device Status
    ('device_status', 'Active',            'Active',            1),
    ('device_status', 'Installed',         'Installed',         2),
    ('device_status', 'Removed',           'Removed',           3),
    ('device_status', 'Purchased',         'Purchased',         4),
    ('device_status', 'groupinfa.com',     'groupinfa.com',     5),
    ('device_status', 'Ignored',           'Ignored',           6),
    ('device_status', 'Archived',          'Archived',          7),
    ('device_status', 'Awaiting Inventory','Awaiting Inventory',8),
    ('device_status', 'Retired',           'Retired',           9),
    -- Priority
    ('priority', '1', '1', 1),
    ('priority', '2', '2', 2),
    ('priority', '3', '3', 3),
    ('priority', '4', '4', 4),
    ('priority', '5', '5', 5),
    ('priority', '6', '6', 6),
    ('priority', '7', '7', 7),
    ('priority', 'Client Restricted', 'Client Restricted', 8),
    ('priority', 'Data Missing',      'Data Missing',      9),
    -- Reassign Vulnerability
    ('reassign_vulnerability', 'Yes', 'Yes', 1)
ON CONFLICT (dataset_key, field_key, value) DO UPDATE
    SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order;

-- ---------------------------------------------------------------------
-- Sync bookmark: remembers how far the incremental Archer sync got.
-- (Named findings_sync_state to avoid clashing with the app's own sync tables.)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS findings_sync_state (
    source              TEXT PRIMARY KEY,   -- e.g. 'archer-findings'
    last_synced_at      TIMESTAMPTZ,        -- when the sync last ran
    last_record_updated TIMESTAMPTZ,        -- max(last_updated) pulled so far
    rows_total          BIGINT DEFAULT 0,
    note                TEXT
);

INSERT INTO findings_sync_state (source, note) VALUES ('archer-findings', 'initialised')
ON CONFLICT (source) DO NOTHING;

-- ---------------------------------------------------------------------
-- Indexes — filtering, sorting, incremental sync, and text search.
-- ---------------------------------------------------------------------
-- Dropdown / status columns commonly grouped & filtered:
CREATE INDEX IF NOT EXISTS ix_ff_age            ON fact_findings (age);
CREATE INDEX IF NOT EXISTS ix_ff_cve_type       ON fact_findings (cve_type);
CREATE INDEX IF NOT EXISTS ix_ff_device_status  ON fact_findings (device_status);
CREATE INDEX IF NOT EXISTS ix_ff_priority       ON fact_findings (priority);
CREATE INDEX IF NOT EXISTS ix_ff_record_status  ON fact_findings (record_status);

-- Dates & numbers used in ranges / sorting:
CREATE INDEX IF NOT EXISTS ix_ff_last_updated   ON fact_findings (last_updated DESC);
CREATE INDEX IF NOT EXISTS ix_ff_first_found    ON fact_findings (first_found_date);

-- ---------------------------------------------------------------------
-- Records-list SORT indexes: (column, record_id).
-- The app orders by "<column> <dir>, record_id <dir>", so ONE plain composite
-- index serves BOTH ascending and descending (forward / backward Index Only Scan).
-- Without these, clicking a column header makes Postgres sort the WHOLE table to
-- return 25 rows — measured at 10M rows: 7.6 s each, vs ~13 ms with the index.
-- These cover the columns shown by default in the Records list; add more if users
-- routinely sort by other fields.
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ix_ff_sort_first_found  ON fact_findings (first_found_date, record_id);
CREATE INDEX IF NOT EXISTS ix_ff_sort_closed_date  ON fact_findings (closed_date, record_id);
CREATE INDEX IF NOT EXISTS ix_ff_sort_last_updated ON fact_findings (last_updated, record_id);
CREATE INDEX IF NOT EXISTS ix_ff_sort_days_open    ON fact_findings (days_open, record_id);
CREATE INDEX IF NOT EXISTS ix_ff_sort_priority     ON fact_findings (priority, record_id);
CREATE INDEX IF NOT EXISTS ix_ff_sort_age          ON fact_findings (age, record_id);
CREATE INDEX IF NOT EXISTS ix_ff_sort_device_status ON fact_findings (device_status, record_id);
CREATE INDEX IF NOT EXISTS ix_ff_sort_record_status ON fact_findings (record_status, record_id);
CREATE INDEX IF NOT EXISTS ix_ff_sort_cve_type     ON fact_findings (cve_type, record_id);
CREATE INDEX IF NOT EXISTS ix_ff_sort_device_name  ON fact_findings (device_name, record_id);
CREATE INDEX IF NOT EXISTS ix_ff_sort_cve          ON fact_findings (cve, record_id);
CREATE INDEX IF NOT EXISTS ix_ff_closed_date    ON fact_findings (closed_date);
CREATE INDEX IF NOT EXISTS ix_ff_days_open      ON fact_findings (days_open);

-- Multi-value JSONB columns commonly filtered (contains / any-of):
CREATE INDEX IF NOT EXISTS ix_ff_business_unit_gin  ON fact_findings USING GIN (business_unit);
CREATE INDEX IF NOT EXISTS ix_ff_app_owner_gin      ON fact_findings USING GIN (application_owner);
CREATE INDEX IF NOT EXISTS ix_ff_cve_lib_gin        ON fact_findings USING GIN (cve_vulnerability_library);
CREATE INDEX IF NOT EXISTS ix_ff_impacted_dev_gin   ON fact_findings USING GIN (impacted_device);

-- Free-text search (ILIKE '%...%') on the fields users look records up by.
-- Every column that is marked searchable needs a trigram index, otherwise the
-- global/in-field search OR forces a full sequential scan of the whole table.
-- These need the pg_trgm extension. On managed hosts where it isn't allow-listed
-- (e.g. Azure unless you add PG_TRGM to azure.extensions) we skip them rather than
-- failing the install — search still works, just without index acceleration.
DO $trgm$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
        CREATE INDEX IF NOT EXISTS ix_ff_device_name_trgm  ON fact_findings USING GIN (device_name gin_trgm_ops);
        CREATE INDEX IF NOT EXISTS ix_ff_computer_trgm     ON fact_findings USING GIN (computer_name gin_trgm_ops);
        CREATE INDEX IF NOT EXISTS ix_ff_cve_trgm          ON fact_findings USING GIN (cve gin_trgm_ops);
        CREATE INDEX IF NOT EXISTS ix_ff_asset_trgm        ON fact_findings USING GIN (asset_id gin_trgm_ops);
        CREATE INDEX IF NOT EXISTS ix_ff_detection_trgm    ON fact_findings USING GIN (detection_id gin_trgm_ops);
        CREATE INDEX IF NOT EXISTS ix_ff_device_ip_trgm    ON fact_findings USING GIN (device_ip_address gin_trgm_ops);
        CREATE INDEX IF NOT EXISTS ix_ff_details_trgm      ON fact_findings USING GIN (details gin_trgm_ops);
        CREATE INDEX IF NOT EXISTS ix_ff_comments_trgm     ON fact_findings USING GIN (comments gin_trgm_ops);
  ELSE
    RAISE WARNING 'pg_trgm not installed — skipping text-search indexes (search will be slower).';
  END IF;
END $trgm$;

-- =====================================================================
--  OPTIONAL — only if this table will hold many millions of rows.
--  Native range partitioning by first_found_date keeps each partition
--  small and sync/queries fast. Leave commented unless you need it;
--  it changes the primary key and how the sync inserts rows.
-- =====================================================================
-- (Ask and I'll generate the partitioned version + monthly partitions.)

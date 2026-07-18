-- =====================================================================
--  Dataset registry — "one pipe per data type"
--
--  A dataset pairs ONE source table (the flat Archer reporting feed in
--  MS SQL) with ONE target table in this Postgres database. That pairing is
--  why the sync never has to work out where a record belongs: each pipe only
--  ever connects those two tables.
--
--      dbo.ArcherFindingsFeed  ->  fact_findings
--      dbo.ArcherDevicesFeed   ->  ds_devices
--
--  dataset.key matches field_mapping.source and sync_state.source, so the
--  mapping/sync work already done slots straight in.
--
--  Idempotent: safe to re-run.
-- =====================================================================

CREATE TABLE IF NOT EXISTS dataset (
    id               SERIAL PRIMARY KEY,
    key              TEXT NOT NULL UNIQUE,          -- 'archer-findings', 'devices'
    name             TEXT NOT NULL,                 -- 'Vulnerability Findings'
    description      TEXT,
    source_table     TEXT,                          -- MS SQL flat feed, e.g. 'dbo.ArcherDevicesFeed'
    target_table     TEXT NOT NULL UNIQUE,          -- our table, e.g. 'ds_devices'
    key_column       TEXT NOT NULL DEFAULT 'ContentId',   -- unique record id -> upsert key
    watermark_column TEXT,                          -- e.g. 'LastUpdated' -> incremental sync
    is_active        BOOLEAN NOT NULL DEFAULT TRUE,
    is_protected     BOOLEAN NOT NULL DEFAULT FALSE, -- built-in; cannot be deleted from the UI
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

/* The blueprint for the target table AND the catalog that drives charts,
   filters and record columns for this dataset. */
CREATE TABLE IF NOT EXISTS dataset_field (
    id            SERIAL PRIMARY KEY,
    dataset_id    INTEGER NOT NULL REFERENCES dataset(id) ON DELETE CASCADE,
    key           TEXT NOT NULL,        -- our column name, e.g. 'device_name'
    label         TEXT NOT NULL,        -- 'Device Name'
    data_type     TEXT NOT NULL,        -- text|integer|number|date|timestamp|boolean|json
    is_dimension  BOOLEAN NOT NULL DEFAULT FALSE, -- usable as chart X-axis / Group By
    is_measurable BOOLEAN NOT NULL DEFAULT FALSE, -- numeric -> can be summed/averaged
    is_searchable BOOLEAN NOT NULL DEFAULT FALSE, -- included in global search
    is_enabled    BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order    INTEGER NOT NULL DEFAULT 0,
    UNIQUE (dataset_id, key)
);

CREATE INDEX IF NOT EXISTS ix_dataset_field_ds ON dataset_field (dataset_id);

-- Permission for Admin Panel -> Data Sources
INSERT INTO permissions (code, description)
VALUES ('admin:datasets:manage', 'Register datasets and define their fields')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.name = 'admin' AND p.code = 'admin:datasets:manage'
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------
-- Retrofit the existing findings data as dataset #1, so it stops being a
-- special case and becomes "just another dataset".
-- ---------------------------------------------------------------------
INSERT INTO dataset (key, name, description, source_table, target_table, key_column, watermark_column, is_protected)
VALUES ('archer-findings', 'Vulnerability Findings',
        'Archer vulnerability findings, via the flat reporting feed',
        'dbo.ArcherFindingsFeed', 'fact_findings', 'ContentId', 'LastUpdated', TRUE)
ON CONFLICT (key) DO NOTHING;

-- Its fields are read straight from the live table, so the registry always
-- matches reality rather than a hand-typed list.
INSERT INTO dataset_field (dataset_id, key, label, data_type, is_dimension, is_measurable, is_searchable, sort_order)
SELECT d.id,
       c.column_name,
       initcap(replace(c.column_name, '_', ' ')),
       CASE c.data_type
           WHEN 'text'                        THEN 'text'
           WHEN 'bigint'                      THEN 'integer'
           WHEN 'integer'                     THEN 'integer'
           WHEN 'numeric'                     THEN 'number'
           WHEN 'date'                        THEN 'date'
           WHEN 'timestamp with time zone'    THEN 'timestamp'
           WHEN 'boolean'                     THEN 'boolean'
           WHEN 'jsonb'                       THEN 'json'
           ELSE 'text'
       END,
       c.column_name <> 'record_id',   -- every field usable on a chart X axis / compare (record_id is meaningless to group by)
       c.column_name IN ('days_open'),
       c.column_name IN ('record_id','device_name','computer_name','cve','asset_id','detection_id',
                         'device_ip_address','details','comments'),
       c.ordinal_position
FROM information_schema.columns c
CROSS JOIN dataset d
WHERE c.table_name = 'fact_findings'
  AND d.key = 'archer-findings'
  AND c.column_name <> 'synced_at'          -- housekeeping, not an Archer field
ON CONFLICT (dataset_id, key) DO NOTHING;

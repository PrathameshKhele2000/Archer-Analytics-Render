-- =====================================================================
--  Per-dataset sync state + history
--
--  One row per pipe. The scheduler syncs every active dataset that has a
--  source_table; each run reads only rows whose watermark is newer than
--  last_watermark, so a daily run costs the changes, not the whole table.
--
--  Idempotent: safe to re-run.
-- =====================================================================

CREATE TABLE IF NOT EXISTS dataset_sync_state (
    dataset_key    TEXT PRIMARY KEY,
    last_status    TEXT NOT NULL DEFAULT 'never',   -- never | running | ok | error
    last_run_at    TIMESTAMPTZ,
    last_watermark TIMESTAMPTZ,                     -- newest source row pulled so far
    rows_synced    BIGINT NOT NULL DEFAULT 0,
    last_error     TEXT,
    duration_ms    INTEGER
);

CREATE TABLE IF NOT EXISTS dataset_sync_history (
    id           SERIAL PRIMARY KEY,
    dataset_key  TEXT NOT NULL,
    run_type     TEXT NOT NULL,                     -- incremental | full
    status       TEXT NOT NULL,                     -- ok | error
    rows_synced  BIGINT NOT NULL DEFAULT 0,
    error_detail TEXT,
    started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at  TIMESTAMPTZ,
    duration_ms  INTEGER
);

CREATE INDEX IF NOT EXISTS ix_dataset_sync_history_key ON dataset_sync_history (dataset_key, started_at DESC);

-- Every registered dataset starts as 'never synced' — honest by default.
INSERT INTO dataset_sync_state (dataset_key)
SELECT key FROM dataset
ON CONFLICT (dataset_key) DO NOTHING;

-- Clear any leftover row from the retired demo sync (the table only exists on
-- installs that predate the dataset pipes).
DO $$ BEGIN
  IF to_regclass('sync_state') IS NOT NULL THEN DELETE FROM sync_state; END IF;
END $$;

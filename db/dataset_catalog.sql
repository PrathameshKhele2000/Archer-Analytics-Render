-- =====================================================================
--  Dataset measures — the last hand-written piece of the catalog.
--
--  Most measures are generated automatically from dataset_field:
--      count                      -> count(*)
--      sum_/avg_/min_/max_<field> -> for every field flagged is_measurable
--
--  But some are business rules that can't be inferred, e.g. "Open findings"
--  = count(*) FILTER (WHERE closed_date IS NULL). Those live here.
--
--  Defined structurally (agg + field + filter), never as raw SQL, so a
--  measure can never be used to inject.
--
--  Idempotent: safe to re-run.
-- =====================================================================

CREATE TABLE IF NOT EXISTS dataset_measure (
    id           SERIAL PRIMARY KEY,
    dataset_id   INTEGER NOT NULL REFERENCES dataset(id) ON DELETE CASCADE,
    key          TEXT NOT NULL,                 -- 'open_count'
    label        TEXT NOT NULL,                 -- 'Open findings'
    agg          TEXT NOT NULL,                 -- count | sum | avg | min | max
    field_key    TEXT,                          -- NULL for count(*)
    filter_field TEXT,                          -- optional: restrict the aggregate
    filter_mode  TEXT,                          -- is_null | is_not_null
    sort_order   INTEGER NOT NULL DEFAULT 0,
    UNIQUE (dataset_id, key)
);

CREATE INDEX IF NOT EXISTS ix_dataset_measure_ds ON dataset_measure (dataset_id);

-- The two findings measures that are business rules, not derivable from a field.
INSERT INTO dataset_measure (dataset_id, key, label, agg, field_key, filter_field, filter_mode, sort_order)
SELECT d.id, m.key, m.label, m.agg, NULL, m.filter_field, m.filter_mode, m.sort_order
FROM dataset d
JOIN (VALUES
    ('open_count',   'Open findings',   'count', 'closed_date', 'is_null',     1),
    ('closed_count', 'Closed findings', 'count', 'closed_date', 'is_not_null', 2)
) AS m(key, label, agg, filter_field, filter_mode, sort_order) ON TRUE
WHERE d.key = 'archer-findings'
ON CONFLICT (dataset_id, key) DO NOTHING;

-- Which field a records list sorts by (newest-first). Generic datasets fall back to record_id.
ALTER TABLE dataset ADD COLUMN IF NOT EXISTS default_sort_field TEXT;
UPDATE dataset SET default_sort_field = 'first_found_date' WHERE key = 'archer-findings';

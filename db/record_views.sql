-- =====================================================================
--  Record Views ("folders" in the Records tab)
--
--  A View is a SAVED RULE, not a container: name + preset filter + chosen
--  columns + role access. Because it's a rule, it stays correct after every
--  Archer sync, and one record naturally appears in every view it matches.
--
--  base_conditions/base_logic are the preset scope. They are ANDed with
--  whatever the user filters/searches on top, and cannot be removed by them.
--
--  Idempotent: safe to re-run.
-- =====================================================================

ALTER TABLE reports ADD COLUMN IF NOT EXISTS base_conditions JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS base_logic      TEXT;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS sort_order      INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS dataset_key     TEXT NOT NULL DEFAULT 'archer-findings';
ALTER TABLE reports ADD COLUMN IF NOT EXISTS row_limit       INTEGER;

COMMENT ON COLUMN reports.row_limit IS
  'Rows to show: NULL = all matching rows; N = only the top N in the view''s sort order.';

COMMENT ON COLUMN reports.dataset_key IS
  'Which dataset this view reads — its columns, filters and pick-lists come from that dataset''s catalog.';

COMMENT ON COLUMN reports.base_conditions IS
  'Preset filter conditions defining this view''s scope (ANDed with the user''s own filters).';
COMMENT ON COLUMN reports.base_logic IS
  'Optional logic expression over base_conditions, e.g. "1 AND (2 OR 3)". Empty = AND all.';

-- The full register stays first in the Records list.
UPDATE reports SET sort_order = 0 WHERE key = 'findings-register';

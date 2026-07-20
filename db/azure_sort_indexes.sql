-- =====================================================================
--  Records-list SORT indexes — plain btree, NO extensions required.
--  Safe to run on Azure Database for PostgreSQL even when pg_trgm is
--  not allow-listed. Idempotent: re-run any time.
--
--    psql "$AZ" -f db/azure_sort_indexes.sql
--
--  On 10M rows this takes several minutes and ~5 GB. It turns a column
--  sort from a full-table sort (7.6 s) into an Index Only Scan (~13 ms).
-- =====================================================================
CREATE INDEX IF NOT EXISTS ix_ff_sort_first_found   ON fact_findings (first_found_date, record_id);
CREATE INDEX IF NOT EXISTS ix_ff_sort_closed_date   ON fact_findings (closed_date, record_id);
CREATE INDEX IF NOT EXISTS ix_ff_sort_last_updated  ON fact_findings (last_updated, record_id);
CREATE INDEX IF NOT EXISTS ix_ff_sort_days_open     ON fact_findings (days_open, record_id);
CREATE INDEX IF NOT EXISTS ix_ff_sort_priority      ON fact_findings (priority, record_id);
CREATE INDEX IF NOT EXISTS ix_ff_sort_age           ON fact_findings (age, record_id);
CREATE INDEX IF NOT EXISTS ix_ff_sort_device_status ON fact_findings (device_status, record_id);
CREATE INDEX IF NOT EXISTS ix_ff_sort_record_status ON fact_findings (record_status, record_id);
CREATE INDEX IF NOT EXISTS ix_ff_sort_cve_type      ON fact_findings (cve_type, record_id);
CREATE INDEX IF NOT EXISTS ix_ff_sort_device_name   ON fact_findings (device_name, record_id);
CREATE INDEX IF NOT EXISTS ix_ff_sort_cve           ON fact_findings (cve, record_id);
ANALYZE fact_findings;
SELECT count(*) || ' sort indexes present (expect 11)' AS result
  FROM pg_indexes WHERE tablename = 'fact_findings' AND indexname LIKE 'ix_ff_sort%';

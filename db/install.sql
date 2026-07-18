-- =====================================================================
--  Archer Analytics — FULL INSTALL (run this, in this order)
--
--    createdb archer_analytics
--    psql "postgresql://user:pass@host:5432/archer_analytics" -f db/install.sql
--
--  Idempotent: safe to re-run on an existing database.
--  Order matters — datasets.sql reads fact_findings' real columns to register
--  its fields, so the findings schema must exist first.
--
--  This installs an EMPTY system: no sample data. Data arrives via the
--  automatic sync once MSSQL_* is configured and a dataset points at a feed.
--  (For a demo with fake rows, run db/seed_findings_sample.sql afterwards.)
-- =====================================================================
\set ON_ERROR_STOP on

\echo '==> 1/7 platform (users, roles, dashboards, reports, audit)'
\ir init.sql

\echo '==> 2/7 findings dataset schema (the 48 Archer fields)'
\ir archer_findings_schema.sql

\echo '==> 3/7 Archer -> column field mapping'
\ir field_mapping.sql

\echo '==> 4/7 dataset registry (the pipes) + findings retrofit'
\ir datasets.sql

\echo '==> 5/7 dataset measures + default sort'
\ir dataset_catalog.sql

\echo '==> 6/7 record views (folders)'
\ir record_views.sql

\echo '==> 7/7 sync state + overview dashboard'
\ir dataset_sync.sql
\ir overview_dashboard.sql

\echo ''
\echo 'Install complete. Next:'
\echo '  1. Set MSSQL_HOST/DATABASE/USER/PASSWORD in .env (read-only account)'
\echo '  2. Admin -> Data Sources: point the findings dataset at your real feed table'
\echo '  3. Admin -> Field Mapping: Auto-map, fix leftovers, Save'
\echo '  4. The sync then runs automatically (SYNC_INTERVAL_MINUTES)'

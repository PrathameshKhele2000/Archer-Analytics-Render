-- Runs on the Postgres container's FIRST start (docker-entrypoint-initdb.d).
-- Delegates to the full ordered installer; the db/ folder is mounted at /opt/archer-db.
\i /opt/archer-db/install.sql

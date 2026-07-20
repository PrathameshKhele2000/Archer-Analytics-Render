#!/usr/bin/env bash
# =====================================================================
#  Diagnose "search doesn't work / charts show wrong data" on Azure.
#  Checks the DATA + CONFIG, not just speed.
#
#    export AZ="postgresql://...?sslmode=require"
#    bash scripts/azure-data-health.sh
# =====================================================================
AZ="${AZ:-postgresql://archeradmin:Khele%402000@archer-analytics-postgres.postgres.database.azure.com:5432/azure_postgres?sslmode=require}"

echo "=============== 1. CHART MATERIALIZED VIEWS (stale = wrong/empty charts) ==============="
psql "$AZ" -c "
SELECT m.matviewname,
       (SELECT count(*) FROM pg_class c WHERE c.relname = m.matviewname AND c.relispopulated) AS populated,
       pg_size_pretty(pg_total_relation_size(m.matviewname::regclass))                        AS size
FROM pg_matviews m ORDER BY 1;" 2>&1 | head -20
echo "  ^ if a chart matview is tiny/empty while fact_findings has 10M rows, it is STALE."

echo
echo "=============== 2. SEARCH CONFIG (which columns are searchable?) ==============="
psql "$AZ" -c "
SELECT d.key AS dataset,
       count(*) FILTER (WHERE f.is_searchable) AS searchable_cols,
       count(*) FILTER (WHERE f.is_dimension)  AS chartable_cols,
       count(*)                                AS total_cols
FROM dataset d JOIN dataset_field f ON f.dataset_id = d.id
GROUP BY d.key ORDER BY 1;" 2>&1 | head -10
echo "  ^ searchable_cols = 0 means global search can never match anything."

echo
echo "=============== 3. LIVE SEARCH TEST (does the SQL actually return rows?) ==============="
psql "$AZ" -c "\timing on" -c "
SELECT count(*) AS matches FROM fact_findings
WHERE device_name ILIKE '%SRV%' OR cve ILIKE '%CVE-2021%';" 2>&1 | grep -E "matches|^-|[0-9]|Time:" | head -5

echo
echo "=============== 4. CHART SOURCE DATA (do aggregates return rows?) ==============="
psql "$AZ" -c "SELECT age, count(*) FROM fact_findings GROUP BY age ORDER BY 2 DESC LIMIT 5;" 2>&1 | head -9

echo
echo "=============== 5. DASHBOARD WIDGETS + their dataset ==============="
psql "$AZ" -c "
SELECT w.id, w.title, w.widget_type, w.config->>'dataset' AS dataset, w.config->>'dimension' AS dimension
FROM dashboard_widgets w ORDER BY w.id;" 2>&1 | head -15

echo
echo "=============== 6. PICK-LIST VALUES (drive filter dropdowns) ==============="
psql "$AZ" -c "SELECT dataset_key, field_key, count(*) AS values FROM dropdown_option GROUP BY 1,2 ORDER BY 1,2;" 2>&1 | head -12

echo
echo "=============== FIX: refresh stale chart matviews ==============="
echo "If section 1 showed stale/empty matviews, run:"
echo "  psql \"\$AZ\" -c \"DO \\\$\\\$ DECLARE mv record; BEGIN FOR mv IN SELECT matviewname FROM pg_matviews LOOP EXECUTE format('REFRESH MATERIALIZED VIEW %I', mv.matviewname); END LOOP; END \\\$\\\$;\""

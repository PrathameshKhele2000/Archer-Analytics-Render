#!/usr/bin/env bash
# Quick post-fix verification. Usage:  bash scripts/azure-verify.sh
AZ="${AZ:-postgresql://archeradmin:Khele%402000@archer-analytics-postgres.postgres.database.azure.com:5432/azure_postgres?sslmode=require}"

echo "=================== INDEXES ==================="
psql "$AZ" -tAc "select count(*) from pg_indexes where tablename='fact_findings' and indexname like 'ix_ff_sort%'" | sed 's/^/  sort indexes (need 11):    /'
psql "$AZ" -tAc "select count(*) from pg_indexes where tablename='fact_findings' and indexname like '%trgm%'"      | sed 's/^/  search indexes (need 8):   /'
psql "$AZ" -tAc "select count(*) from pg_extension where extname='pg_trgm'"                                        | sed 's/^/  pg_trgm installed (need 1):/'

echo
echo "=================== QUERY SPEED (10M rows) ==================="
echo "-- default Records page (target: well under 1s)"
psql "$AZ" -c "\timing on" -c "select record_id from fact_findings order by first_found_date desc, record_id desc limit 25" 2>&1 | grep '^Time:' | sed 's/^/  /'
echo "-- sort by a column (was 7.6s without the index)"
psql "$AZ" -c "\timing on" -c "select record_id from fact_findings order by priority desc, record_id desc limit 25" 2>&1 | grep '^Time:' | sed 's/^/  /'
echo "-- sort by device_name"
psql "$AZ" -c "\timing on" -c "select record_id from fact_findings order by device_name asc, record_id asc limit 25" 2>&1 | grep '^Time:' | sed 's/^/  /'
echo "-- global search (fast only if pg_trgm indexes exist)"
psql "$AZ" -c "\timing on" -c "select count(*) from (select 1 from fact_findings where device_name ilike '%SRV-58213%' limit 10001) x" 2>&1 | grep '^Time:' | sed 's/^/  /'
echo "-- is the sort actually using an index? (want: Index Only Scan, NOT Sort)"
psql "$AZ" -c "explain select record_id from fact_findings order by priority desc, record_id desc limit 25" 2>&1 | grep -E "Index|Sort|Scan" | head -3 | sed 's/^/  /'

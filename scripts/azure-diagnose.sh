#!/usr/bin/env bash
# =====================================================================
#  Azure slowness diagnostic. Fill in the two URLs + connection string,
#  then run:  bash scripts/azure-diagnose.sh
#  Paste the whole output back.
# =====================================================================

# ---- FILL THESE IN ----
BACKEND="https://<your-backend>.azurewebsites.net"        # API app service
FRONTEND="https://<your-frontend>.azurestaticapps.net"    # or its app service
AZ="postgresql://archeradmin:Khele%402000@archer-analytics-postgres.postgres.database.azure.com:5432/azure_postgres?sslmode=require"
EMAIL="admin@example.com"
PASSWORD="ChangeMe123!"
# -----------------------

echo "==================== 1. DATABASE ===================="
echo "-- reachable? (should print 1 in well under a second)"
time psql "$AZ" -tc "select 1" 2>&1 | head -3

echo
echo "-- how many rows? (index gains only matter if this is large)"
psql "$AZ" -tc "select 'fact_findings rows: '||count(*) from fact_findings" 2>&1 | head -2

echo
echo "-- did the performance indexes get created?"
psql "$AZ" -tc "select count(*)||' sort indexes present (expect 11)' from pg_indexes where tablename='fact_findings' and indexname like 'ix_ff_sort%'" 2>&1 | head -2

echo
echo "-- is a records page fast at the DB level?"
psql "$AZ" -c "\timing on" -c "select record_id from fact_findings order by first_found_date desc, record_id desc limit 25" 2>&1 | grep -E "^Time:"

echo
echo "==================== 2. BACKEND API ===================="
echo "-- health (pure network+app latency, no DB)"
curl -s -o /dev/null -w "   health:   %{time_total}s  (http %{http_code})\n" "$BACKEND/api/health"

echo "-- login (first real DB round trip)"
TOK=$(curl -s -X POST "$BACKEND/api/auth/login" -H 'Content-Type: application/json' \
      -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" \
      -w "\n   login:    %{time_total}s  (http %{http_code})\n" | tee /dev/stderr \
      | head -1 | python3 -c "import sys,json;print(json.load(sys.stdin).get('accessToken',''))" 2>/dev/null)

if [ -n "$TOK" ]; then
  echo "-- records page (the real query)"
  curl -s -o /dev/null -w "   records:  %{time_total}s\n" \
    "$BACKEND/api/reports/findings-register/data?page=1&size=25" -H "Authorization: Bearer $TOK"
  echo "-- is gzip compression active? (expect: content-encoding: gzip)"
  curl -s -o /dev/null -D - -H "Accept-Encoding: gzip" -H "Authorization: Bearer $TOK" \
    "$BACKEND/api/reports/findings-register/data?page=1&size=100" | grep -i "content-encoding" | sed 's/^/   /'
else
  echo "   !! login failed — cannot test authenticated endpoints"
fi

echo
echo "==================== 3. FRONTEND ===================="
echo "-- is the code-split bundle deployed? (expect separate small index + big echarts chunk)"
curl -s "$FRONTEND" | grep -oE '/assets/[a-zA-Z0-9._-]+\.js' | sort -u | sed 's/^/   /'
curl -s -o /dev/null -w "   page load: %{time_total}s  (http %{http_code})\n" "$FRONTEND"

echo
echo "==================== DONE ===================="

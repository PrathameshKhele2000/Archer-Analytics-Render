#!/usr/bin/env bash
#
# setup-local.sh — create the archer_analytics database and apply the schema
# against a plain PostgreSQL (no Docker). Idempotent: safe to re-run.
#
# Uses standard libpq env vars if set; otherwise sensible local defaults.
#   PGHOST (localhost)  PGPORT (5432)  PGUSER ($USER)  PGPASSWORD (unset)
#   DB_NAME (archer_analytics)
#
# Examples:
#   ./scripts/setup-local.sh
#   PGHOST=db.example.com PGUSER=postgres PGPASSWORD=secret ./scripts/setup-local.sh
#
set -euo pipefail

PGHOST="${PGHOST:-localhost}"
PGPORT="${PGPORT:-5432}"
PGUSER="${PGUSER:-${USER}}"
DB_NAME="${DB_NAME:-archer_analytics}"
export PGHOST PGPORT PGUSER
[ -n "${PGPASSWORD:-}" ] && export PGPASSWORD

# Resolve the repo root so the script works from anywhere.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
INIT_SQL="${ROOT_DIR}/db/init.sql"

command -v psql >/dev/null 2>&1 || {
  echo "error: psql not found. Install PostgreSQL client tools first." >&2
  exit 1
}
[ -f "${INIT_SQL}" ] || { echo "error: ${INIT_SQL} not found." >&2; exit 1; }

echo "→ Target: postgresql://${PGUSER}@${PGHOST}:${PGPORT}/${DB_NAME}"

# Verify we can reach the server (connect to the default 'postgres' db).
if ! psql -d postgres -tAc "SELECT 1" >/dev/null 2>&1; then
  echo "error: cannot connect to PostgreSQL at ${PGHOST}:${PGPORT} as ${PGUSER}." >&2
  echo "       Set PGHOST/PGPORT/PGUSER/PGPASSWORD as needed and retry." >&2
  exit 1
fi

# Create the database if it doesn't already exist.
if psql -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1; then
  echo "→ Database '${DB_NAME}' already exists — reusing it."
else
  echo "→ Creating database '${DB_NAME}'..."
  createdb "${DB_NAME}"
fi

# Apply the schema (all CREATE ... IF NOT EXISTS / idempotent statements).
echo "→ Applying schema from db/init.sql..."
psql -d "${DB_NAME}" -v ON_ERROR_STOP=1 -f "${INIT_SQL}" >/dev/null
echo "→ Schema applied."

# Quick confirmation.
COUNT=$(psql -d "${DB_NAME}" -tAc "SELECT count(*) FROM fact_findings" 2>/dev/null || echo "0")
echo "→ fact_findings currently holds ${COUNT} row(s) (0 is expected before the first sync)."

cat <<EOF

✓ Database ready.

Next steps:

  1. Backend:
       cd backend && npm install
       DATABASE_URL="postgresql://${PGUSER}@${PGHOST}:${PGPORT}/${DB_NAME}" \\
       MOCK_MODE=true JWT_SECRET=change-me JWT_REFRESH_SECRET=change-me-too \\
       npm run start:dev

  2. Frontend (new terminal):
       cd frontend && npm install && npm run dev
       # open http://localhost:5173  (admin@example.com / ChangeMe123!)

  (Redis is optional — add REDIS_URL=redis://localhost:6379/0 to enable caching.)
EOF

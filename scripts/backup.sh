#!/bin/bash
# Deckgauge — Full backup script
#
# Backs up:
#   1. Postgres (pg_dump — transactionally consistent, no downtime)
#   2. ClickHouse (table-by-table export via HTTP — consistent reads with FINAL)
#   3. Uploads volume (file attachments)
#
# Output: ./backups/vp-cockpit-backup-YYYYMMDD-HHMMSS.tar.gz
#
# Usage:
#   ./scripts/backup.sh                        # timestamped backup in ./backups/
#   ./scripts/backup.sh --dest /path/to/dir   # custom destination directory
#   ./scripts/backup.sh --tag my-label         # use a custom label instead of timestamp
#   ./scripts/backup.sh --stack next           # target a second, parallel stack
#
# `--stack main` (the default) assumes the compose project is named
# `vp-cockpit` — docker-compose.yml declares no project `name:`, so the project
# is really named after the directory you cloned into. If yours differs, set
# COMPOSE_PROJECT_NAME and UPLOADS_VOLUME to match, or the script will look for
# containers and a volume that don't exist. `--stack next` targets a second
# stack alongside it and needs an overlay file not present in every checkout.
#
# COMPOSE_PROJECT_NAME, PG_CONTAINER, KC_DB_CONTAINER, API_CONTAINER,
# UPLOADS_VOLUME and CH_PORT all take precedence over the --stack preset.
#
# Restore with: ./scripts/restore.sh <backup-file.tar.gz>

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_ROOT"

# Published host ports from .env, defaults where unset.
DG_PROJECT_ROOT="$PROJECT_ROOT"
# shellcheck source=lib/staging-ports.sh
source "$PROJECT_ROOT/scripts/lib/staging-ports.sh"

# ─── Args ────────────────────────────────────────────────────────────────────
DEST_DIR="$PROJECT_ROOT/backups"
TAG="$(date +%Y%m%d-%H%M%S)"
STACK="main"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dest)  DEST_DIR="$2"; shift 2 ;;
    --tag)   TAG="$2";      shift 2 ;;
    --stack) STACK="$2";    shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

# ─── Stack configuration ────────────────────────────────────────────────────
# `--stack` selects which docker compose project to target. Env-var overrides
# (e.g. CH_PORT=xxxx ./scripts/backup.sh) still take precedence.
case "$STACK" in
  main)
    : "${COMPOSE_PROJECT_NAME:=vp-cockpit}"
    # CH_PORT is a HOST port, so it follows CLICKHOUSE_HTTP_PORT out of .env
    # when this stack has been moved off the defaults. `--stack next` keeps its
    # literal: that overlay hardcodes 8124 and reads no .env.
    : "${CH_PORT:=${CLICKHOUSE_HTTP_PORT}}"
    : "${PG_CONTAINER:=vp-cockpit-postgres}"
    : "${KC_DB_CONTAINER:=vp-cockpit-keycloak-db}"
    : "${API_CONTAINER:=vp-cockpit-api}"
    : "${UPLOADS_VOLUME:=vp-cockpit_uploads_data}"
    ;;
  next)
    : "${COMPOSE_PROJECT_NAME:=vp-cockpit-next}"
    : "${CH_PORT:=8124}"
    : "${PG_CONTAINER:=vp-cockpit-next-postgres}"
    : "${KC_DB_CONTAINER:=vp-cockpit-next-keycloak-db}"
    : "${API_CONTAINER:=vp-cockpit-next-api}"
    : "${UPLOADS_VOLUME:=vp-cockpit-next_uploads_data}"
    ;;
  *)
    echo "Unknown --stack: $STACK (expected: main, next)" >&2
    exit 1
    ;;
esac
export COMPOSE_PROJECT_NAME

# ─── Credentials ────────────────────────────────────────────────────────────
PG_USER="${POSTGRES_USER:-cockpit}"
PG_DB="${POSTGRES_DB:-cockpit}"
KC_DB_USER="${KEYCLOAK_DB_USER:-keycloak}"
KC_DB_NAME="${KEYCLOAK_DB_NAME:-keycloak}"
CH_USER="${CLICKHOUSE_USER:-cockpit}"
CH_PASS="${CLICKHOUSE_PASSWORD:-cockpit}"
# 127.0.0.1, not "localhost": a hosted box sets BIND_HOST=127.0.0.1: which
# publishes IPv4 loopback ONLY — [::1] is not published at all. On a dual-stack
# host "localhost" can resolve ::1 first, and while curl should walk the address
# list to the working one, naming the address that is actually bound removes the
# question. Nothing is lost locally, where both resolve to the same daemon.
CH_HOST="127.0.0.1"
CH_DB="cockpit"

BACKUP_NAME="vp-cockpit-backup-${TAG}"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

mkdir -p "$DEST_DIR"

# ─── Colours ─────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m'
log_step() { echo -e "${GREEN}▶${NC} $1"; }
log_info() { echo -e "${YELLOW}·${NC} $1"; }
log_fail() { echo -e "${RED}✗${NC} $1" >&2; }

# ─── Helpers ─────────────────────────────────────────────────────────────────
ch_export_table() {
  local table="$1"
  local dest="$2"
  # FINAL forces deduplication in ReplacingMergeTree before export
  curl -sf --max-time 300 \
    "http://${CH_USER}:${CH_PASS}@${CH_HOST}:${CH_PORT}/" \
    --data "SELECT * FROM ${CH_DB}.${table} FINAL FORMAT Native" \
    | gzip > "${dest}"
  local rows
  rows=$(curl -sf --max-time 30 \
    "http://${CH_USER}:${CH_PASS}@${CH_HOST}:${CH_PORT}/" \
    --data "SELECT count() FROM ${CH_DB}.${table} FINAL")
  echo "$rows"
}

# ─────────────────────────────────────────────────────────────────────────────
# Preflight: verify services are running
# ─────────────────────────────────────────────────────────────────────────────
log_step "Preflight checks..."

check_running() {
  local container="$1"
  local human="$2"
  local running
  running=$(docker inspect --format '{{.State.Running}}' "$container" 2>/dev/null || echo "false")
  if [ "$running" != "true" ]; then
    log_fail "$human container '$container' is not running."
    exit 1
  fi
}

check_running "$PG_CONTAINER"      "Postgres"
check_running "$KC_DB_CONTAINER"   "Keycloak DB"
check_running "$API_CONTAINER"     "API (for uploads volume access)"
# ClickHouse uses HTTP check below (HTTP is the API we'll actually be hitting)
if ! curl -sf --max-time 5 "http://${CH_USER}:${CH_PASS}@${CH_HOST}:${CH_PORT}/" --data "SELECT 1" > /dev/null; then
  log_fail "ClickHouse not reachable at ${CH_HOST}:${CH_PORT}."
  exit 1
fi

# ─────────────────────────────────────────────────────────────────────────────
# 1. Postgres backup (pg_dump)
# ─────────────────────────────────────────────────────────────────────────────
log_step "Backing up Postgres..."
docker exec -i "$PG_CONTAINER" \
  pg_dump -U "$PG_USER" --format=custom --compress=6 "$PG_DB" \
  > "$WORK_DIR/postgres.pgdump"
PG_SIZE=$(du -sh "$WORK_DIR/postgres.pgdump" | cut -f1)
log_info "Postgres: $PG_SIZE"

# ─────────────────────────────────────────────────────────────────────────────
# 1b. Keycloak DB backup (pg_dump from keycloak-db container)
# ─────────────────────────────────────────────────────────────────────────────
log_step "Backing up Keycloak DB..."
docker exec -i "$KC_DB_CONTAINER" \
  pg_dump -U "$KC_DB_USER" --format=custom --compress=6 "$KC_DB_NAME" \
  > "$WORK_DIR/keycloak.pgdump"
KC_SIZE=$(du -sh "$WORK_DIR/keycloak.pgdump" | cut -f1)
log_info "Keycloak DB: $KC_SIZE"

# ─────────────────────────────────────────────────────────────────────────────
# 2. ClickHouse backup (table-by-table, Native format + gzip)
# ─────────────────────────────────────────────────────────────────────────────
log_step "Backing up ClickHouse tables..."
mkdir -p "$WORK_DIR/clickhouse"

# Which tables to export is asked of the SERVER, not hardcoded here.
#
# This list used to be a literal array, and it had silently fallen behind the
# schema: ado_deployments (21,426 rows of DORA deploy data on staging) was absent
# from both this script and restore.sh, so it was neither backed up nor
# restorable. ADO history backfill is opt-in and forward watermarks cannot heal a
# gap, so that data was not necessarily re-syncable either. A backup whose
# coverage depends on someone remembering to edit an array is not a backup.
#
# Any MergeTree-family table in the database is included, which means a table
# added by a future migration is covered the day it appears. _ch_migrations is
# included deliberately: restoring the ledger keeps a restored database from
# re-applying schema files it already has.
CH_TABLE_QUERY="SELECT name FROM system.tables WHERE database='${CH_DB}' AND engine LIKE '%MergeTree%' ORDER BY name FORMAT TSV"
CH_TABLES=()
while IFS= read -r line; do
  [ -n "$line" ] && CH_TABLES+=("$line")
done < <(curl -sf --max-time 30 "http://${CH_USER}:${CH_PASS}@${CH_HOST}:${CH_PORT}/" --data "$CH_TABLE_QUERY")

# Fail loudly. A backup that silently captures zero tables is worse than one that
# refuses to run, because it looks like success until the day it is needed.
if [ ${#CH_TABLES[@]} -eq 0 ]; then
  log_fail "Could not enumerate ClickHouse tables in '${CH_DB}' — refusing to write a backup that may be empty."
  exit 1
fi
log_info "  ${#CH_TABLES[@]} ClickHouse tables to export (enumerated from the server)"

TOTAL_CH_ROWS=0
for table in "${CH_TABLES[@]}"; do
  # Check if table exists before trying to export
  exists=$(curl -sf --max-time 10 \
    "http://${CH_USER}:${CH_PASS}@${CH_HOST}:${CH_PORT}/" \
    --data "SELECT count() FROM system.tables WHERE database='${CH_DB}' AND name='${table}'" \
    2>/dev/null || echo "0")
  if [ "$exists" = "0" ]; then
    log_info "  skipping $table (table does not exist yet)"
    continue
  fi
  rows=$(ch_export_table "$table" "$WORK_DIR/clickhouse/${table}.native.gz")
  TOTAL_CH_ROWS=$((TOTAL_CH_ROWS + rows))
  log_info "  $table: $rows rows"
done

CH_SIZE=$(du -sh "$WORK_DIR/clickhouse" | cut -f1)
log_info "ClickHouse total: $TOTAL_CH_ROWS rows, $CH_SIZE compressed"

# ─────────────────────────────────────────────────────────────────────────────
# 3. Uploads volume backup
# ─────────────────────────────────────────────────────────────────────────────
log_step "Backing up uploads volume..."
docker run --rm \
  --volumes-from "$API_CONTAINER" \
  -v "$WORK_DIR":/backup \
  alpine:3.19 \
  tar czf /backup/uploads.tar.gz -C /app/uploads . 2>/dev/null || {
    # Fallback: direct volume mount
    docker run --rm \
      -v "$UPLOADS_VOLUME":/data \
      -v "$WORK_DIR":/backup \
      alpine:3.19 \
      tar czf /backup/uploads.tar.gz -C /data . 2>/dev/null || {
        log_info "  Uploads volume empty or not yet created — creating empty archive."
        tar czf "$WORK_DIR/uploads.tar.gz" -T /dev/null 2>/dev/null || true
      }
  }
UPLOADS_SIZE=$(du -sh "$WORK_DIR/uploads.tar.gz" 2>/dev/null | cut -f1 || echo "0")
log_info "Uploads: $UPLOADS_SIZE"

# ─────────────────────────────────────────────────────────────────────────────
# 4. Write manifest
# ─────────────────────────────────────────────────────────────────────────────
cat > "$WORK_DIR/MANIFEST.txt" <<EOF
Deckgauge Backup
=================
Stack:      ${STACK}
Tag:        ${TAG}
Created:    $(date -u +"%Y-%m-%dT%H:%M:%SZ")
Host:       $(hostname)

Contents:
  postgres.pgdump         — Postgres custom-format dump (pg_restore compatible)
  keycloak.pgdump         — Keycloak Postgres dump (pg_restore compatible)
  clickhouse/             — ClickHouse tables as gzipped Native format
  uploads.tar.gz          — File upload attachments

ClickHouse tables backed up:
$(for t in "${CH_TABLES[@]}"; do echo "  $t"; done)

Restore with:
  ./scripts/restore.sh ${DEST_DIR}/${BACKUP_NAME}.tar.gz
EOF

# ─────────────────────────────────────────────────────────────────────────────
# 5. Archive everything
# ─────────────────────────────────────────────────────────────────────────────
log_step "Creating archive..."
ARCHIVE="${DEST_DIR}/${BACKUP_NAME}.tar.gz"
tar czf "$ARCHIVE" -C "$WORK_DIR" .
ARCHIVE_SIZE=$(du -sh "$ARCHIVE" | cut -f1)

echo ""
echo -e "${GREEN}✓ Backup complete${NC}"
echo "  File:    $ARCHIVE"
echo "  Size:    $ARCHIVE_SIZE"
echo "  Restore: ./scripts/restore.sh $ARCHIVE"

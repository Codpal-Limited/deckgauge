#!/bin/bash
# Deckgauge — Full restore script
#
# Restores from a backup archive created by scripts/backup.sh:
#   1. Stops api, web, worker (keeps infra running so we can write to DBs)
#   2. Restores Postgres (pg_restore — drops and recreates schema)
#   3. Restores ClickHouse tables (truncate + bulk insert from Native format)
#   4. Restores uploads volume
#   5. Runs Prisma + ClickHouse DDL migrations (in case schema advanced since backup)
#   6. Restarts all services and runs health checks
#
# Usage:
#   ./scripts/restore.sh ./backups/vp-cockpit-backup-20260603-120000.tar.gz
#   ./scripts/restore.sh ./backups/vp-cockpit-backup-20260603-120000.tar.gz --skip-clickhouse
#   ./scripts/restore.sh ./backups/vp-cockpit-backup-20260603-120000.tar.gz --skip-uploads
#
# Like backup.sh, `--stack main` (the default) assumes the compose project is
# named `vp-cockpit`; since docker-compose.yml declares no project `name:`, the
# real project name comes from the directory you cloned into. Set
# COMPOSE_PROJECT_NAME and UPLOADS_VOLUME to match if yours differs — otherwise
# compose will clash with the running containers and uploads will restore into
# a volume nothing mounts. `--stack next` additionally needs
# docker-compose.phase3.yml, which is not in every checkout; it exits with that
# reason if the file is absent.
#
# The health checks at the end assume the stack's default host ports.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_ROOT"

# ─── Args ────────────────────────────────────────────────────────────────────
if [ $# -lt 1 ]; then
  echo "Usage: $0 <backup.tar.gz> [--stack main|next] [--skip-clickhouse] [--skip-uploads] [--yes]"
  exit 1
fi

ARCHIVE="$1"
SKIP_CLICKHOUSE=false
SKIP_UPLOADS=false
ASSUME_YES=false
STACK="main"

shift
while [[ $# -gt 0 ]]; do
  case "$1" in
    --stack)           STACK="$2";          shift 2 ;;
    --skip-clickhouse) SKIP_CLICKHOUSE=true; shift ;;
    --skip-uploads)    SKIP_UPLOADS=true;    shift ;;
    --yes|-y)          ASSUME_YES=true;      shift ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [ ! -f "$ARCHIVE" ]; then
  echo "Archive not found: $ARCHIVE" >&2
  exit 1
fi

# ─── Stack configuration ────────────────────────────────────────────────────
case "$STACK" in
  main)
    : "${COMPOSE_PROJECT_NAME:=vp-cockpit}"
    : "${CH_PORT:=8123}"
    : "${PG_CONTAINER:=vp-cockpit-postgres}"
    : "${KC_DB_CONTAINER:=vp-cockpit-keycloak-db}"
    : "${API_CONTAINER:=vp-cockpit-api}"
    : "${UPLOADS_VOLUME:=vp-cockpit_uploads_data}"
    COMPOSE_FILES=(-f docker-compose.yml)
    ;;
  next)
    : "${COMPOSE_PROJECT_NAME:=vp-cockpit-next}"
    : "${CH_PORT:=8124}"
    : "${PG_CONTAINER:=vp-cockpit-next-postgres}"
    : "${KC_DB_CONTAINER:=vp-cockpit-next-keycloak-db}"
    : "${API_CONTAINER:=vp-cockpit-next-api}"
    : "${UPLOADS_VOLUME:=vp-cockpit-next_uploads_data}"
    # The overlay this preset needs is not part of every checkout. Fail with
    # the reason rather than letting `docker compose` report a missing file.
    if [ ! -f "$PROJECT_ROOT/docker-compose.phase3.yml" ]; then
      echo "--stack next needs docker-compose.phase3.yml, which is not in this checkout." >&2
      echo "Use --stack main, or point the container/volume env vars at your own stack." >&2
      exit 1
    fi
    COMPOSE_FILES=(-f docker-compose.yml -f docker-compose.phase3.yml)
    ;;
  *)
    echo "Unknown --stack: $STACK (expected: main, next)" >&2
    exit 1
    ;;
esac
export COMPOSE_PROJECT_NAME

# ─── Credentials ────────────────────────────────────────────────────────────
PG_USER="${POSTGRES_USER:-cockpit}"
PG_PASS="${POSTGRES_PASSWORD:-cockpit}"
PG_DB="${POSTGRES_DB:-cockpit}"
KC_DB_USER="${KEYCLOAK_DB_USER:-keycloak}"
KC_DB_NAME="${KEYCLOAK_DB_NAME:-keycloak}"
CH_USER="${CLICKHOUSE_USER:-cockpit}"
CH_PASS="${CLICKHOUSE_PASSWORD:-cockpit}"
CH_HOST="localhost"
CH_DB="cockpit"

# ─── Colours ─────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m'
log_step() { echo -e "${GREEN}▶${NC} $1"; }
log_info() { echo -e "${YELLOW}·${NC} $1"; }
log_fail() { echo -e "${RED}✗${NC} $1" >&2; }

# ─── Helpers ─────────────────────────────────────────────────────────────────
ch_query() {
  curl -sf --max-time 30 \
    "http://${CH_USER}:${CH_PASS}@${CH_HOST}:${CH_PORT}/" \
    --data "$1"
}

ch_import_table() {
  local table="$1"
  local src="$2"  # gzipped Native file
  if [ ! -f "$src" ]; then
    log_info "  skipping $table (no backup file found)"
    return 0
  fi
  local rows
  rows=$(wc -c < "$src" || echo 0)
  if [ "$rows" -eq 0 ]; then
    log_info "  $table: empty backup file — skipping"
    return 0
  fi
  # Truncate existing data, then bulk insert
  ch_query "TRUNCATE TABLE IF EXISTS ${CH_DB}.${table}" > /dev/null
  # Query goes in URL params (ClickHouse convention); binary body via stdin.
  # Note: `--get --data-urlencode` would force the body into the URL, breaking
  # large binary inserts — do not reintroduce that pattern.
  gunzip -c "$src" | curl -sf --max-time 600 \
    --data-binary @- \
    "http://${CH_USER}:${CH_PASS}@${CH_HOST}:${CH_PORT}/?database=${CH_DB}&query=INSERT+INTO+${table}+FORMAT+Native" \
    > /dev/null
  local count
  count=$(ch_query "SELECT count() FROM ${CH_DB}.${table}")
  log_info "  $table: $count rows restored"
}

# ─────────────────────────────────────────────────────────────────────────────
# Confirmation prompt
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo -e "${RED}WARNING: This will overwrite all existing data on stack '$STACK'.${NC}"
echo "  Archive:    $ARCHIVE"
echo "  Stack:      $STACK (project: $COMPOSE_PROJECT_NAME)"
echo "  Postgres:   $PG_DB    (container: $PG_CONTAINER)"
echo "  Keycloak:   $KC_DB_NAME  (container: $KC_DB_CONTAINER)"
echo "  ClickHouse: $CH_DB  on :$CH_PORT (skip: $SKIP_CLICKHOUSE)"
echo "  Uploads:    volume: $UPLOADS_VOLUME (skip: $SKIP_UPLOADS)"
echo ""

if [ "$ASSUME_YES" = false ]; then
  # `|| confirm=""` matters under `set -e`: with no tty (CI, a pipe) `read`
  # hits EOF and returns non-zero, which would abort the script silently
  # instead of falling through to the "Restore cancelled." message below.
  read -r -p "Continue with restore? [y/N] " confirm || confirm=""
  if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
    echo "Restore cancelled."
    exit 0
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
# Extract archive to temp dir
# ─────────────────────────────────────────────────────────────────────────────
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

log_step "Extracting archive..."
tar xzf "$ARCHIVE" -C "$WORK_DIR"

# Show manifest if present
if [ -f "$WORK_DIR/MANIFEST.txt" ]; then
  echo ""
  cat "$WORK_DIR/MANIFEST.txt"
  echo ""
fi

# ─────────────────────────────────────────────────────────────────────────────
# Preflight: ensure infra is running
# ─────────────────────────────────────────────────────────────────────────────
log_step "Ensuring infra is running..."
docker compose "${COMPOSE_FILES[@]}" up -d postgres redis clickhouse keycloak-db
sleep 3

# Wait for Postgres
for i in $(seq 1 12); do
  docker exec "$PG_CONTAINER" pg_isready -U "$PG_USER" -d "$PG_DB" > /dev/null 2>&1 && break
  [ "$i" -eq 12 ] && { log_fail "Postgres not ready."; exit 1; }
  sleep 5
done

# Wait for ClickHouse
for i in $(seq 1 18); do
  ch_query "SELECT 1" > /dev/null 2>&1 && break
  [ "$i" -eq 18 ] && { log_fail "ClickHouse not ready."; exit 1; }
  sleep 5
done

# ─────────────────────────────────────────────────────────────────────────────
# Stop app containers (keep infra up so we can write to DBs)
# ─────────────────────────────────────────────────────────────────────────────
log_step "Stopping app containers..."
docker compose "${COMPOSE_FILES[@]}" stop api web worker keycloak 2>/dev/null || true

# ─────────────────────────────────────────────────────────────────────────────
# 1. Restore Postgres
# ─────────────────────────────────────────────────────────────────────────────
log_step "Restoring Postgres..."

if [ ! -f "$WORK_DIR/postgres.pgdump" ]; then
  log_fail "postgres.pgdump not found in archive."
  exit 1
fi

# Drop all connections, recreate the database, restore
docker exec -i "$PG_CONTAINER" psql -U "$PG_USER" -d postgres -c \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${PG_DB}' AND pid <> pg_backend_pid();" \
  > /dev/null 2>&1 || true

docker exec -i "$PG_CONTAINER" psql -U "$PG_USER" -d postgres -c \
  "DROP DATABASE IF EXISTS ${PG_DB};" > /dev/null

docker exec -i "$PG_CONTAINER" psql -U "$PG_USER" -d postgres -c \
  "CREATE DATABASE ${PG_DB} OWNER ${PG_USER};" > /dev/null

docker exec -i "$PG_CONTAINER" \
  pg_restore -U "$PG_USER" -d "$PG_DB" --no-owner --role="$PG_USER" \
  < "$WORK_DIR/postgres.pgdump" || {
  log_fail "pg_restore reported errors (this may be non-fatal — check above)."
}

# Verify
PG_TABLES=$(docker exec -i "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" \
  -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'" 2>/dev/null || echo "?")
log_info "Postgres restored ($PG_TABLES tables)"

# ─────────────────────────────────────────────────────────────────────────────
# 1b. Restore Keycloak DB
# ─────────────────────────────────────────────────────────────────────────────
log_step "Restoring Keycloak DB..."

if [ ! -f "$WORK_DIR/keycloak.pgdump" ]; then
  log_info "  keycloak.pgdump not in archive — skipping Keycloak restore."
else
  docker exec -i "$KC_DB_CONTAINER" psql -U "$KC_DB_USER" -d postgres -c \
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${KC_DB_NAME}' AND pid <> pg_backend_pid();" \
    > /dev/null 2>&1 || true

  docker exec -i "$KC_DB_CONTAINER" psql -U "$KC_DB_USER" -d postgres -c \
    "DROP DATABASE IF EXISTS ${KC_DB_NAME};" > /dev/null

  docker exec -i "$KC_DB_CONTAINER" psql -U "$KC_DB_USER" -d postgres -c \
    "CREATE DATABASE ${KC_DB_NAME} OWNER ${KC_DB_USER};" > /dev/null

  docker exec -i "$KC_DB_CONTAINER" \
    pg_restore -U "$KC_DB_USER" -d "$KC_DB_NAME" --no-owner --role="$KC_DB_USER" \
    < "$WORK_DIR/keycloak.pgdump" || {
    log_fail "Keycloak pg_restore reported errors (this may be non-fatal — check above)."
  }

  KC_TABLES=$(docker exec -i "$KC_DB_CONTAINER" psql -U "$KC_DB_USER" -d "$KC_DB_NAME" \
    -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'" 2>/dev/null || echo "?")
  log_info "Keycloak DB restored ($KC_TABLES tables)"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 2. Restore ClickHouse
# ─────────────────────────────────────────────────────────────────────────────
if [ "$SKIP_CLICKHOUSE" = false ]; then
  log_step "Restoring ClickHouse tables..."

  CH_BACKUP_DIR="$WORK_DIR/clickhouse"
  if [ ! -d "$CH_BACKUP_DIR" ]; then
    log_info "No clickhouse/ directory in archive — skipping ClickHouse restore."
  else
    # Ensure database exists
    ch_query "CREATE DATABASE IF NOT EXISTS ${CH_DB}" > /dev/null

    # Apply DDL first (tables may not exist if this is a fresh ClickHouse instance)
    SCHEMA_DIR="$PROJECT_ROOT/clickhouse/schemas"
    if [ -d "$SCHEMA_DIR" ]; then
      log_info "Applying ClickHouse DDL (ensuring tables exist)..."
      for sql_file in $(ls "$SCHEMA_DIR"/*.sql 2>/dev/null | sort); do
        ch_query "$(cat "$sql_file")" > /dev/null 2>&1 || true  # IF NOT EXISTS — safe to ignore errors
      done
    fi

    # Restore each table
    # Raw data tables first, MV state tables last
    RAW_TABLES=(
      jira_issues jira_transitions jira_worklogs
      github_issues github_milestones github_pull_requests github_commits github_reviews
      github_workflow_runs github_deployments
      gitlab_merge_requests gitlab_commits gitlab_reviews gitlab_issues
      ado_work_items ado_transitions ado_pull_requests ado_commits ado_reviews
      developer_identity_map
      board_item_classification
    )
    MV_STATE_TABLES=(
      developer_weekly_pr_state
      jira_flow_efficiency_state
      commit_activity_state
    )

    for table in "${RAW_TABLES[@]}"; do
      ch_import_table "$table" "$CH_BACKUP_DIR/${table}.native.gz"
    done

    for table in "${MV_STATE_TABLES[@]}"; do
      ch_import_table "$table" "$CH_BACKUP_DIR/${table}.native.gz"
    done

    TOTAL_CH=$(ch_query "SELECT sum(total_rows) FROM system.tables WHERE database='${CH_DB}' AND engine NOT LIKE '%View%'" 2>/dev/null || echo "?")
    log_info "ClickHouse total rows across all tables: $TOTAL_CH"
  fi
else
  log_info "Skipping ClickHouse restore (--skip-clickhouse)."
fi

# ─────────────────────────────────────────────────────────────────────────────
# 3. Restore uploads
# ─────────────────────────────────────────────────────────────────────────────
if [ "$SKIP_UPLOADS" = false ]; then
  log_step "Restoring uploads..."
  if [ -f "$WORK_DIR/uploads.tar.gz" ]; then
    # Clear existing uploads volume and restore
    docker run --rm \
      -v "$UPLOADS_VOLUME":/data \
      -v "$WORK_DIR":/backup \
      alpine:3.19 \
      sh -c "rm -rf /data/* && tar xzf /backup/uploads.tar.gz -C /data"
    UPLOAD_COUNT=$(docker run --rm -v "$UPLOADS_VOLUME":/data alpine:3.19 \
      find /data -type f | wc -l | tr -d ' ')
    log_info "Uploads restored ($UPLOAD_COUNT files)"
  else
    log_info "No uploads.tar.gz in archive — skipping."
  fi
else
  log_info "Skipping uploads restore (--skip-uploads)."
fi

# ─────────────────────────────────────────────────────────────────────────────
# 4. Run Prisma migrations (forward-migrate if schema advanced since backup)
# ─────────────────────────────────────────────────────────────────────────────
log_step "Running Prisma migrations (forward-migrate if needed)..."
docker compose "${COMPOSE_FILES[@]}" run --rm --no-deps api \
  sh -c "cd /app/packages/db && npx prisma migrate deploy" || {
  log_fail "Prisma migration failed."
  exit 1
}

# ─────────────────────────────────────────────────────────────────────────────
# 5. Restart app containers
# ─────────────────────────────────────────────────────────────────────────────
log_step "Starting app containers..."
docker compose "${COMPOSE_FILES[@]}" up -d keycloak api web worker

# ─────────────────────────────────────────────────────────────────────────────
# 6. Health checks
# ─────────────────────────────────────────────────────────────────────────────
log_step "Running health checks..."
api_ok=false; web_ok=false; ch_ok=false

# Host ports per stack, for the post-restore health checks. These are the
# defaults each stack publishes; if you've remapped them, the restore itself
# still succeeded even when these checks report a failure.
case "$STACK" in
  main) WEB_PORT=3000; API_PORT=3001 ;;
  next) WEB_PORT=3010; API_PORT=3011 ;;
esac

for i in $(seq 1 10); do
  [ "$api_ok" = false ] && curl -sf --max-time 5 "http://localhost:${API_PORT}/health" > /dev/null 2>&1 && api_ok=true
  [ "$web_ok" = false ] && curl -sf --max-time 5 "http://localhost:${WEB_PORT}" > /dev/null 2>&1         && web_ok=true
  [ "$ch_ok"  = false ] && ch_query "SELECT 1" > /dev/null 2>&1                                          && ch_ok=true
  [ "$api_ok" = true ] && [ "$web_ok" = true ] && [ "$ch_ok" = true ] && break
  sleep 5
done

echo ""
echo "  Health check API:        $([ "$api_ok" = true ] && echo 'PASS' || echo 'FAIL')"
echo "  Health check Web:        $([ "$web_ok" = true ] && echo 'PASS' || echo 'FAIL')"
echo "  Health check ClickHouse: $([ "$ch_ok"  = true ] && echo 'PASS' || echo 'FAIL')"
echo ""

if [ "$api_ok" = true ] && [ "$web_ok" = true ] && [ "$ch_ok" = true ]; then
  echo -e "${GREEN}✓ Restore complete and platform is healthy.${NC}"
  echo "  Web:        http://localhost:${WEB_PORT}"
  echo "  API:        http://localhost:${API_PORT}"
  echo "  ClickHouse: http://localhost:${CH_PORT}/play"
  exit 0
else
  log_fail "Restore complete but health checks failed. Check logs:"
  echo "  docker compose logs api"
  echo "  docker compose logs web"
  echo "  docker compose logs clickhouse"
  exit 1
fi

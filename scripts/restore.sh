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
#   ./scripts/restore.sh ./backups/deckgauge-backup-20260603-120000.tar.gz
#   ./scripts/restore.sh ./backups/deckgauge-backup-20260603-120000.tar.gz --skip-clickhouse
#   ./scripts/restore.sh ./backups/deckgauge-backup-20260603-120000.tar.gz --skip-uploads
#
# Like backup.sh, `--stack main` (the default) assumes the compose project is
# named `deckgauge`; since docker-compose.yml declares no project `name:`, the
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

# Published host ports from .env, defaults where unset.
DG_PROJECT_ROOT="$PROJECT_ROOT"
# shellcheck source=lib/staging-ports.sh
source "$PROJECT_ROOT/scripts/lib/staging-ports.sh"

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
    : "${COMPOSE_PROJECT_NAME:=deckgauge}"
    # CH_PORT is a HOST port, so it follows CLICKHOUSE_HTTP_PORT out of .env
    # when this stack has been moved off the defaults. `--stack next` keeps its
    # literal: that overlay hardcodes 8124 and reads no .env.
    : "${CH_PORT:=${CLICKHOUSE_HTTP_PORT}}"
    : "${PG_CONTAINER:=deckgauge-postgres}"
    : "${KC_DB_CONTAINER:=deckgauge-keycloak-db}"
    : "${API_CONTAINER:=deckgauge-api}"
    : "${UPLOADS_VOLUME:=deckgauge_uploads_data}"
    COMPOSE_FILES=(-f docker-compose.yml)
    ;;
  next)
    : "${COMPOSE_PROJECT_NAME:=deckgauge-next}"
    : "${CH_PORT:=8124}"
    : "${PG_CONTAINER:=deckgauge-next-postgres}"
    : "${KC_DB_CONTAINER:=deckgauge-next-keycloak-db}"
    : "${API_CONTAINER:=deckgauge-next-api}"
    : "${UPLOADS_VOLUME:=deckgauge-next_uploads_data}"
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
# Passwords come from .env; names and database names keep their compose
# defaults. See scripts/lib/env-file.sh for why a `${VAR:-cockpit}` fallback was
# never a fallback here — nothing in this script read .env for credentials, so
# the "default" was the value it always used.
# shellcheck source=lib/env-file.sh
source "$PROJECT_ROOT/scripts/lib/env-file.sh"
PG_USER="${POSTGRES_USER:-cockpit}"
PG_PASS="$(dg_require_env POSTGRES_PASSWORD)" || exit 1
PG_DB="${POSTGRES_DB:-cockpit}"
KC_DB_USER="${KEYCLOAK_DB_USER:-keycloak}"
KC_DB_NAME="${KEYCLOAK_DB_NAME:-keycloak}"
CH_USER="${CLICKHOUSE_USER:-cockpit}"
CH_PASS="$(dg_require_env CLICKHOUSE_PASSWORD)" || exit 1
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
  # Measure the DECOMPRESSED size, not the file size.
  #
  # This used to be `wc -c < "$src"`, which is the size of the GZIP STREAM — and
  # gzip of an empty input is still 20 bytes of header and trailer, never 0. So
  # the "empty backup file" branch below was unreachable, and a table that was
  # legitimately empty at backup time fell through to the import, landed 0 rows,
  # and tripped the "0 rows are present after import" abort at the end of this
  # function — after truncating the table.
  #
  # In the 20260902 archive that is five tables, and because _ch_migrations sorts
  # first the whole restore aborted on table one, having restored nothing. An
  # empty export is a fact about the source, not a failure, and it must not be
  # reported as one.
  #
  # FOUR of those five were genuinely empty (developer_identity_map,
  # github_milestones, gitlab_issues, jira_worklogs). _ch_migrations was NOT: it
  # held 25 rows, and its export had failed. backup.sh asked for `FINAL` on every
  # table, which a plain MergeTree rejects (`Code: 181 ILLEGAL_FINAL`), and the
  # failure was swallowed — so this branch read a broken export as an empty one
  # and left the migration ledger unrestored, which is precisely what shipping the
  # ledger is supposed to prevent. Fixed in scripts/lib/ch-export.sh, where an
  # export that fails now stops the backup.
  #
  # The asymmetry survives on purpose: this side still cannot tell an empty table
  # from a failed export, because a 0-byte member looks identical either way. The
  # guarantee has to come from the backup never writing one, not from a guess
  # here. Archives taken before that fix DO contain an empty ledger member, and
  # restoring one leaves _ch_migrations empty.
  local bytes
  bytes=$(gunzip -c "$src" 2>/dev/null | wc -c | tr -d '[:space:]') || bytes=0
  if [ "${bytes:-0}" -eq 0 ]; then
    log_info "  $table: empty at backup time (0 rows exported) — leaving table untouched"
    return 0
  fi

  # Truncate existing data, then bulk insert.
  #
  # This order means a FAILED import leaves the table empty, so the import below
  # must be loud. It did not used to be: `curl -sf … > /dev/null` swallowed the
  # response, and a whole-table Native insert spanning more than 100 monthly
  # partitions is rejected with `Code 252 TOO_MANY_PARTS`. On staging that hit
  # ado_transitions (282,722 rows) and ado_work_items (85,884) — 79% of all data —
  # and the restore printed "0 rows restored" and carried on to report success.
  # A restore that destroys data and calls it success is worse than no restore.
  #
  # max_partitions_per_insert_block=0 lifts that limit for the import. It is a
  # per-query setting, so it does not relax anything for normal ingest.
  ch_query "TRUNCATE TABLE IF EXISTS ${CH_DB}.${table}" > /dev/null

  local response
  response=$(gunzip -c "$src" | curl -s --max-time 900 \
    --data-binary @- \
    "http://${CH_USER}:${CH_PASS}@${CH_HOST}:${CH_PORT}/?database=${CH_DB}&max_partitions_per_insert_block=0&query=INSERT+INTO+${table}+FORMAT+Native" 2>&1)

  if printf '%s' "$response" | grep -q "DB::Exception"; then
    log_fail "  $table: import FAILED and the table is now EMPTY (it was truncated first):"
    printf '%s\n' "$response" | head -3
    log_fail "  Aborting: the archive is intact, but this database is now missing $table."
    exit 1
  fi

  local count
  count=$(ch_query "SELECT count() FROM ${CH_DB}.${table}" | tr -d '[:space:]')

  # A non-empty export that lands zero rows is a silent failure by another name.
  if [ "${count:-0}" -eq 0 ]; then
    log_fail "  $table: export held ${bytes} bytes of decompressed rows but 0 rows are present after import."
    log_fail "  Aborting rather than reporting a successful restore."
    exit 1
  fi
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

    # Which tables to restore is derived from what the ARCHIVE contains, not
    # from a literal list.
    #
    # Both this script and backup.sh used to hardcode the set, and both had
    # drifted: ado_deployments was in neither, so 21,426 rows of DORA deploy data
    # on staging was un-backed-up and unrestorable. Deriving from the archive
    # means a restore replays exactly what was captured — including tables added
    # after this code was written.
    #
    # Ordering still matters: raw tables before materialized-view state tables, so
    # a state table is never repopulated from a half-loaded source.
    ALL_BACKUP_TABLES=()
    while IFS= read -r f; do
      [ -n "$f" ] && ALL_BACKUP_TABLES+=("$(basename "$f" .native.gz)")
    done < <(ls "$CH_BACKUP_DIR"/*.native.gz 2>/dev/null | sort)

    if [ ${#ALL_BACKUP_TABLES[@]} -eq 0 ]; then
      log_fail "clickhouse/ directory present but contains no .native.gz exports — refusing a silent no-op restore."
      exit 1
    fi

    RAW_TABLES=()
    MV_STATE_TABLES=()
    for table in "${ALL_BACKUP_TABLES[@]}"; do
      case "$table" in
        *_state) MV_STATE_TABLES+=("$table") ;;
        *)       RAW_TABLES+=("$table") ;;
      esac
    done
    log_info "  ${#RAW_TABLES[@]} raw tables, ${#MV_STATE_TABLES[@]} MV state tables in archive"

    for table in "${RAW_TABLES[@]}"; do
      ch_import_table "$table" "$CH_BACKUP_DIR/${table}.native.gz"
    done

    for table in "${MV_STATE_TABLES[@]}"; do
      ch_import_table "$table" "$CH_BACKUP_DIR/${table}.native.gz"
    done

    TOTAL_CH=$(ch_query "SELECT sum(total_rows) FROM system.tables WHERE database='${CH_DB}' AND engine NOT LIKE '%View%'" 2>/dev/null || echo "?")
    log_info "ClickHouse total rows across all tables: $TOTAL_CH"

    # ── Tenant-key sanity check ──────────────────────────────────────────────
    #
    # An archive taken BEFORE ClickHouse tables gained organization_id will import
    # cleanly into the post-tenancy schema and report success — while writing
    # organization_id = '' into every row. Verified: 21,422 ado_deployments rows
    # imported that way with an empty tenant key.
    #
    # That is the worst possible outcome for a restore. The rows exist, the counts
    # look right, and the application can never see any of them, because '' matches
    # no organization predicate. And organization_id is part of the sorting key, so
    # ClickHouse refuses to correct it (Code 420 "Cannot UPDATE key column") — the
    # damage is permanent.
    #
    # So a restore that lands untenanted rows must FAIL, loudly, with the two
    # procedures that actually work.
    UNTENANTED_TOTAL=0
    UNTENANTED_TABLES=""
    TENANT_KEYED_TABLES=$(ch_query "SELECT table FROM system.columns WHERE database = '${CH_DB}' AND name = 'organization_id' ORDER BY table FORMAT TSV" 2>/dev/null || true)
    for utable in $TENANT_KEYED_TABLES; do
      ucount=$(ch_query "SELECT count() FROM ${CH_DB}.${utable} WHERE organization_id = '' FORMAT TSV" 2>/dev/null | tr -d '[:space:]')
      case "$ucount" in ''|*[!0-9]*) continue ;; esac
      if [ "$ucount" -gt 0 ]; then
        UNTENANTED_TOTAL=$((UNTENANTED_TOTAL + ucount))
        UNTENANTED_TABLES="${UNTENANTED_TABLES}\n    ${utable}: ${ucount} rows"
      fi
    done

    if [ "$UNTENANTED_TOTAL" -gt 0 ]; then
      log_fail "Restore left ${UNTENANTED_TOTAL} rows with an EMPTY organization_id:"
      printf "%b\n" "$UNTENANTED_TABLES"
      cat <<'REMEDY'

  This archive predates organization tenancy, and organization_id is a key column,
  so those rows can NOT be repaired in place (ClickHouse Code 420).

  Do one of these instead:

    A. Restore against the pre-tenancy schema, then migrate:
         git checkout 12b82680 -- clickhouse/schemas
         ./scripts/restore.sh <archive>            # old shape, data intact
         git checkout HEAD -- clickhouse/schemas
         CH_MIGRATE_URL=... CH_MIGRATE_ORG_ID=<org> \
           pnpm --filter @deckgauge/db exec tsx src/scripts/ch-org-tenancy-migrate.ts

    B. Take a fresh post-tenancy backup and restore that one.

  The database is currently NOT usable by the application. Nothing was lost from
  the archive — it can be restored again by route A.
REMEDY
      exit 1
    fi
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

# Host ports per stack, for the post-restore health checks. `main` reads them
# from .env via lib/staging-ports.sh, so a remapped stack checks the right
# ports. `next` is the phase-3 overlay, which hardcodes its own and reads no
# .env — remap that one and the restore still succeeded even if these FAIL.
case "$STACK" in
  main) : ;;   # WEB_PORT / API_PORT already resolved by lib/staging-ports.sh
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

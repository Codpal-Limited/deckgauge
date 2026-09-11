#!/bin/bash
# Apply the ClickHouse analytics schema.
#
# Run AFTER `docker compose up`, FROM THE REPO ROOT. Uses clickhouse-client inside
# the running container, so multi-statement files (e.g. the materialized views)
# apply correctly. Schemas use IF NOT EXISTS, so re-running is safe (idempotent).
#
# Environment overrides:
#   CLICKHOUSE_USER      (default: cockpit — an identifier, not a credential)
#   CLICKHOUSE_PASSWORD  (required; read from .env when not exported)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_ROOT"

# shellcheck source=lib/env-file.sh
DG_PROJECT_ROOT="$PROJECT_ROOT"
source "$PROJECT_ROOT/scripts/lib/env-file.sh"
CLICKHOUSE_USER="${CLICKHOUSE_USER:-cockpit}"
CLICKHOUSE_PASSWORD="$(dg_require_env CLICKHOUSE_PASSWORD)" || exit 1
SCHEMA_DIR="$PROJECT_ROOT/clickhouse/schemas"

if [ ! -d "$SCHEMA_DIR" ]; then
  echo "✗ No clickhouse/schemas/ directory found at $SCHEMA_DIR" >&2
  exit 1
fi

shopt -s nullglob
schema_files=("$SCHEMA_DIR"/*.sql)
shopt -u nullglob
if [ "${#schema_files[@]}" -eq 0 ]; then
  echo "✗ No .sql files found in $SCHEMA_DIR" >&2
  exit 1
fi

echo "Applying ClickHouse schemas from $SCHEMA_DIR ..."

# Apply in filename order (IF NOT EXISTS makes this idempotent).
IFS=$'\n' sorted_files=($(printf '%s\n' "${schema_files[@]}" | sort))
unset IFS

for sql_file in "${sorted_files[@]}"; do
  filename="$(basename "$sql_file")"
  echo "  → Applying $filename ..."
  if ! docker compose exec -T clickhouse clickhouse-client \
        --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" \
        --multiquery < "$sql_file"; then
    echo "✗ Failed to apply $filename" >&2
    echo "  (is the stack up? run 'docker compose up -d' first, from the repo root)" >&2
    exit 1
  fi
  echo "  ✓ $filename"
done

echo "✓ All ClickHouse schemas applied."

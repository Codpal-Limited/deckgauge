# shellcheck shell=bash
#
# Host-published ports for the main stack — the single place they are resolved.
#
# docker compose reads .env by itself, so the `ports:` mappings in
# docker-compose.yml pick up an override with no help from anyone. The scripts
# that source THIS file do not: they curl, psql and pg_dump the published ports
# from the host, and every one of them used to carry its own hardcoded copy of
# 5433 / 8123 / 3000 / 3001. Moving the stack off the default ports meant
# finding all of them, and the ones that were missed failed as "staging is
# down" rather than as "this script is looking at the wrong port".
#
# The fallbacks below are the compose defaults, character for character. That
# equality is the contract: a checkout with no .env — a fresh clone, the OSS
# distribution — resolves exactly the values docker-compose.yml would, so
# sourcing this changes nothing until someone sets a port explicitly.
#
# Usage (the caller sets DG_PROJECT_ROOT first):
#     DG_PROJECT_ROOT="$PROJECT_ROOT"
#     source "$PROJECT_ROOT/scripts/lib/staging-ports.sh"
#
# Every value is a `: "${VAR:=…}"` assignment, so an env var exported by the
# caller still wins over .env, which still wins over the default.

# Read one KEY=value out of .env. Deliberately NOT `source .env`: that file
# holds tokens and passwords with characters bash would execute, and a port
# lookup has no business evaluating any of it.
dg_env_value() {
  local key="$1" default="$2" root="${DG_PROJECT_ROOT:-.}" val=''
  if [[ -f "$root/.env" ]]; then
    val="$(sed -n -E "s/^[[:space:]]*${key}=[[:space:]]*[\"']?([0-9]+).*/\1/p" "$root/.env" | tail -n 1)"
  fi
  printf '%s' "${val:-$default}"
}

: "${WEB_PORT:=$(dg_env_value WEB_PORT 3000)}"
: "${API_PORT:=$(dg_env_value API_PORT 3001)}"
: "${SITE_PORT:=$(dg_env_value SITE_PORT 3020)}"
: "${POSTGRES_PORT:=$(dg_env_value POSTGRES_PORT 5433)}"
: "${REDIS_PORT:=$(dg_env_value REDIS_PORT 6379)}"
: "${KEYCLOAK_PORT:=$(dg_env_value KEYCLOAK_PORT 8080)}"
: "${CLICKHOUSE_HTTP_PORT:=$(dg_env_value CLICKHOUSE_HTTP_PORT 8123)}"
: "${CLICKHOUSE_NATIVE_PORT:=$(dg_env_value CLICKHOUSE_NATIVE_PORT 9000)}"

export WEB_PORT API_PORT SITE_PORT POSTGRES_PORT REDIS_PORT \
       KEYCLOAK_PORT CLICKHOUSE_HTTP_PORT CLICKHOUSE_NATIVE_PORT

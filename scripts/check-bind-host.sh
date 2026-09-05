#!/usr/bin/env bash
# Every published port in docker-compose.yml must bind through ${BIND_HOST-}.
#
# WHY A SEPARATE GUARD. scripts/check-compose-defaults.sh cannot see this, for
# exactly the reason check-pinned-env.sh exists: that check renders with an EMPTY
# env file, and `${BIND_HOST-}5433:5432` with the variable unset is
# byte-identical to a bare `5433:5432`. The prefixed and unprefixed compose files
# therefore produce the SAME snapshot — so without this script, deleting the
# prefix from any or all of the mappings is free and silent, and adding a new
# unprefixed `ports:` entry trips the snapshot once, whereupon the documented
# remedy (`--update`) blesses the wide-open port as the new default.
#
# The failure this protects against is not subtle: an unprefixed port on a hosted
# box binds 0.0.0.0, in front of a Redis with no password and a Postgres holding
# every tenant's provider credentials in plaintext. Compose MERGES port lists
# across `-f` files rather than replacing them, so no overlay can retract a
# published port after the fact — the prefix at the point of declaration is the
# only control there is.
#
#   scripts/check-bind-host.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$(dirname "$SCRIPT_DIR")"

fail=0

# ─── Check 1 (static): every mapping carries the prefix ─────────────────────
# Matches published-port list items only: a `- "…:…"` entry under `ports:`.
# Comment lines are stripped first so this file's own prose cannot trip it.
#
# The optional `\}` before the colon is what admits an INTERPOLATED host port —
# `"${BIND_HOST-}${WEB_PORT:-3000}:3000"`. Without it the digits before the colon
# are `3000}`, the pattern matches nothing, and this guard fails closed on the
# "pattern has gone stale" branch below rather than silently passing. It fails
# loudly by design; the fix is here, not a deletion.
mappings="$(grep -vE '^[[:space:]]*#' docker-compose.yml \
            | grep -nE '^[[:space:]]*-[[:space:]]*"[^"]*[0-9]+\}?:[0-9]+"' || true)"

if [[ -z "$mappings" ]]; then
  echo "✗ found no published-port mappings in docker-compose.yml at all." >&2
  echo "  This guard's pattern has gone stale — fix it rather than deleting it." >&2
  exit 1
fi

total=0
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  total=$((total + 1))
  if [[ "$line" != *'${BIND_HOST-}'* ]]; then
    echo "✗ published port without \${BIND_HOST-}: ${line#*:}" >&2
    fail=1
  fi
done <<< "$mappings"

(( fail )) || echo "✓ all $total published ports carry \${BIND_HOST-}"

# ─── Check 2 (rendered): the prefix actually reaches every host_ip ──────────
# Check 1 proves the text is present; this proves it WORKS. A prefix on a line
# Compose does not treat as a port mapping would pass check 1 and bind nothing.
if command -v docker >/dev/null 2>&1; then
  BIND_ENV="$(mktemp)"
  trap 'rm -f "$BIND_ENV"' EXIT
  printf 'BIND_HOST=127.0.0.1:\n' > "$BIND_ENV"

  # `env -u` clears any BIND_HOST the caller exported: the shell environment
  # takes precedence over --env-file, which would silently invalidate this.
  rendered="$(env -u BIND_HOST docker compose --env-file "$BIND_ENV" \
                -f docker-compose.yml config 2>/dev/null || true)"

  if [[ -z "$rendered" ]]; then
    echo "! skipped rendered check: 'docker compose config' produced nothing" >&2
  else
    published="$(grep -c 'mode: ingress' <<< "$rendered" || true)"
    bound="$(grep -c 'host_ip: 127.0.0.1' <<< "$rendered" || true)"
    if [[ "$published" != "$bound" ]]; then
      echo "✗ rendered with BIND_HOST=127.0.0.1: — $published published ports but" >&2
      echo "  only $bound bound to loopback. $((published - bound)) would bind 0.0.0.0." >&2
      fail=1
    else
      echo "✓ rendered: all $bound published ports honour BIND_HOST"
    fi
  fi
else
  echo "! skipped rendered check: docker not on PATH" >&2
fi

if (( fail )); then
  cat >&2 <<'MSG'

Prefix every published port in docker-compose.yml with ${BIND_HOST-}:

    ports:
      - "${BIND_HOST-}5433:5432"

Unset — self-host, OSS, local dev — it expands to nothing and the mapping is
character-for-character what it was, so scripts/check-compose-defaults.sh stays
green and no self-hosted install changes. A hosted box sets BIND_HOST=127.0.0.1:
(deploy/env.hosted.example) and nothing is reachable from off the box.

Do NOT re-record the compose-defaults snapshot to make this pass: that check
renders with an empty env file and cannot tell the two states apart, so
`--update` would bake a wide-open port in as the blessed default.
MSG
  exit 1
fi

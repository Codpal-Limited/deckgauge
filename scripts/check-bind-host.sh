#!/usr/bin/env bash
# Every published port in docker-compose.yml must bind through
# ${BIND_HOST-127.0.0.1:} — loopback unless the operator says otherwise.
#
# WHY A SEPARATE GUARD. scripts/check-compose-defaults.sh cannot see this, for
# exactly the reason check-pinned-env.sh exists: that check renders with an EMPTY
# env file. Since the default became loopback (GitHub issue #7) the snapshot DOES
# show `host_ip: 127.0.0.1` — but a mapping written as a literal
# `"127.0.0.1:5433:5432"` renders identically while ignoring BIND_HOST entirely,
# and a new unprefixed `ports:` entry trips the snapshot once, whereupon the
# documented remedy (`--update`) blesses the wide-open port as the new default.
# The text has to be checked as text.
#
# The failure this protects against is not subtle: an unprefixed port binds
# 0.0.0.0, in front of Redis and a Postgres holding every tenant's provider
# credentials. Compose MERGES port lists
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
# `"${BIND_HOST-127.0.0.1:}${WEB_PORT:-3000}:3000"`. Without it the digits before the colon
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
  # The exact prefix, and at the START of the mapping. `${BIND_HOST-}` (the old
  # all-interfaces default) and `${BIND_HOST:-127.0.0.1:}` (which would turn an
  # explicit `BIND_HOST=` back into loopback) are both refused.
  mapping="${line#*:}"
  if [[ ! "$mapping" =~ ^[[:space:]]*-[[:space:]]*\"\$\{BIND_HOST-127\.0\.0\.1:\} ]]; then
    echo "✗ published port without a leading \${BIND_HOST-127.0.0.1:}: $mapping" >&2
    fail=1
  fi
done <<< "$mappings"

(( fail )) || echo "✓ all $total published ports carry \${BIND_HOST-127.0.0.1:}"

# ─── Check 2 (rendered): the prefix actually reaches every host_ip ──────────
# Check 1 proves the text is present; this proves it WORKS. A prefix on a line
# Compose does not treat as a port mapping would pass check 1 and bind nothing.
#
# Rendered TWICE: with BIND_HOST UNSET (the stock install — must be loopback,
# which is the whole point of issue #7) and with BIND_HOST EXPLICITLY EMPTY (the
# documented opt-out — must publish on every interface, or the single-dash form
# has been "fixed" into `:-` and the opt-out silently does nothing).
if command -v docker >/dev/null 2>&1; then
  BIND_ENV="$(mktemp)"
  trap 'rm -f "$BIND_ENV"' EXIT
  # Every credential in docker-compose.yml is `${VAR:?...}`, so an env file
  # without them makes the render FAIL. See scripts/lib/compose-required-env.sh
  # — the names are DERIVED from the compose file so the set cannot go stale.
  # shellcheck source=lib/compose-required-env.sh
  source "$SCRIPT_DIR/lib/compose-required-env.sh"
  if ! write_compose_required_env "$BIND_ENV"; then
    echo "✗ could not derive the required variables for the render (see above)." >&2
    exit 1
  fi

  # `env -u` clears any BIND_HOST the caller exported: the shell environment
  # takes precedence over --env-file, which would silently invalidate this.
  #
  # NOT `2>/dev/null || true`, which is what this was. An empty render then took
  # a "skipped" branch and the script still exited 0 — a guard that downgrades
  # itself to a no-op and reports success. Same hardening as
  # scripts/check-compose-defaults.sh.
  render_with() {
    local extra="$1" envfile
    envfile="$(mktemp)"
    cat "$BIND_ENV" > "$envfile"
    [[ -n "$extra" ]] && printf '%s\n' "$extra" >> "$envfile"
    if ! env -u BIND_HOST docker compose --env-file "$envfile" -f docker-compose.yml config; then
      rm -f "$envfile"
      echo "✗ 'docker compose config' failed — see the error above." >&2
      echo "  This half of the guard cannot run, which is a failure, not a skip." >&2
      exit 1
    fi
    rm -f "$envfile"
  }

  rendered="$(render_with '')"
  if [[ -z "$rendered" ]]; then
    echo "✗ 'docker compose config' succeeded but produced nothing." >&2
    exit 1
  fi
  published="$(grep -c 'mode: ingress' <<< "$rendered" || true)"
  bound="$(grep -c 'host_ip: 127.0.0.1' <<< "$rendered" || true)"
  if [[ "$published" == "0" ]]; then
    echo "✗ the default render publishes no ports at all — this guard's parsing" >&2
    echo "  has gone stale. Fix it rather than deleting it." >&2
    fail=1
  elif [[ "$published" != "$bound" ]]; then
    echo "✗ rendered with BIND_HOST UNSET — $published published ports but only" >&2
    echo "  $bound bound to loopback. $((published - bound)) would bind 0.0.0.0 on a stock install." >&2
    fail=1
  else
    echo "✓ rendered, BIND_HOST unset: all $bound published ports bind loopback"
  fi

  opened="$(render_with 'BIND_HOST=')"
  still_bound="$(grep -c 'host_ip:' <<< "$opened" || true)"
  if [[ "$still_bound" != "0" ]]; then
    echo "✗ rendered with BIND_HOST= (explicitly empty) — $still_bound ports still carry" >&2
    echo "  a host_ip. The documented opt-out to all interfaces does not work; has a" >&2
    echo "  \${BIND_HOST-...} become \${BIND_HOST:-...}?" >&2
    fail=1
  else
    echo "✓ rendered, BIND_HOST= : the opt-out publishes on all interfaces"
  fi
else
  echo "! skipped rendered check: docker not on PATH" >&2
fi

if (( fail )); then
  cat >&2 <<'MSG'

Prefix every published port in docker-compose.yml with ${BIND_HOST-127.0.0.1:}:

    ports:
      - "${BIND_HOST-127.0.0.1:}${POSTGRES_PORT:-5433}:5432"

Unset, that binds loopback — the stock install is reachable from this machine
only. `BIND_HOST=` in .env (explicitly empty) publishes on every interface, and
a hosted box sets BIND_HOST=127.0.0.1: (deploy/env.hosted.example). Keep the
single dash: `:-` would turn the explicit-empty opt-out back into loopback.

Do NOT re-record the compose-defaults snapshot to make this pass: `--update`
would bake whatever the render currently says in as the blessed default.
MSG
  exit 1
fi

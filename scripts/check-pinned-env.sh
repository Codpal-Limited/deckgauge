#!/usr/bin/env bash
# Some compose values must NEVER become ${VAR:-default} interpolations.
#
# scripts/check-compose-defaults.sh cannot catch this: it renders with an EMPTY
# env file, where `${X:-good}` and a hardcoded `good` produce byte-identical
# output. The regression is only visible when a real .env carries a different
# value — i.e. on a developer machine or a deploy, not in the snapshot.
#
# KEYCLOAK_JWKS_URI has now regressed twice (60d1d895 introduced it, c17af07b
# pinned it, 87baadc7 reverted the pin). Both times the symptom was every JWT
# verification failing with ECONNREFUSED against the api container's own
# localhost, while /health stayed green — a fully loaded app with empty boards,
# which reads as data loss rather than as an auth fault.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$(dirname "$SCRIPT_DIR")"

# Variables that are container-internal and must stay hardcoded in
# docker-compose.yml. Add to this list whenever a value is server-side only AND
# a wrong value fails in a way that does not look like an auth fault.
PINNED=(KEYCLOAK_JWKS_URI)

fail=0
for var in "${PINNED[@]}"; do
  # Strip comment lines first: the pinned line documents the anti-pattern it
  # forbids, and a guard that trips on its own explanation gets disabled.
  if grep -vE '^[[:space:]]*#' docker-compose.yml | grep -qE "\\\$\\{${var}(:-|-|\\})"; then
    echo "✗ ${var} is interpolated in docker-compose.yml, but must be pinned." >&2
    grep -nE "\\\$\\{${var}" docker-compose.yml | grep -vE ':[[:space:]]*#' >&2
    fail=1
  else
    echo "✓ ${var} is pinned"
  fi
done

# ---------------------------------------------------------------------------
# The other half of the same failure, for variables that legitimately KEEP their
# override.
#
# REDIS_URL cannot join PINNED: a deployment with an authenticated Redis has to
# supply the credential, and Compose cannot assemble one conditionally. So the
# override stays — and the danger moves to what .env.example ships, because
# `./scripts/init-env.sh` copies that file's values into every install's .env
# verbatim (only the credential lines are generated), and they are then injected
# straight into the containers.
#
# THE SET IS DERIVED, NOT LISTED. An earlier version of this check named
# REDIS_URL by hand, which would have missed the next variable of the same
# shape — and there are already two more (API_URL, KEYCLOAK_INTERNAL_URL). The
# rule instead reads docker-compose.yml: any `KEY: "${VAR:-default}"` whose
# DEFAULT addresses a compose SERVICE NAME is, by construction, consumed inside
# a container. If .env.example then gives that VAR a loopback value, the two
# disagree about where the container should connect, and the container loses.
#
# A localhost value does not fail loudly. BullMQ retries a connection that never
# succeeds, so queues go quiet and syncs never start — which reads as "the sync
# is stuck", not as a config fault. That is exactly what shipping
# `redis://localhost:6379` here did.
offenders="$(python3 "$SCRIPT_DIR/lib/container-consumed-env.py")" || {
  echo "✗ could not evaluate container-consumed variables" >&2
  fail=1
}

# `mapfile` is bash 4+; macOS ships 3.2, so read the lines portably.
if [[ -n "$offenders" ]]; then
  while IFS=$'\t' read -r var value; do
    [[ -z "$var" ]] && continue
    echo "✗ ${var} in .env.example points at the HOST (${value}), but docker-compose.yml" >&2
    echo "  passes it into a container, where localhost is that container. Use the" >&2
    echo "  compose service name — the default beside it already does." >&2
    fail=1
  done <<< "$offenders"
else
  echo "✓ no container-consumed variable in .env.example points at localhost"
fi

if (( fail )); then
  cat >&2 <<'MSG'

These values are fetched from inside a container, so the compose service name is
the only correct value and an override is never needed. Interpolating one lets a
stale .env win — and .env.example ships the host-dev localhost form, so
`./scripts/init-env.sh` (which every self-hoster runs, and which copies
non-credential lines verbatim) is enough to break the auth path silently.

Revert to the hardcoded value. If you genuinely need an override, remove the
variable from PINNED in this script and say why in the commit message.
MSG
  exit 1
fi

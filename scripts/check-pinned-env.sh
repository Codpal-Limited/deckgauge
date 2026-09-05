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

if (( fail )); then
  cat >&2 <<'MSG'

These values are fetched from inside a container, so the compose service name is
the only correct value and an override is never needed. Interpolating one lets a
stale .env win — and .env.example ships the host-dev localhost form, so
`cp .env.example .env` (which CLAUDE.md tells every self-hoster to run) is enough
to break the auth path silently.

Revert to the hardcoded value. If you genuinely need an override, remove the
variable from PINNED in this script and say why in the commit message.
MSG
  exit 1
fi

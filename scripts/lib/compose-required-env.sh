# shellcheck shell=bash
#
# Write an env file that satisfies every REQUIRED variable in docker-compose.yml.
#
# ─── Why the checks need this ───────────────────────────────────────────────
#
# scripts/check-compose-defaults.sh and scripts/check-bind-host.sh both render
# the compose file with an EMPTY --env-file, deliberately: a developer's own
# .env must not leak into a snapshot, and BIND_HOST must be proven from a known
# starting point.
#
# Every credential in docker-compose.yml is now `${VAR:?message}` rather than
# `${VAR:-cockpit}`, so an empty env file makes `docker compose config` FAIL. The
# failure mode that matters is not the failure — it is what the two callers did
# with it before this file existed:
#
#   - check-compose-defaults.sh piped the render through `2>/dev/null` into the
#     snapshot. A failed render is EMPTY, so `--update` would have recorded an
#     empty snapshot and the guard would have passed forever after, comparing
#     nothing to nothing.
#   - check-bind-host.sh's rendered half ends in `|| true` and prints
#     "! skipped rendered check" when the output is empty — a guard that
#     downgrades itself to a skip and still exits 0.
#
# Both are silent. So the env file has to carry the required variables.
#
# ─── Why the set is derived, never listed ───────────────────────────────────
#
# The names come out of docker-compose.yml itself. A list here would go stale the
# first time a credential is added, and it would go stale in the direction that
# looks fine: the new variable is simply absent, the render fails, and the caller
# falls into whichever silent branch it has.
#
# The sentinel value is the same for every variable and is deliberately not a
# plausible credential — it is written into the recorded snapshot, which ships in
# the open-source distribution.
#
# Usage:
#   source "$PROJECT_ROOT/scripts/lib/compose-required-env.sh"
#   write_compose_required_env "$SOME_TMPFILE"      # appends; caller owns the file

DG_COMPOSE_REQUIRED_SENTINEL="__required_not_a_credential__"

write_compose_required_env() {
  local target="$1" compose="${2:-docker-compose.yml}" name

  if [[ ! -f "$compose" ]]; then
    echo "write_compose_required_env: no $compose" >&2
    return 1
  fi

  # `${NAME:?...}` and `${NAME?...}` — both forms are "required".
  # Whole-line comments are stripped first: docker-compose.yml's own header
  # EXPLAINS the `${VAR:?...}` convention, and a guard that reads its own
  # documentation as configuration invents a variable called VAR.
  local names
  names="$(grep -vE '^[[:space:]]*#' "$compose" \
           | grep -oE '\$\{[A-Z][A-Z0-9_]*:?\?' \
           | sed -E 's/^\$\{//; s/:?\?$//' | sort -u)"

  if [[ -z "$names" ]]; then
    echo "write_compose_required_env: $compose declares no required variable." >&2
    echo "  Either every credential regressed to a \${VAR:-default} fallback," >&2
    echo "  or this pattern has gone stale. Fix it rather than deleting it." >&2
    return 1
  fi

  while IFS= read -r name; do
    [[ -n "$name" ]] || continue
    printf '%s=%s\n' "$name" "$DG_COMPOSE_REQUIRED_SENTINEL" >> "$target"
  done <<< "$names"
}

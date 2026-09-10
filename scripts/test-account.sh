#!/usr/bin/env bash
# Create (or remove) the `test@test.com` demo account on a running stack, and
# populate it, so a fresh install shows a working product on first sign-in.
#
# WHY A COMMAND AND NOT THE REALM EXPORT. Adding the user to
# keycloak/realm-export.json would need no command at all — `--import-realm`
# would create it on first boot. It is deliberately NOT done: the community
# docker-compose.yml leaves `${BIND_HOST-}` unset, so a default install
# publishes Postgres, Redis and Keycloak on 0.0.0.0, and a known-password
# cockpit-admin in a file every clone imports is a backdoor in installs that
# never asked for one. keycloak/ is on the OSS allowlist, so that file is public.
#
# WHY cockpit-admin. The cross-cutting people-analytics reads carry no board or
# org-tree id, so they are gated on a Keycloak REALM ROLE rather than a row
# (apps/api/src/auth/roles.ts, auth/policy.ts's ANALYTICS policy). Without it the
# per-engineer surfaces 403 for an account that owns every board. One role is
# enough: `hasAnalyticsRole` returns true for an admin, so cockpit-admin implies
# cockpit-analytics and granting both would be redundant.
#
#   scripts/test-account.sh                 # create, seed, sync
#   scripts/test-account.sh --no-seed       # create only (the demo VM path)
#   scripts/test-account.sh --remove        # remove the account, keep the data
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$(dirname "$SCRIPT_DIR")"

# The header block above IS the usage text, so the two cannot drift. Printed
# from line 2 to the first non-comment line rather than a fixed range, which
# would silently slice the wrong lines the first time the header grows.
usage() {
  awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "${BASH_SOURCE[0]}"
}

MODE=create
SEED=1
for arg in "$@"; do
  case "$arg" in
    --remove) MODE=remove ;;
    --no-seed) SEED=0 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $arg" >&2; echo "Try --help." >&2; exit 2 ;;
  esac
done

# THE CALLER WINS. See scripts/apply-realm-post-logout.sh for the full account:
# .env.example ASSIGNS KEYCLOAK_ADMIN_PASSWORD=admin and CLAUDE.md's first-time
# setup says to `cp .env.example .env`, so sourcing .env over an exported value
# would put `admin` back and fail the LAST step of a long deploy on an auth error
# pointing nowhere. Capture what the caller gave us, source .env for anything it
# did NOT set, then restore.
CALLER_REALM="${KEYCLOAK_REALM:-}"
CALLER_ADMIN_USER="${KEYCLOAK_ADMIN_USER:-}"
CALLER_ADMIN_PASS="${KEYCLOAK_ADMIN_PASSWORD:-}"
CALLER_ORG_SLUG="${DECKGAUGE_ORG_SLUG:-}"

if [[ -f .env ]]; then
  set -a; . ./.env; set +a
fi

REALM="${CALLER_REALM:-${KEYCLOAK_REALM:-deckgauge}}"
ADMIN_USER="${CALLER_ADMIN_USER:-${KEYCLOAK_ADMIN_USER:-admin}}"
ADMIN_PASS="${CALLER_ADMIN_PASS:-${KEYCLOAK_ADMIN_PASSWORD:-admin}}"
ORG_SLUG="${CALLER_ORG_SLUG:-${DECKGAUGE_ORG_SLUG:-deckgauge}}"
ACCOUNT_EMAIL="test@test.com"
ACCOUNT_PASSWORD="test"
# Same default and same override as apps/api/src/auth/roles.ts reads.
ADMIN_ROLE="${COCKPIT_ADMIN_ROLE:-cockpit-admin}"
WEB_URL="http://localhost:${WEB_PORT:-3000}"

export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-deckgauge}"
# Compose reads COMPOSE_FILE from the environment and splits it on ':' itself,
# which is what lets the demo stack pass both of its files. Forwarding it through
# a single -f would break on the colon.
COMPOSE=(docker compose)
[[ -n "${COMPOSE_ENV_FILE:-}" ]] && COMPOSE+=(--env-file "$COMPOSE_ENV_FILE")

# Re-authenticate inside EVERY exec, and pass the password as DATA rather than
# argv. Both are load-bearing, for the reasons apply-realm-token-lifespan.sh
# documents at length: this realm's MASTER token lives 60 seconds, so a script
# that logs in once and then makes several `docker compose exec` round trips has
# its token expire partway through; and the valueless `-e KC_PASS` keeps the
# password out of the host-side `docker` process's argv, which `ps -Ao args`
# would otherwise show world-readable for the life of the exec.
#
# Nothing below echoes either variable. The only credential this script ever
# prints is the ACCOUNT password, which is `test` and is the point.
export KC_USER="$ADMIN_USER"
export KC_PASS="$ADMIN_PASS"
kc() {
  "${COMPOSE[@]}" exec -T -e KC_USER -e KC_PASS keycloak sh -c '
      /opt/keycloak/bin/kcadm.sh config credentials \
        --server http://localhost:8080 --realm master \
        --user "$KC_USER" --password "$KC_PASS" >/dev/null &&
      exec /opt/keycloak/bin/kcadm.sh "$@"' sh "$@"
}

# NO JSON, THEREFORE NO python3. `--format csv --noquotes` makes kcadm print one
# BARE id per line on stdout and nothing else — its "Logging into …" banner and
# every error go to stderr — so the id needs no parser. That matters because the
# published README's one-command install runs this script, and on a stock macOS
# `python3` is a Command Line Tools stub: the headline OSS path used to be able
# to fail on its precondition check. Verified against Keycloak 26.7 (`kcadm.sh
# get --help` lists both flags; a live query returns exactly `<uuid>\n`).
#
# -q exact=true is REQUIRED, not tidiness. `email=` is Keycloak's INFIX search:
# on a realm that also holds test@test.com.au the unqualified query returns BOTH
# rows (measured), and this function's callers go on to set a password and grant
# the cockpit-admin realm role on whatever it hands back. With the flag the same
# query returns one row.
#
# stderr stays on the terminal: that is where an auth failure explains itself.
# And the QUERY's exit status is checked rather than swallowed — kcadm answers a
# no-match with exit 0 and empty output, so a non-zero exit means the realm or
# the credentials are wrong, and continuing would create a user and then fail to
# read it back with a message that names neither cause.
user_id_of() {
  local raw
  if ! raw="$(kc get users -r "$REALM" -q "email=$ACCOUNT_EMAIL" -q exact=true \
                --fields id --format csv --noquotes)"; then
    echo "✗ kcadm could not query realm '$REALM' — its error is above." >&2
    echo "  Check KEYCLOAK_ADMIN_USER / KEYCLOAK_ADMIN_PASSWORD, that the realm" >&2
    echo "  exists, and that the keycloak container is up." >&2
    return 1
  fi

  # COUNT the rows rather than reading the first one. A realm configured with
  # duplicateEmailsAllowed can hold two EXACT matches, and silently picking one
  # of them is the same class of bug -q exact=true just closed. No bash array
  # here on purpose: stock macOS is bash 3.2, where `"${a[@]}"` on an empty
  # array is an unbound-variable error under `set -u`.
  local line first="" count=0
  while IFS= read -r line; do
    line="${line%$'\r'}"
    if [[ -z "${line//[[:space:]]/}" ]]; then
      continue
    fi
    count=$(( count + 1 ))
    if [[ -z "$first" ]]; then
      first="$line"
    fi
  done <<< "$raw"

  if [[ "$count" -eq 0 ]]; then
    return 0
  fi

  if [[ "$count" -gt 1 ]]; then
    echo "✗ realm '$REALM' holds $count users with the exact email" >&2
    echo "  $ACCOUNT_EMAIL (duplicateEmailsAllowed). Refusing to guess which one" >&2
    echo "  to act on — delete the duplicates and re-run." >&2
    return 1
  fi

  # The id is interpolated into a `users/<id>` request path, so it is checked to
  # be a UUID before it leaves this function. Nothing observed makes kcadm print
  # anything else here; this exists so that if it ever did the script stops
  # rather than building a request path out of it.
  if [[ ! "$first" =~ ^[0-9a-fA-F-]{36}$ ]]; then
    echo "✗ kcadm returned an unexpected user id for $ACCOUNT_EMAIL." >&2
    echo "  Expected a UUID from --fields id --format csv --noquotes." >&2
    return 1
  fi

  printf '%s' "$first"
}

if [[ "$MODE" == remove ]]; then
  echo "==> Removing $ACCOUNT_EMAIL from realm '$REALM'"
  UID_FOUND="$(user_id_of)"
  if [[ -n "$UID_FOUND" ]]; then
    kc delete "users/$UID_FOUND" -r "$REALM"
    echo "    Keycloak user deleted"
  else
    echo "    no such Keycloak user — nothing to delete"
  fi
  echo "==> Removing the local user and its grants"
  "${COMPOSE[@]}" run --rm api npx tsx /app/packages/db/src/demo/test-account.ts --remove
  echo "✓ $ACCOUNT_EMAIL removed. The seeded demo data was NOT touched —"
  echo "  remove that with: docker compose run --rm api npx tsx /app/packages/db/src/demo/seed-demo.ts --remove"
  exit 0
fi

echo "==> Ensuring $ACCOUNT_EMAIL exists in realm '$REALM'"
EXISTING="$(user_id_of)"
if [[ -z "$EXISTING" ]]; then
  kc create users -r "$REALM" \
    -s "username=$ACCOUNT_EMAIL" -s "email=$ACCOUNT_EMAIL" \
    -s 'firstName=Test' -s 'lastName=User' \
    -s enabled=true -s emailVerified=true
  echo "    created"
else
  echo "    already present"
fi

KC_UID="$(user_id_of)"
if [[ -z "$KC_UID" ]]; then
  echo "✗ could not read back the user's id from Keycloak." >&2
  exit 1
fi
echo "    subject id: $KC_UID"

# --temporary=false, or the first sign-in lands on "update your password" and the
# advertised credential does not work as advertised.
echo "==> Setting the password"
kc set-password -r "$REALM" --userid "$KC_UID" --new-password "$ACCOUNT_PASSWORD" --temporary=false

echo "==> Granting the $ADMIN_ROLE realm role"
# Checked before granting so a second run reports a no-op instead of depending on
# `add-roles` being idempotent, and so a realm that predates the role fails HERE,
# with the fix named, rather than 403-ing later on every analytics page.
if kc get-roles -r "$REALM" --uid "$KC_UID" --fields name 2>/dev/null \
     | grep -q "\"$ADMIN_ROLE\""; then
  echo "    already granted"
elif kc add-roles -r "$REALM" --uid "$KC_UID" --rolename "$ADMIN_ROLE"; then
  echo "    granted"
else
  echo "✗ could not grant '$ADMIN_ROLE' in realm '$REALM'." >&2
  echo "  keycloak/realm-export.json defines that role, so a realm imported" >&2
  echo "  before it was added will not have it. Create it in the admin console" >&2
  echo "  (Realm roles -> Create role) and re-run — this script is convergent." >&2
  exit 1
fi

echo "==> Creating the organization, user and membership"
ARGS=(--keycloak-id "$KC_UID" --org "$ORG_SLUG")
[[ "$SEED" == 0 ]] && ARGS+=(--no-seed)
# SOURCE through tsx, like the worker step below, and NOT the compiled
# `/app/packages/db/dist/demo/test-account.js`. That path exists — apps/api's
# Dockerfile does build packages/db — but plain `node` cannot LOAD it any more:
# the seeder now reaches `@deckgauge/shared`, whose package `exports` map points
# at `./src/*.ts`, and Node's type stripping does not remap the `./schemas.js`
# specifier inside it. Verified inside the real image:
#   node  -e 'import("@deckgauge/shared")' -> ERR_MODULE_NOT_FOUND
#                                             file:///app/packages/shared/src/schemas.js
#   npx tsx -e 'import("@deckgauge/shared")' -> loads, 542 exports
# The same applies to the published README's `node …/dist/demo/seed-demo.js`.
"${COMPOSE[@]}" run --rm api npx tsx /app/packages/db/src/demo/test-account.ts "${ARGS[@]}"

if [[ "$SEED" == 1 ]]; then
  echo "==> Triggering the org-tree sync (per-engineer views)"
  # SOURCE, through tsx, deliberately. apps/worker/Dockerfile builds nothing —
  # its only build step is `pnpm --filter @deckgauge/db build` and its CMD is
  # `npx tsx src/index.ts` — so `dist/scripts/trigger-org-sync.js` exists in the
  # image only when the HOST happened to leave a build in the context (bare
  # `dist` in .dockerignore matches the ROOT dist only, verified). A fresh clone
  # has no worker dist, so the compiled path would MODULE_NOT_FOUND behind the
  # `||` below and degrade silently to empty per-engineer views — the exact
  # failure this script exists to remove. tsx and the source are always present.
  "${COMPOSE[@]}" run --rm -e "DECKGAUGE_ORG_SLUG=$ORG_SLUG" \
    worker npx tsx src/scripts/trigger-org-sync.ts || {
      echo "    ⚠ the sync could not be enqueued — the per-engineer views will be empty." >&2
      echo "      Everything else is seeded. Re-run just this step with:" >&2
      echo "      docker compose run --rm worker npx tsx src/scripts/trigger-org-sync.ts" >&2
    }
fi

echo ""
echo "✓ Sign in at $WEB_URL with $ACCOUNT_EMAIL / $ACCOUNT_PASSWORD"
echo "  Remove it later with: scripts/test-account.sh --remove"

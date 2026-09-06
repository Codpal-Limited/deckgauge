#!/usr/bin/env bash
# One-shot migration for the vp-cockpit → deckgauge rename, run against an
# ALREADY-RUNNING Keycloak.
#
# WHY THIS EXISTS. Three identifiers moved with the rename:
#
#   realm      vp-cockpit      → deckgauge
#   client     vp-cockpit-web  → deckgauge-web
#   loginTheme vp-cockpit      → deckgauge   (keycloak/themes/ was renamed too)
#
# `--import-realm` never MODIFIES an existing realm, so the renamed
# keycloak/realm-export.json cannot update a stack that has already started —
# Keycloak keeps serving the old names while api/web ask for the new ones, and
# every login fails on an issuer mismatch. What it DOES do, on any database and
# at every startup, is CREATE a realm that is missing: so on an unmigrated stack
# it silently stands up an EMPTY `deckgauge` realm next to the real one. Step 1
# below exists to clear that decoy; do not simplify its condition.
# Neither .env nor KEYCLOAK_PUBLIC_ORIGIN can fix any of it:
# KEYCLOAK_JWKS_URI and KEYCLOAK_CLIENT_ID are pinned literals in
# docker-compose.yml (see scripts/check-pinned-env.sh). It takes kcadm — this.
#
# Fresh installs must NOT run this. There is nothing to migrate, and the script
# exits cleanly saying so.
#
# It is idempotent: re-running it re-asserts the same values.
#
#   scripts/rename-keycloak-realm.sh                              # base stack
#   COMPOSE_FILE=docker-compose.phase3.yml scripts/rename-keycloak-realm.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$(dirname "$SCRIPT_DIR")"

OLD_REALM="vp-cockpit"
NEW_REALM="deckgauge"
OLD_CLIENT="vp-cockpit-web"
NEW_CLIENT="deckgauge-web"
OLD_SECRET_DEFAULT="vp-cockpit-secret"
NEW_THEME="deckgauge"

ADMIN_USER="${KEYCLOAK_ADMIN_USER:-admin}"
ADMIN_PASS="${KEYCLOAK_ADMIN_PASSWORD:-admin}"

# NOT pinned to a project name. Compose derives it from the directory, which for
# a self-hosted clone is whatever the operator called it — `deckgauge` if they
# followed the README, but nothing enforces that. This repo's own staging pins
# `deckgauge` in deploy-staging.sh, so set COMPOSE_PROJECT_NAME here when you
# run it against that stack:
#
#   COMPOSE_PROJECT_NAME=deckgauge scripts/rename-keycloak-realm.sh
#
COMPOSE=(docker compose)
[[ -n "${COMPOSE_FILE:-}" ]] && COMPOSE=(docker compose -f "$COMPOSE_FILE")

kcadm() { "${COMPOSE[@]}" exec -T keycloak /opt/keycloak/bin/kcadm.sh "$@"; }

# ─── Preflight A: a stale .env silently outranks everything below ────────────
# .env.example ASSIGNS these (it does not merely comment them), and the
# documented setup is `cp .env.example .env`, so essentially every existing
# install has the old literals in a gitignored file that no upgrade can reach.
# docker-compose.yml interpolates both — `${KEYCLOAK_ISSUER:-...}` and
# `${KEYCLOAK_CLIENT_SECRET:-...}` — so the stale value WINS over the renamed
# default. Migrate Keycloak without fixing them and discovery 404s, then
# invalid_client, with nothing in the error naming .env.
#
# Refuse up front rather than leave a half-migrated stack behind.
if [[ -f .env ]]; then
  stale=()
  grep -qE '^[[:space:]]*KEYCLOAK_ISSUER=.*/realms/vp-cockpit' .env \
    && stale+=("KEYCLOAK_ISSUER      → .../realms/${NEW_REALM}")
  grep -qE "^[[:space:]]*KEYCLOAK_CLIENT_ID=${OLD_CLIENT}" .env \
    && stale+=("KEYCLOAK_CLIENT_ID   → ${NEW_CLIENT}")
  grep -qE "^[[:space:]]*KEYCLOAK_JWKS_URI=.*/realms/vp-cockpit" .env \
    && stale+=("KEYCLOAK_JWKS_URI    → .../realms/${NEW_REALM}/...")
  if [[ ${#stale[@]} -gt 0 ]]; then
    {
      echo "✗ .env still points at the old realm. Fix these lines FIRST:"
      echo ""
      for line in "${stale[@]}"; do echo "      $line"; done
      echo ""
      echo "  They are interpolated by docker-compose.yml, so they override the"
      echo "  renamed defaults. Migrating Keycloak while they stand would break"
      echo "  every login with 'invalid_client' and nothing would mention .env."
      echo ""
      echo "  Leave KEYCLOAK_CLIENT_SECRET exactly as it is — this script does"
      echo "  not change the client secret."
    } >&2
    exit 1
  fi
fi

# Read .env so this agrees with what compose passed to the container.
if [[ -f .env ]]; then
  set -a; . ./.env; set +a
fi

# ─── Preflight B: is there actually a keycloak container in this project? ────
# Without the project pin above, a wrong working directory produces an opaque
# compose error deep inside the first kcadm call. Say it plainly instead.
if ! "${COMPOSE[@]}" ps --status running --format '{{.Service}}' 2>/dev/null | grep -qx keycloak; then
  {
    echo "✗ No RUNNING 'keycloak' service in Compose project '${COMPOSE_PROJECT_NAME:-<derived from $(basename "$PWD")>}'."
    echo "  Start the stack first, or point this at the right project:"
    echo "      COMPOSE_PROJECT_NAME=<project> $0"
    echo ""
    echo "  Projects with containers on this machine:"
    docker ps --format '{{.Label "com.docker.compose.project"}}' | sort -u | sed 's/^/      /'
  } >&2
  exit 1
fi

echo "==> Authenticating to Keycloak as $ADMIN_USER"
kcadm config credentials \
  --server http://localhost:8080 --realm master \
  --user "$ADMIN_USER" --password "$ADMIN_PASS" >/dev/null

# ─── Step 1: the realm ───────────────────────────────────────────────────────
#
# READ THIS BEFORE CHANGING THE CONDITION. "Realm `deckgauge` exists" does NOT
# mean the rename happened, and assuming it did produced a staging stack with
# zero users that looked completely healthy.
#
# The widespread belief — stated in docker-compose.yml's own header for a long
# time — is that `--import-realm` only applies to an EMPTY Keycloak database.
# That is half right, and the wrong half is load-bearing here. The accurate rule
# is: import never MODIFIES a realm that already exists, but it will happily
# CREATE one that is missing, on any database, at every startup
# (strategy IGNORE_EXISTING). So the moment keycloak/realm-export.json was
# renamed to declare `deckgauge`, the very next `docker compose up -d keycloak`
# on an UNMIGRATED stack created a brand-new EMPTY `deckgauge` realm sitting
# beside the real `vp-cockpit` one — before this script ever ran.
#
# Hence: both realms existing is the EXPECTED state on a stack that has been
# restarted since the upgrade, and the new one is the decoy.
old_exists=false; new_exists=false
kcadm get "realms/$OLD_REALM" >/dev/null 2>&1 && old_exists=true
kcadm get "realms/$NEW_REALM" >/dev/null 2>&1 && new_exists=true

realm_user_count() {
  kcadm get users/count -r "$1" 2>/dev/null | tr -dc '0-9'
}

if $old_exists && $new_exists; then
  new_users="$(realm_user_count "$NEW_REALM")"
  old_users="$(realm_user_count "$OLD_REALM")"
  echo "==> Both realms exist: '$OLD_REALM' (${old_users:-?} users), '$NEW_REALM' (${new_users:-?} users)"
  if [[ "${new_users:-1}" -ne 0 ]]; then
    {
      echo "✗ Realm '$NEW_REALM' already has ${new_users} user(s), and '$OLD_REALM' still exists."
      echo "  That is not the auto-import decoy this script knows how to clear, and"
      echo "  merging two populated realms is not something to guess at."
      echo "  Resolve by hand, then re-run."
    } >&2
    exit 1
  fi
  # Provably empty and provably auto-created: nothing to lose, and leaving it in
  # place is exactly what makes the stack come up with no users at all.
  echo "==> '$NEW_REALM' is empty — it is the --import-realm decoy. Removing it."
  kcadm delete "realms/$NEW_REALM"
  echo "==> Renaming realm '$OLD_REALM' → '$NEW_REALM' (carrying its ${old_users} user(s))"
  kcadm update "realms/$OLD_REALM" -s "realm=$NEW_REALM"
elif $old_exists; then
  echo "==> Renaming realm '$OLD_REALM' → '$NEW_REALM'"
  kcadm update "realms/$OLD_REALM" -s "realm=$NEW_REALM"
elif $new_exists; then
  echo "==> Only '$NEW_REALM' exists — already migrated, or a fresh install"
else
  echo "✗ Neither realm '$OLD_REALM' nor '$NEW_REALM' exists on this Keycloak." >&2
  echo "  Nothing to migrate — check that the realm-export import ran at all." >&2
  exit 1
fi

# ─── Step 2: the login theme ─────────────────────────────────────────────────
# keycloak/themes/vp-cockpit/ is now keycloak/themes/deckgauge/. A realm still
# pointing at the old directory does not error — Keycloak silently falls back to
# the stock theme, so the login page just quietly loses its branding.
echo "==> Setting loginTheme=$NEW_THEME on realm '$NEW_REALM'"
kcadm update "realms/$NEW_REALM" -s "loginTheme=$NEW_THEME"

# ─── Step 3: the client ──────────────────────────────────────────────────────
client_uuid() {
  kcadm get clients -r "$NEW_REALM" -q "clientId=$1" --fields id --format csv --noquotes 2>/dev/null \
    | head -n1
}

new_id="$(client_uuid "$NEW_CLIENT")"
old_id="$(client_uuid "$OLD_CLIENT")"

if [[ -n "$new_id" ]]; then
  echo "==> Client '$NEW_CLIENT' already exists — client rename already done"
  target_id="$new_id"
elif [[ -n "$old_id" ]]; then
  echo "==> Renaming client '$OLD_CLIENT' → '$NEW_CLIENT'"
  kcadm update "clients/$old_id" -r "$NEW_REALM" -s "clientId=$NEW_CLIENT"
  target_id="$old_id"
else
  echo "✗ Neither client '$OLD_CLIENT' nor '$NEW_CLIENT' exists in realm '$NEW_REALM'." >&2
  exit 1
fi

# ─── Step 4: the client secret is deliberately NOT touched ───────────────────
# An earlier version of this script rotated the secret when it was still the old
# compose default, reasoning that the default had moved. That was backwards:
# .env.example ASSIGNS KEYCLOAK_CLIENT_SECRET, and the documented setup is
# `cp .env.example .env`, so almost every install carries an explicit value that
# outranks the compose default entirely. Rotating in Keycloak would desync it
# from that file and break exactly the installs it meant to help.
#
# So: report, never write. Preflight A above already refused if .env still names
# the old realm, and it tells the operator to leave the secret alone.
current_secret="$(kcadm get "clients/$target_id/client-secret" -r "$NEW_REALM" \
  --fields value --format csv --noquotes 2>/dev/null | head -n1 || true)"

if [[ "$current_secret" == "$OLD_SECRET_DEFAULT" ]]; then
  echo "==> NOTE: the client secret is still the old default '$OLD_SECRET_DEFAULT'."
  echo "    Left unchanged, on purpose. It keeps working as long as .env's"
  echo "    KEYCLOAK_CLIENT_SECRET matches it — which it does, or you would not"
  echo "    have been able to log in before this migration either."
else
  echo "==> Client secret left untouched (operator-set)"
fi

# ─── Verify against the server, not against our own exit codes ───────────────
# kcadm exits 0 on writes it did not actually apply, so read the realm back.
echo "==> Verifying"
actual="$(kcadm get "realms/$NEW_REALM" 2>/dev/null || true)"
CHECKER="$(mktemp)"
trap 'rm -f "$CHECKER"' EXIT
cat > "$CHECKER" <<'PYCHECK'
import json, sys
want_realm, want_theme = sys.argv[1], sys.argv[2]
try:
    realm = json.load(sys.stdin)
except Exception as exc:
    sys.exit(f"✗ could not parse the realm kcadm returned: {exc}")
print(f"    realm:      {realm.get('realm')!r}")
print(f"    loginTheme: {realm.get('loginTheme')!r}")
if realm.get("realm") != want_realm:
    sys.exit(f"✗ realm is {realm.get('realm')!r}, expected {want_realm!r}.")
if realm.get("loginTheme") != want_theme:
    sys.exit(f"✗ loginTheme is {realm.get('loginTheme')!r}, expected {want_theme!r} — "
             "the login page would fall back to the stock Keycloak theme.")
PYCHECK
python3 "$CHECKER" "$NEW_REALM" "$NEW_THEME" <<<"$actual" || exit 1

if [[ -z "$(client_uuid "$NEW_CLIENT")" ]]; then
  echo "✗ client '$NEW_CLIENT' is not present after the rename." >&2
  exit 1
fi
echo "    client:     '$NEW_CLIENT'"

echo "✓ Keycloak migrated to realm '$NEW_REALM'"
echo "  Now restart api and web so they pick up the new issuer:"
echo "    docker compose up -d --force-recreate api web"
echo "  Existing sessions were issued by '$OLD_REALM' and are no longer valid —"
echo "  everyone signs in again once."

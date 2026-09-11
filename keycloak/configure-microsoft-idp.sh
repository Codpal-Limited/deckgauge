#!/bin/sh
set -e

# SOURCE_FILE is bind-mounted READ-ONLY from keycloak/realm-export.json.
# IMPORT_FILE is a plain container path that Keycloak's --import-realm reads.
# Keeping them separate is deliberate: this script used to read AND write the
# same bind-mounted path, so a processed realm could be written back over the
# developer's committed realm-export.json. The mount is now :ro and the output
# goes to a container-local path, which makes that structurally impossible.
#
# The two paths are env-overridable ONLY so the substitution logic can be
# exercised on a developer machine (see apps/web/__tests__/keycloak-password-reset.test.ts).
# Nothing sets them in any compose file, so the container behaviour is unchanged.
#
# NOTE: `jq` is NOT present in quay.io/keycloak/keycloak:26.7 (re-verified on
# the 24 -> 26 upgrade; it was not in 24.0 either). Every
# transformation below must work with `sed` alone.
SOURCE_FILE="${REALM_SRC_FILE:-/opt/keycloak/realm-src/realm.json}"
IMPORT_FILE="${REALM_IMPORT_FILE:-/opt/keycloak/data/import/realm.json}"
WORK_FILE="$(mktemp)"

cp "$SOURCE_FILE" "$WORK_FILE"

# `sed -i` is not portable: GNU takes an optional suffix, BSD/macOS REQUIRES one,
# so `sed -i "expr" file` silently means different things on the two. Write to a
# temp file and move instead — identical everywhere, and it keeps this script
# runnable outside the container.
inplace() {
  sed "$1" "$WORK_FILE" > "${WORK_FILE}.tmp" && mv "${WORK_FILE}.tmp" "$WORK_FILE"
}

# A value substituted into the realm passes through two layers that both have
# metacharacters, so it must be escaped for both — in this order.
#   JSON: a literal " or \ inside a string would end or escape it.
#   sed:  & means "the whole match" in a replacement, | is our delimiter, and \
#         starts an escape. An unescaped SMTP key containing any of them
#         corrupts the realm, and Keycloak then rejects a perfectly valid key.
json_escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }
sed_escape()  { printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g'; }

# subst PLACEHOLDER_NAME VALUE  ->  replaces __PLACEHOLDER_NAME__ everywhere.
subst() {
  _escaped="$(sed_escape "$(json_escape "$2")")"
  inplace "s|__$1__|${_escaped}|g"
}

if [ -n "$MICROSOFT_CLIENT_ID" ] && [ -n "$MICROSOFT_CLIENT_SECRET" ] && [ -n "$MICROSOFT_TENANT_ID" ]; then
  echo "Configuring Microsoft Entra ID identity provider..."
  subst MICROSOFT_CLIENT_ID "$MICROSOFT_CLIENT_ID"
  subst MICROSOFT_CLIENT_SECRET "$MICROSOFT_CLIENT_SECRET"
  subst MICROSOFT_TENANT_ID "$MICROSOFT_TENANT_ID"
else
  echo "Microsoft SSO env vars not set — removing Microsoft IdP from realm config..."
  if command -v jq >/dev/null 2>&1; then
    jq 'del(.identityProviders, .identityProviderMappers)' "$WORK_FILE" > "${WORK_FILE}.tmp" \
      && mv "${WORK_FILE}.tmp" "$WORK_FILE"
  else
    echo "Warning: jq not available — stripping IdP config via sed fallback"
    # [[:space:]] rather than \s: the latter is a GNU extension and matches
    # nothing on BSD sed, which would leave the block half-deleted.
    inplace '/"identityProviders"/,/^[[:space:]]*\]/d'
    inplace '/"identityProviderMappers"/,/^[[:space:]]*\]/d'
  fi
fi

# Substitute the hosted public origin into the web client's allowed origins.
#
# realm-export.json carries a __PUBLIC_ORIGIN__ placeholder in the
# deckgauge-web client's redirectUris and webOrigins, mirroring how the
# __MICROSOFT_* placeholders above already work. This is a plain sed
# substitution rather than JSON surgery because jq is not in this image.
#
# The placeholder is ALWAYS replaced, never left literal. When no hosted origin
# is set it becomes http://localhost:3000, which is already in both lists — a
# harmless duplicate. That avoids deleting array elements with sed, which is
# where this kind of script usually breaks.
if [ -n "${KEYCLOAK_PUBLIC_ORIGIN:-}" ]; then
  echo "Adding public origin to deckgauge-web: ${KEYCLOAK_PUBLIC_ORIGIN}"
  subst PUBLIC_ORIGIN "$KEYCLOAK_PUBLIC_ORIGIN"
else
  subst PUBLIC_ORIGIN "http://localhost:3000"
fi

# Where sign-out lands, which is a SEPARATE allowlist from the one above.
#
# Keycloak validates `post_logout_redirect_uri` against
# `post.logout.redirect.uris`, not against `redirectUris`. `+` means "the same
# as the valid redirect URIs" and is all a stack needs while sign-out returns to
# the app's own /login — which is every stack except the demo, where it returns
# to the commercial site, a DIFFERENT origin that `+` can never cover.
#
# This duplicates scripts/post-logout-redirect-uris.sh, deliberately: that one
# runs on the host to converge an already-running Keycloak (`--import-realm`
# only ever CREATES a realm, it never modifies one), and this container can
# source nothing from the host. apps/web/__tests__/keycloak-post-logout.test.ts
# executes both and fails if they disagree, so read that file before editing
# either. Keep POST_LOGOUT_REDIRECT_URL identical to the web container's.
#
# `##` is Keycloak's Constants.CFG_DELIMITER. The origin gets both a bare entry
# and a wildcard one because Keycloak matches literally without the wildcard, so
# a destination that later grows a path would stop matching.
POST_LOGOUT_URL="$(printf '%s' "${POST_LOGOUT_REDIRECT_URL:-}" \
  | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
if [ -n "$POST_LOGOUT_URL" ]; then
  # VALIDATE BEFORE EXTRACTING. Byte-for-byte the same rule as the host script's
  # — see the commentary there for what each rejected shape does if allowed. It
  # matters MORE here: the host script's caller assigns its output under
  # `set -euo pipefail`, so a bad value aborts there anyway, whereas this copy
  # would otherwise write whatever it was handed straight into the allowlist of
  # a realm about to be created. Failing the container start is the correct loud
  # failure; a realm imported with a nonsense allowlist is a silent one.
  if ! printf '%s' "$POST_LOGOUT_URL" \
    | grep -qE '^https?://[A-Za-z0-9.-]+(:[0-9]+)?([/?#]|$)'; then
    echo "ERROR: POST_LOGOUT_REDIRECT_URL must be http(s)://host[:port][/path] — got: $POST_LOGOUT_URL" >&2
    exit 1
  fi
  POST_LOGOUT_ORIGIN="$(printf '%s' "$POST_LOGOUT_URL" \
    | sed -E 's#^(https?://[^/?#]+).*#\1#')"
  echo "Allowing post-logout redirect to: ${POST_LOGOUT_ORIGIN}"
  subst POST_LOGOUT_REDIRECT_URIS "+##${POST_LOGOUT_ORIGIN}##${POST_LOGOUT_ORIGIN}/*"
else
  subst POST_LOGOUT_REDIRECT_URIS "+"
fi

# ---------------------------------------------------------------------------
# SMTP — required for the forgot-password flow.
#
# Keycloak speaks SMTP only; it has no API mail path. Every value below is a
# placeholder in the committed realm so that NO credential is ever stored in
# git — the realm export is a public file. Defaults point at the Mailpit sink
# in docker-compose.yml, so a stock local stack has a working, non-delivering
# reset flow with nothing to configure.
#
# Keycloak's realm representation types all of these as STRINGS, including the
# booleans. Do not "fix" the quotes.
# ---------------------------------------------------------------------------
if [ -z "${SMTP_AUTH:-}" ]; then
  # Set a username and you almost certainly mean to authenticate. Deriving it
  # removes the failure where credentials are supplied but silently unused.
  if [ -n "${SMTP_USER:-}" ]; then SMTP_AUTH=true; else SMTP_AUTH=false; fi
fi

echo "Configuring SMTP: host=${SMTP_HOST:-mailpit} port=${SMTP_PORT:-1025} auth=${SMTP_AUTH}"
# The deckgauge-web client secret. Placeholder rather than a literal in the
# export so that demo/.env.demo (or .env) is the SINGLE SOURCE OF TRUTH: a fresh
# realm import takes the operator's value, so wiping keycloak_db_data is
# self-healing instead of silently re-importing a default that no longer matches
# what the web container presents. Before this, a volume wipe left the realm on
# the published default while the env file held a rotated value, and login broke
# with nothing to point at.
#
# There is NO DEFAULT, and that is the point. This line used to read
# `${KEYCLOAK_CLIENT_SECRET:-deckgauge-secret}` "so a community clone works with
# no configuration" — which meant every clone that did not configure one got the
# secret printed in this public repository, stamped into its realm at import,
# silently. docker-compose.yml requires the variable now (`${VAR:?…}`), so the
# container always receives one and this fallback could only ever fire on a path
# where something else is already wrong. Failing there is strictly better than
# quietly publishing a known secret into a fresh realm.
: "${KEYCLOAK_CLIENT_SECRET:?KEYCLOAK_CLIENT_SECRET is unset. docker-compose.yml requires it; run ./scripts/init-env.sh to generate one.}"
subst CLIENT_SECRET          "${KEYCLOAK_CLIENT_SECRET}"
subst SMTP_HOST              "${SMTP_HOST:-mailpit}"
subst SMTP_PORT              "${SMTP_PORT:-1025}"
subst SMTP_FROM              "${SMTP_FROM:-no-reply@deckgauge.com}"
subst SMTP_FROM_DISPLAY_NAME "${SMTP_FROM_DISPLAY_NAME:-Deckgauge}"
subst SMTP_REPLY_TO          "${SMTP_REPLY_TO:-}"
subst SMTP_SSL               "${SMTP_SSL:-false}"
subst SMTP_STARTTLS          "${SMTP_STARTTLS:-false}"
subst SMTP_AUTH              "${SMTP_AUTH}"
subst SMTP_USER              "${SMTP_USER:-}"
subst SMTP_PASSWORD          "${SMTP_PASSWORD:-}"

# Write the processed config to Keycloak's import directory. NEVER write to
# SOURCE_FILE — it is the developer's committed file, mounted read-only.
mkdir -p "$(dirname "$IMPORT_FILE")"
cat "$WORK_FILE" > "$IMPORT_FILE"
rm -f "$WORK_FILE"

exec "$@"

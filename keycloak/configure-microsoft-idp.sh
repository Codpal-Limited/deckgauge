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
# NOTE: `jq` is NOT present in quay.io/keycloak/keycloak:24.0 (verified). Every
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
# vp-cockpit-web client's redirectUris and webOrigins, mirroring how the
# __MICROSOFT_* placeholders above already work. This is a plain sed
# substitution rather than JSON surgery because jq is not in this image.
#
# The placeholder is ALWAYS replaced, never left literal. When no hosted origin
# is set it becomes http://localhost:3000, which is already in both lists — a
# harmless duplicate. That avoids deleting array elements with sed, which is
# where this kind of script usually breaks.
if [ -n "${KEYCLOAK_PUBLIC_ORIGIN:-}" ]; then
  echo "Adding public origin to vp-cockpit-web: ${KEYCLOAK_PUBLIC_ORIGIN}"
  subst PUBLIC_ORIGIN "$KEYCLOAK_PUBLIC_ORIGIN"
else
  subst PUBLIC_ORIGIN "http://localhost:3000"
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

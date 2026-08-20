#!/bin/sh
set -e

# SOURCE_FILE is bind-mounted READ-ONLY from keycloak/realm-export.json.
# IMPORT_FILE is a plain container path that Keycloak's --import-realm reads.
# Keeping them separate is deliberate: this script used to read AND write the
# same bind-mounted path, so a processed realm could be written back over the
# developer's committed realm-export.json. The mount is now :ro and the output
# goes to a container-local path, which makes that structurally impossible.
#
# NOTE: `jq` is NOT present in quay.io/keycloak/keycloak:24.0 (verified). Every
# transformation below must work with `sed` alone.
SOURCE_FILE="/opt/keycloak/realm-src/realm.json"
IMPORT_FILE="/opt/keycloak/data/import/realm.json"
WORK_FILE="/tmp/realm.json"

cp "$SOURCE_FILE" "$WORK_FILE"

if [ -n "$MICROSOFT_CLIENT_ID" ] && [ -n "$MICROSOFT_CLIENT_SECRET" ] && [ -n "$MICROSOFT_TENANT_ID" ]; then
  echo "Configuring Microsoft Entra ID identity provider..."
  sed -i "s|__MICROSOFT_CLIENT_ID__|${MICROSOFT_CLIENT_ID}|g" "$WORK_FILE"
  sed -i "s|__MICROSOFT_CLIENT_SECRET__|${MICROSOFT_CLIENT_SECRET}|g" "$WORK_FILE"
  sed -i "s|__MICROSOFT_TENANT_ID__|${MICROSOFT_TENANT_ID}|g" "$WORK_FILE"
else
  echo "Microsoft SSO env vars not set — removing Microsoft IdP from realm config..."
  if command -v jq >/dev/null 2>&1; then
    jq 'del(.identityProviders, .identityProviderMappers)' "$WORK_FILE" > "${WORK_FILE}.tmp" \
      && mv "${WORK_FILE}.tmp" "$WORK_FILE"
  else
    echo "Warning: jq not available — stripping IdP config via sed fallback"
    sed -i '/"identityProviders"/,/^\s*\]/d' "$WORK_FILE"
    sed -i '/"identityProviderMappers"/,/^\s*\]/d' "$WORK_FILE"
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
  sed -i "s|__PUBLIC_ORIGIN__|${KEYCLOAK_PUBLIC_ORIGIN}|g" "$WORK_FILE"
else
  sed -i "s|__PUBLIC_ORIGIN__|http://localhost:3000|g" "$WORK_FILE"
fi

# Write the processed config to Keycloak's import directory. NEVER write to
# SOURCE_FILE — it is the developer's committed file, mounted read-only.
mkdir -p "$(dirname "$IMPORT_FILE")"
cat "$WORK_FILE" > "$IMPORT_FILE"

exec "$@"

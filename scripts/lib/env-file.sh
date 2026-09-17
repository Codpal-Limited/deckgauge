# shellcheck shell=bash
#
# Read one credential out of .env — without sourcing it.
#
# ─── Why a library rather than a fallback ───────────────────────────────────
#
# scripts/backup.sh, scripts/restore.sh and scripts/apply-clickhouse-schemas.sh
# each carried their own `CH_PASS="${CLICKHOUSE_PASSWORD:-cockpit}"`. None of the
# three reads .env for credentials, only for PORTS (lib/staging-ports.sh), so
# that fallback was not a fallback at all: with the variable unset in the shell —
# the normal case — every one of them ALWAYS used `cockpit`. It worked because
# the whole fleet shared one committed password.
#
# Now that `./scripts/init-env.sh` gives each install its own, a guess is wrong
# by construction, and wrong in the least helpful way: ClickHouse answers 516
# AUTHENTICATION_FAILED and the script reports the backup as failed without
# mentioning where it got the password.
#
# ─── Why not `source .env` ──────────────────────────────────────────────────
#
# That file holds tokens and passwords, and an unquoted value with a space in it
# executes as a command — a real defect found in demo/deploy-demo.sh, where
# `RATE_LIMIT_WINDOW=1 minute` ran `minute`. Same reason lib/staging-ports.sh
# reads one integer per key with sed. This is that function, widened from
# integers to arbitrary values.
#
# Usage (the caller sets DG_PROJECT_ROOT first, as with staging-ports.sh):
#     DG_PROJECT_ROOT="$PROJECT_ROOT"
#     source "$PROJECT_ROOT/scripts/lib/env-file.sh"
#     CH_PASS="$(dg_require_env CLICKHOUSE_PASSWORD)" || exit 1
#
# An environment variable exported by the caller always wins over .env, which is
# what lets a deploy pass a value in without editing anyone's file.

# Print the value of KEY from .env, or nothing. Never fails.
dg_env_string() {
  local key="$1" root="${DG_PROJECT_ROOT:-.}" val=''
  # The exported environment wins.
  eval "val=\${$key-}"
  if [[ -z "$val" && -f "$root/.env" ]]; then
    val="$(sed -n -E "s/^[[:space:]]*${key}=[[:space:]]*(.*)$/\1/p" "$root/.env" | tail -n 1)"
    # Strip one pair of surrounding quotes, and a trailing comment is NOT
    # stripped: a `#` is a legal character in a generated secret, and silently
    # truncating a password at one would be a very confusing auth failure.
    val="${val%\"}"; val="${val#\"}"
    val="${val%\'}"; val="${val#\'}"
  fi
  printf '%s' "$val"
}

# Same, but fail loudly and usefully when it is not set anywhere.
dg_require_env() {
  local key="$1" val
  val="$(dg_env_string "$key")"
  if [[ -z "$val" ]]; then
    {
      echo ""
      echo "ERROR: $key is not set, and this script needs it to authenticate."
      echo ""
      echo "  It used to fall back to a committed default (\`cockpit\` / \`admin\`),"
      echo "  which every install shared. Installs now generate their own:"
      echo ""
      echo "      ./scripts/init-env.sh          # a new install"
      echo "      ./scripts/init-env.sh --check  # see what an existing .env is missing"
      echo ""
      echo "  Or export $key for this one command."
      echo ""
    } >&2
    return 1
  fi
  printf '%s' "$val"
}

# ─── Credential encryption key ──────────────────────────────────────────────
#
# Ensure CREDENTIAL_ENCRYPTION_KEY exists in an env file, generating one if it
# does not. Prints nothing on success; the caller re-reads the file afterwards.
#
# GENERATE-IF-ABSENT, never regenerate. That asymmetry is the whole point:
#
#  - A deployment that predates credential encryption has no key and cannot
#    start without one, so a deploy that refuses here would strand every
#    existing install — including the live public demo — behind a manual step
#    on a box. CLAUDE.md is explicit that an instruction for a human to run on
#    the VM means the deploy script is missing one.
#  - Once rows are sealed, the key is the ONLY thing that can open them.
#    Replacing it silently would destroy every stored credential and surface,
#    much later, as "all our syncs are failing". So an existing value is never
#    touched, whatever its shape — a malformed one is reported by the api at
#    startup, which names the variable, rather than repaired by guesswork here.
#
# Back the generated key up with the database. Losing it means re-entering every
# provider connection by hand.
dg_ensure_credential_key() {
  local file="$1"
  if [[ ! -f "$file" ]]; then
    echo "ERROR: $file does not exist." >&2
    return 1
  fi
  if grep -qE '^CREDENTIAL_ENCRYPTION_KEY=.+' "$file"; then
    return 0
  fi

  local key
  if command -v openssl >/dev/null 2>&1; then
    key="$(openssl rand -hex 32)"
  elif [[ -r /dev/urandom ]]; then
    key="$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')"
  else
    echo "ERROR: no source of randomness (need openssl or /dev/urandom)." >&2
    return 1
  fi

  # An empty `CREDENTIAL_ENCRYPTION_KEY=` line (from the template) is replaced
  # rather than duplicated; otherwise the key is appended.
  if grep -qE '^CREDENTIAL_ENCRYPTION_KEY=' "$file"; then
    local tmp="${file}.tmp.$$"
    sed "s|^CREDENTIAL_ENCRYPTION_KEY=.*|CREDENTIAL_ENCRYPTION_KEY=${key}|" "$file" >"$tmp"
    # `-s` before the copy-back. If sed failed, $tmp is EMPTY and an unguarded
    # `cat "$tmp" >"$file"` truncates the caller's .env — taking every other
    # secret in it with the one we were adding. Callers run `set -e` today and
    # would abort first, but this is a library and nothing enforces that on the
    # next one.
    if [[ ! -s "$tmp" ]]; then
      rm -f "$tmp"
      echo "ERROR: failed to rewrite $file; it is unchanged." >&2
      return 1
    fi
    cat "$tmp" >"$file" && rm -f "$tmp"
  else
    printf '\n# Generated by the deploy. Back this up WITH the database.\nCREDENTIAL_ENCRYPTION_KEY=%s\n' "$key" >>"$file"
  fi

  echo "==> Generated CREDENTIAL_ENCRYPTION_KEY in $(basename "$file") (back it up with the database)"
}

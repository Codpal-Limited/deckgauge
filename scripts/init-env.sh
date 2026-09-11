#!/usr/bin/env bash
# Write a working .env from .env.example, generating a fresh secret for every
# credential the stack needs.
#
#   ./scripts/init-env.sh                 # create ./.env (refuses to overwrite)
#   ./scripts/init-env.sh --force         # overwrite (keeps .env.bak-<timestamp>)
#   ./scripts/init-env.sh --out PATH      # write somewhere else
#   ./scripts/init-env.sh --check [PATH]  # verify an existing .env, write nothing
#
# ─── Why this exists ────────────────────────────────────────────────────────
#
# The documented install used to be `cp .env.example .env && docker compose up
# -d`, and it worked because `.env.example` ASSIGNED `POSTGRES_PASSWORD=cockpit`
# and `KEYCLOAK_ADMIN_PASSWORD=admin` while docker-compose.yml carried the same
# values a second time as `${POSTGRES_PASSWORD:-cockpit}` fallbacks. Every
# install on earth therefore shared one password, published in a public
# repository, on ports that bind 0.0.0.0 unless BIND_HOST is set.
#
# Deleting the literals alone would have broken the one-command install, which
# is the other thing a public launch cannot afford. So the literals are gone AND
# the one command still exists — it is this script instead of `cp`.
#
# ─── How it reads .env.example ──────────────────────────────────────────────
#
# Every line is copied verbatim except the ones a directive comment marks:
#
#   # init-env: generate            → fill the NEXT assignment with a fresh secret
#   # init-env: derive <template>   → fill it by expanding ${NAME} references
#
# The directives live in the template rather than in a list here, so adding a
# secret is a one-line change in one file, and `.env.example` stays the single
# description of the configuration. Values resolved earlier in the file are
# available to a later `derive`, which is how DATABASE_URL gets the password
# that POSTGRES_PASSWORD was just given.
#
# Secrets are HEX. Not for entropy — 24 bytes of hex is 192 bits either way —
# but because they are interpolated into connection URLs
# (postgresql://user:PASS@host) and substituted into the Keycloak realm JSON
# with sed. Hex has no character that needs escaping in either, which removes a
# whole class of "the password with the slash in it" failure.
#
# ─── What it will not do ────────────────────────────────────────────────────
#
# It refuses to overwrite an existing .env without --force, because the password
# in there is the one the Postgres VOLUME was initialised with. Postgres reads
# POSTGRES_PASSWORD only on first init, so regenerating over a live install
# locks the stack out of its own database — and the resulting authentication
# error names neither this script nor the volume. With --force it keeps a copy at
# `.env.bak-<timestamp>`, a name `.gitignore` already covers.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
TEMPLATE="$PROJECT_ROOT/.env.example"

MODE="write"
FORCE=0
OUT=""

usage() {
  sed -n '2,9p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --force) FORCE=1 ;;
    --check) MODE="check" ;;
    --out) shift; OUT="${1:-}"; [[ -n "$OUT" ]] || { echo "--out needs a path" >&2; exit 2; } ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
    *) OUT="$1" ;;
  esac
  shift
done

OUT="${OUT:-$PROJECT_ROOT/.env}"

[[ -f "$TEMPLATE" ]] || { echo "ERROR: no .env.example at $TEMPLATE" >&2; exit 1; }

# ─── Randomness ─────────────────────────────────────────────────────────────
# openssl is on every macOS and essentially every Linux; /dev/urandom is the
# fallback so a container image without openssl still works. `od` is POSIX.
rand_hex() {
  local bytes="$1"
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$bytes"
  elif [[ -r /dev/urandom ]]; then
    od -An -tx1 -N"$bytes" /dev/urandom | tr -d ' \n'
  else
    echo "ERROR: no source of randomness (need openssl or /dev/urandom)." >&2
    exit 1
  fi
}

# ─── Resolved values, for `derive` to reference ─────────────────────────────
# bash 3.2 (which is what macOS ships) has no associative arrays, so the map is
# held in individually-named variables. Keys are matched as [A-Z][A-Z0-9_]* by
# the caller, so the eval cannot reach anything else.
remember() { eval "DG_RESOLVED_$1=\$2"; }
recall()   { eval "printf '%s' \"\${DG_RESOLVED_$1-}\""; }

expand() {
  local template="$1" out="" name value
  while [[ "$template" =~ ^([^\$]*)\$\{([A-Z][A-Z0-9_]*)\}(.*)$ ]]; do
    out+="${BASH_REMATCH[1]}"
    name="${BASH_REMATCH[2]}"
    template="${BASH_REMATCH[3]}"
    value="$(recall "$name")"
    if [[ -z "$value" ]]; then
      echo "ERROR: .env.example derives a value from \${$name}, which is not set above it." >&2
      exit 1
    fi
    out+="$value"
  done
  printf '%s' "$out$template"
}

# ─── Pass 1: build the file ─────────────────────────────────────────────────
# Accumulated in a variable and written ONCE. Appending each line with `>>` costs
# ~2.8s for this template on a macOS host with file-access scanning — 377 opens —
# which is slow enough to be noticed in the first command a new user runs, and
# slow enough to time out a test that runs the script twice.
OUTPUT=""

pending_kind=""
pending_arg=""
generated_keys=()
# Keys the template assigns a LITERAL value — usernames, database names, URLs.
# Not credentials, so `--check` reports them as a notice rather than a failure,
# but a key the template declares and an existing .env has never heard of is
# exactly what CLICKHOUSE_USER became, and the published upgrade instructions
# promise this tool will name it.
literal_keys=""

while IFS= read -r line || [[ -n "$line" ]]; do
  if [[ "$line" =~ ^#[[:space:]]*init-env:[[:space:]]*generate([[:space:]]+([0-9]+))?[[:space:]]*$ ]]; then
    pending_kind="generate"
    pending_arg="${BASH_REMATCH[2]:-24}"
    OUTPUT+="$line"$'\n'
    continue
  fi
  if [[ "$line" =~ ^#[[:space:]]*init-env:[[:space:]]*derive[[:space:]]+(.*)$ ]]; then
    pending_kind="derive"
    pending_arg="${BASH_REMATCH[1]}"
    OUTPUT+="$line"$'\n'
    continue
  fi

  if [[ "$line" =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]]; then
    key="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"

    pending_kind_used="$pending_kind"
    case "$pending_kind" in
      generate)
        if [[ -n "${value// /}" ]]; then
          echo "ERROR: $key is marked 'init-env: generate' but .env.example already assigns it." >&2
          echo "       A literal there is exactly the committed default this script removes." >&2
          exit 1
        fi
        value="$(rand_hex "$pending_arg")"
        generated_keys+=("$key")
        ;;
      derive)
        value="$(expand "$pending_arg")"
        generated_keys+=("$key")
        ;;
    esac
    if [[ -z "$pending_kind_used" && -n "${value// /}" ]]; then
      literal_keys="$literal_keys $key"
    fi
    pending_kind=""; pending_arg=""

    # Strip surrounding quotes before remembering, so a derived URL does not end
    # up with a quote in the middle of it.
    unquoted="$value"
    unquoted="${unquoted%\"}"; unquoted="${unquoted#\"}"
    unquoted="${unquoted%\'}"; unquoted="${unquoted#\'}"
    remember "$key" "$unquoted"

    OUTPUT+="$key=$value"$'\n'
    continue
  fi

  # Any other line — comment, blank, commented-out key — is copied untouched,
  # and clears a directive that was not followed by an assignment.
  [[ "$line" =~ ^[[:space:]]*$ ]] && { pending_kind=""; pending_arg=""; }
  OUTPUT+="$line"$'\n'
done < "$TEMPLATE"

if [[ ${#generated_keys[@]} -eq 0 ]]; then
  echo "ERROR: .env.example carries no 'init-env:' directive — nothing to generate." >&2
  echo "       Either the template regressed to committed literals, or this script" >&2
  echo "       is looking at the wrong file ($TEMPLATE)." >&2
  exit 1
fi

# ─── Pass 2: nothing required may have been left empty ──────────────────────
# Cheap, and it is the assertion that would have caught a directive typo: a
# misspelled `# init-env: genrate` copies the empty line through in silence and
# the stack then fails at `docker compose up` with a variable name and no cause.
missing=()
for key in "${generated_keys[@]}"; do
  [[ -n "$(recall "$key")" ]] || missing+=("$key")
done
if [[ ${#missing[@]} -gt 0 ]]; then
  echo "ERROR: left empty after generation: ${missing[*]}" >&2
  exit 1
fi

# ─── --check: report on an existing file, write nothing ─────────────────────
if [[ "$MODE" == "check" ]]; then
  if [[ ! -f "$OUT" ]]; then
    echo "✗ no env file at $OUT — run ./scripts/init-env.sh" >&2
    exit 1
  fi
  unset_keys=()
  for key in "${generated_keys[@]}"; do
    existing="$(grep -E "^${key}=" "$OUT" | tail -n1 | cut -d= -f2- || true)"
    existing="${existing%\"}"; existing="${existing#\"}"
    [[ -n "${existing// /}" ]] || unset_keys+=("$key")
  done

  # Keys the template DECLARES that the target has never heard of. Not a failure:
  # docker-compose.yml still defaults every one of them, because they are
  # identifiers rather than secrets. Reported because an existing .env predates
  # them — CLICKHOUSE_USER is the worked example — and because a tool that says
  # "every credential is set" while staying silent about a key the template added
  # is answering a narrower question than the reader asked.
  absent_keys=()
  for key in $literal_keys; do
    grep -qE "^${key}=" "$OUT" || absent_keys+=("$key")
  done

  if [[ ${#absent_keys[@]} -gt 0 ]]; then
    echo "· $OUT does not mention: ${absent_keys[*]}"
    echo "  Not required — docker-compose.yml defaults each of these, and they are"
    echo "  identifiers rather than secrets. Add them if you want one file to be"
    echo "  the whole answer."
  fi

  if [[ ${#unset_keys[@]} -gt 0 ]]; then
    echo "✗ $OUT leaves these unset: ${unset_keys[*]}" >&2
    echo "  Every one is REQUIRED — docker-compose.yml refuses to render without" >&2
    echo "  it. Set each to the value your existing volumes were created with, or" >&2
    echo "  start over from the template with --force." >&2
    exit 1
  fi
  echo "✓ $OUT sets every credential the stack requires"
  exit 0
fi

# ─── Write ──────────────────────────────────────────────────────────────────
if [[ -e "$OUT" && "$FORCE" -ne 1 ]]; then
  echo "ERROR: $OUT already exists." >&2
  echo "" >&2
  echo "       Not overwriting it. The passwords in there are the ones your" >&2
  echo "       Postgres, ClickHouse and Keycloak VOLUMES were created with —" >&2
  echo "       those images read the password only on first start, so a fresh" >&2
  echo "       one locks the stack out of its own data." >&2
  echo "" >&2
  echo "       To check it instead:   ./scripts/init-env.sh --check" >&2
  echo "       To overwrite anyway:   ./scripts/init-env.sh --force" >&2
  echo "       (only safe alongside 'docker compose down -v', which deletes the data)" >&2
  exit 1
fi

# --force is destructive in a way that is not recoverable from anywhere else: the
# passwords it overwrites are the only record of what the Postgres, ClickHouse
# and Keycloak VOLUMES were initialised with, and those images read the password
# only on first start. So keep a copy.
#
# The name is `.env.bak-<timestamp>` on purpose: `.gitignore` carries `.env.bak*`,
# so the backup lands inside the ignore rule BY CONSTRUCTION rather than by the
# next person choosing a covered name. Two such files — written by hand, as the
# upgrade instructions say to — sat untracked in this repository holding the
# complete live credential set, offered by `git status` as staging candidates.
#
# The reassurance is CONDITIONAL, because on the `--out <name>` path it would be
# false: `.gitignore` carries `.env.bak*`, which covers `<dir>/.env.bak-<ts>` and
# nothing else. `--out env.staging` produces `env.staging.bak-<ts>`, which git
# will happily offer you. Printing "(gitignored)" there would be this script
# asserting the opposite of what planning/STATE.md records as a known limit —
# and a false reassurance about a cleartext credential file is worse than no
# reassurance at all.
if [[ -e "$OUT" ]]; then
  BACKUP="${OUT}.bak-$(date +%Y%m%d%H%M%S)"
  cp "$OUT" "$BACKUP"
  chmod 600 "$BACKUP"
  case "$(basename "$BACKUP")" in
    .env.bak*)
      echo "· kept your previous file at $BACKUP (gitignored)" ;;
    *)
      echo "· kept your previous file at $BACKUP"
      echo "  WARNING: that name is NOT covered by .gitignore's .env.bak* rule, and it"
      echo "  holds a complete set of credentials in cleartext. Move it somewhere"
      echo "  ignored, or delete it once you no longer need it." ;;
  esac
fi

# Create it empty and restricted BEFORE the secrets go in, so there is no window
# in which a world-readable file holds them.
: > "$OUT"
chmod 600 "$OUT"
printf '%s' "$OUTPUT" > "$OUT"

echo "✓ wrote $OUT (mode 600)"
echo "  generated: ${generated_keys[*]}"
echo ""
echo "  Values are NOT printed. Read them out of the file if you need one —"
echo "  the Keycloak admin console signs in with KEYCLOAK_ADMIN_USER /"
echo "  KEYCLOAK_ADMIN_PASSWORD from it."

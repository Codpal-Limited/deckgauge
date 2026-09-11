#!/usr/bin/env bash
# Guards the self-host invariant: with NO hosted env vars set, the rendered
# compose config must not change. Spec §7 requires the self-host and OSS
# distributions to behave exactly as they do today, and every hosted setting is
# introduced as ${VAR:-<current value>} — this proves the defaults still render
# identically.
#
#   scripts/check-compose-defaults.sh            # verify (exit 1 on drift)
#   scripts/check-compose-defaults.sh --update   # re-record after an intended change
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
SNAPSHOT="$SCRIPT_DIR/__snapshots__/compose-defaults.yml"
cd "$PROJECT_ROOT"

# Render with an env file carrying NOTHING but the required variables, so a
# developer's own .env cannot leak in and make the snapshot machine-specific.
# `docker compose config` resolves ${VAR:-default} substitutions, which is
# exactly what we want to pin.
#
# It used to be literally empty. Every credential is `${VAR:?...}` now — see
# scripts/lib/compose-required-env.sh for why the alternative was worse than a
# failing check: an empty file makes the render FAIL, and a failed render is
# empty output, which `--update` would have recorded as the blessed snapshot.
EMPTY_ENV="$(mktemp)"
trap 'rm -f "$EMPTY_ENV"' EXIT
# shellcheck source=lib/compose-required-env.sh
source "$SCRIPT_DIR/lib/compose-required-env.sh"
write_compose_required_env "$EMPTY_ENV"

# Compose derives the project name from the checkout's directory basename, and
# then prefixes it onto every network and volume name. Normalising only the
# absolute path and the `name:` line is NOT enough — those derived names still
# differ between the primary checkout and each worktree, which made an earlier
# version of this snapshot non-portable despite containing no absolute paths.
#
# TWO THINGS BELOW ARE ASKED OF COMPOSE RATHER THAN GUESSED, because guessing
# them made this check fail on files nobody had touched:
#
#  1. THE PROJECT NAME. This used to be `basename "$PROJECT_ROOT"`. Compose
#     LOWERCASES that basename (and drops characters it disallows), so a
#     checkout at `.../Cockpit` derived `Cockpit` while the rendered volumes
#     said `cockpit_`. The substitution then matched nothing, and all five
#     volumes plus the network reported as drift — on a checkout whose only sin
#     was a capital letter. It is now read back out of the render's own `name:`
#     line, which is Compose's answer rather than our reconstruction of it.
#
#  2. THE `bind:` SHAPE. Compose renders a read-only bind mount as either
#     `bind: {}` or the expanded `bind:\n  create_host_path: true`, depending on
#     its own version. Identical meaning, six occurrences, and enough to fail the
#     whole check on a machine whose Compose simply differs from the one that
#     recorded the snapshot. Canonicalised to one form.
#
# Both normalisations are applied to the STORED SNAPSHOT as well as to the fresh
# render, so an existing snapshot stays valid and no re-record is needed to adopt
# this. Canonicalising an already-canonical file is a no-op.
canonicalise() {
  PROJECT_ROOT="$PROJECT_ROOT" python3 -c '
import os, re, sys

text = sys.stdin.read()
root = os.environ["PROJECT_ROOT"]

m = re.search(r"^name: (.+)$", text, re.M)
project = m.group(1).strip() if m else ""

text = text.replace(root, "__PROJECT_ROOT__")
text = re.sub(r"^name: .*$", "name: __PROJECT_NAME__", text, flags=re.M)
if project:
    text = text.replace(project + "_", "__PROJECT_NAME___")
text = re.sub(r"^([ \t]*)bind:\n[ \t]*create_host_path: true\n", r"\1bind: {}\n", text, flags=re.M)

sys.stdout.write(text)
'
}

# stderr is kept, and the exit status is checked, precisely because the snapshot
# is written from this function. A silently-failing render records an empty file.
render() {
  local rendered
  if ! rendered="$(docker compose --env-file "$EMPTY_ENV" -f docker-compose.yml config)"; then
    echo "✗ 'docker compose config' failed — see the error above." >&2
    echo "  Nothing was written. If a new \${VAR:?} was added, it is picked up" >&2
    echo "  automatically by scripts/lib/compose-required-env.sh; a failure here" >&2
    echo "  means the compose file itself does not parse." >&2
    exit 1
  fi
  printf '%s\n' "$rendered" | canonicalise
}

mkdir -p "$(dirname "$SNAPSHOT")"

if [[ "${1:-}" == "--update" ]]; then
  render > "$SNAPSHOT"
  echo "✓ snapshot re-recorded: $SNAPSHOT"
  exit 0
fi

if [[ ! -f "$SNAPSHOT" ]]; then
  echo "ERROR: no snapshot at $SNAPSHOT — run with --update first." >&2
  exit 1
fi

if diff -u <(canonicalise < "$SNAPSHOT") <(render); then
  echo "✓ compose defaults unchanged"
else
  cat >&2 <<'EOF'

✗ The default (self-host) compose config CHANGED.

Spec §7: self-host behaviour must not change. Either:
  - your ${VAR:-default} does not reproduce the previous literal value, or
  - the change is intended, in which case re-record deliberately:
        scripts/check-compose-defaults.sh --update
    and say so in the commit message.
EOF
  exit 1
fi

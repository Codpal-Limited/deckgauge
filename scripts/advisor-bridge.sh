#!/bin/bash
# Advisor local-agent bridge — start / stop / status as a detached host process.
#
# Why a script instead of a compose service: the bridge spawns your local ACP
# adapter (`claude-agent-acp` / `codex-acp`), which authenticates as *your*
# signed-in Claude Code or Codex session. A container has neither the binary
# nor that login, so the bridge can only ever run on the host — next to the
# containers, not inside them. See docs/advisor-local-agent.md.
#
# Usage:
#   scripts/advisor-bridge.sh start    # detach, wait for readiness, report
#   scripts/advisor-bridge.sh stop
#   scripts/advisor-bridge.sh status
#
# `pnpm deckgauge:advisor` still runs it in the foreground, which is what you
# want while developing. This wrapper is for unattended starts — a deploy
# pipeline, a login script — where nothing is around to hold a terminal open.

set -e

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${ADVISOR_BRIDGE_PORT:-4779}"
PID_FILE="$REPO_ROOT/.advisor-bridge.pid"
LOG_FILE="$REPO_ROOT/.advisor-bridge.log"
READY_TIMEOUT_SECONDS="${ADVISOR_BRIDGE_READY_TIMEOUT:-30}"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log_step() { echo -e "${GREEN}▶${NC} $1"; }
log_info() { echo -e "${YELLOW}·${NC} $1"; }
log_fail() { echo -e "${RED}✗${NC} $1" >&2; }

# PID of whatever is listening on $PORT, empty if nothing is. lsof is present
# on macOS and most Linux images; if it is missing we fall back to "unknown"
# rather than wrongly reporting the port free (which would start a second
# bridge that then dies on EADDRINUSE).
listener_pid() {
  if command -v lsof > /dev/null 2>&1; then
    lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2> /dev/null | head -1
  else
    echo ""
  fi
}

port_is_bound() {
  if command -v lsof > /dev/null 2>&1; then
    [ -n "$(listener_pid)" ]
  elif command -v nc > /dev/null 2>&1; then
    nc -z 127.0.0.1 "$PORT" > /dev/null 2>&1
  else
    # No way to check — assume free and let the CLI's own EADDRINUSE guard
    # produce the error rather than silently doing nothing.
    return 1
  fi
}

cmd_status() {
  if port_is_bound; then
    local pid
    pid="$(listener_pid)"
    log_step "Advisor bridge is running on 127.0.0.1:$PORT${pid:+ (pid $pid)}"
    return 0
  fi
  log_info "Advisor bridge is not running (nothing listening on 127.0.0.1:$PORT)"
  return 1
}

cmd_start() {
  if port_is_bound; then
    log_info "Advisor bridge already listening on 127.0.0.1:$PORT — leaving it alone."
    return 0
  fi

  if [ -z "${DECKGAUGE_TOKEN:-}" ]; then
    log_info "No DECKGAUGE_TOKEN set — the Advisor panel will authenticate this bridge with"
    log_info "  your own signed-in Deckgauge session. Set DECKGAUGE_TOKEN only to run it"
    log_info "  headless, with no browser. See docs/advisor-local-agent.md."
  fi

  log_step "Starting advisor bridge (detached) on 127.0.0.1:$PORT..."
  : > "$LOG_FILE"
  # Detached and fully redirected: callers are typically hooks or deploy steps
  # with no terminal, whose process group goes away when the caller returns.
  (
    cd "$REPO_ROOT"
    nohup pnpm deckgauge:advisor >> "$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"
  )

  # Don't claim success before it is actually serving: wait for the port, and
  # bail out early if the CLI has already given up (no agent installed, port
  # conflict) so the caller sees the real reason instead of a timeout.
  local waited=0
  while [ "$waited" -lt "$READY_TIMEOUT_SECONDS" ]; do
    if port_is_bound; then
      log_step "Advisor bridge ready — $(grep -m1 'Detected' "$LOG_FILE" 2> /dev/null || echo "listening on 127.0.0.1:$PORT")"
      return 0
    fi
    if ! kill -0 "$(cat "$PID_FILE" 2> /dev/null)" 2> /dev/null; then
      log_fail "Advisor bridge exited before it started listening. Last lines:"
      tail -n 15 "$LOG_FILE" >&2 || true
      rm -f "$PID_FILE"
      return 1
    fi
    sleep 1
    waited=$((waited + 1))
  done

  log_fail "Advisor bridge did not start listening within ${READY_TIMEOUT_SECONDS}s. Last lines:"
  tail -n 15 "$LOG_FILE" >&2 || true
  return 1
}

cmd_stop() {
  local stopped=false

  # `pnpm deckgauge:advisor` is a wrapper around tsx, so the process actually
  # holding the port is several levels below the recorded pid (pnpm -> pnpm
  # --filter -> tsx -> node). `pkill -P` only reaches direct children, so this
  # pass alone does NOT stop the listener — the port-based pass below is what
  # does. Both run: this one cleans up the wrapper chain.
  if [ -f "$PID_FILE" ]; then
    local pid
    pid="$(cat "$PID_FILE")"
    if [ -n "$pid" ] && kill -0 "$pid" 2> /dev/null; then
      pkill -TERM -P "$pid" 2> /dev/null || true
      kill -TERM "$pid" 2> /dev/null || true
      stopped=true
    fi
    rm -f "$PID_FILE"
  fi

  # Whatever still holds the port (e.g. a foreground `pnpm deckgauge:advisor`
  # this script never recorded) is the thing the caller means by "stop".
  local remaining
  remaining="$(listener_pid)"
  if [ -n "$remaining" ]; then
    kill -TERM "$remaining" 2> /dev/null || true
    stopped=true
  fi

  # Without lsof there is no way to find the listener, so the pass above was a
  # no-op and the bridge may well still be serving. Say so rather than report a
  # stop that didn't happen — a false "stopped" leaves an orphan holding the
  # port that the next `start` will politely leave alone.
  if ! command -v lsof > /dev/null 2>&1 && port_is_bound; then
    log_fail "Something is still listening on 127.0.0.1:$PORT, and lsof is not installed"
    log_fail "  so its pid can't be resolved. Stop it by hand, or install lsof."
    return 1
  fi

  if [ "$stopped" = true ]; then
    log_step "Advisor bridge stopped."
  else
    log_info "Advisor bridge was not running."
  fi
}

case "${1:-}" in
  start) cmd_start ;;
  stop) cmd_stop ;;
  status) cmd_status ;;
  *)
    echo "Usage: $0 {start|stop|status}" >&2
    exit 2
    ;;
esac

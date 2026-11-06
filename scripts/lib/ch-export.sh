#!/bin/bash
# Deckgauge — ClickHouse table export, shared by scripts/backup.sh.
#
# SOURCED, not executed. The caller supplies the connection in the environment:
#   CH_USER  CH_PASS  CH_HOST  CH_PORT  CH_DB
#
# and calls:
#   ch_export_table <table> <dest.native.gz>     # sets CH_EXPORT_ROWS on success
#   ch_post <sql> [timeout]                      # body on stdout, curl's status
#
# ─── Why this is a library ───────────────────────────────────────────────────
#
# It was eight lines inside backup.sh, and both properties below are things only
# a running ClickHouse can demonstrate. A test cannot reach into a script that
# takes a whole backup as its unit, so the export moved out to where
# `packages/db/src/backup/ch-export.int.test.ts` can call it directly.
#
# ─── The two failures this file exists to prevent ────────────────────────────
#
# 1. FINAL IS NOT UNIVERSAL. backup.sh asked for `FINAL` on every table, which is
#    right for a ReplacingMergeTree (it deduplicates before the read) and is
#    REJECTED by a plain MergeTree: `Code: 181 … Storage MergeTree doesn't support
#    FINAL. (ILLEGAL_FINAL)`. `cockpit._ch_migrations` is a plain MergeTree, so its
#    export failed on every run the script has ever taken.
#
# 2. A FAILED EXPORT RETURNED SUCCESS. `curl -sf` wrote nothing, `gzip` turned
#    nothing into a 20-byte empty stream, and the backup was archived and reported
#    complete.
#
#    Get the mechanism right, because the plausible version of it is false. It is
#    NOT that "bash does not propagate a command substitution's exit status": it
#    does, and measured under both bash 3.2.57 (macOS, what actually runs this) and
#    5.3.15, `f(){ echo hi; return 3; }; x=$(f)` exits 3 under `set -e`. Two other
#    things were true of the old `rows=$(ch_export_table …)`:
#
#      a. errexit does not fire on a failing command INSIDE the substituted
#         subshell. Same function, two call shapes, same bash:
#             f(){ false | cat >/dev/null; echo tail; }
#             r=$(f)   → r=[tail], status 0     # reached the echo
#             f        → exits 1                # aborted at the pipeline
#      b. the function's last command was `echo "$rows"`, so the substitution's
#         status was the echo's — 0 — whatever had happened above it.
#
#    Either alone is enough to lose the failure, so the fix addresses the shape
#    rather than one cause: `ch_export_table` RETURNS NON-ZERO and the CALLER must
#    check it. It sets CH_EXPORT_ROWS instead of printing the count, so the `$( )`
#    call site that hid the first failure cannot come back.
#
#    For the same reason, every status check below is written `if ! var="$(…)"`
#    rather than `var="$(…)"; status=$?`. The latter reads correctly and works only
#    while the CALLER happens to suspend errexit (`if !`, `||`); called as a plain
#    command under `set -e` it aborts at the assignment and never reaches the line
#    that inspects `$?`. A function whose loudness depends on how it is spelled at
#    the call site is the bug in this file's history, not a fix for it.
#
# `set -o pipefail` is set here rather than assumed: the export is a pipeline, and
# a masked curl failure is the bug above. backup.sh already sets it; a test
# harness sourcing this file gets it for free.
set -o pipefail

# How long a single table export may take. A whole-table Native read of the
# largest staging table (ado_transitions, ~284k rows) runs in seconds; the ceiling
# is for a stalled connection, not for a slow query.
: "${CH_EXPORT_TIMEOUT:=300}"
: "${CH_EXPORT_META_TIMEOUT:=30}"

# Set by ch_export_table. Reset on ENTRY, not just on success, so a failed call
# cannot leave the previous table's count standing — the same class of stale
# success value this file exists to remove.
CH_EXPORT_ROWS=0

_ch_export_log_fail() { echo "  ✗ $1" >&2; }
# stderr, because this function's stdout is captured by the caller's `$( )`.
_ch_export_log_info() { echo "  · $1" >&2; }

# POST one query. Prints the response body on stdout whether or not the server
# accepted it, and returns curl's status.
#
# `--fail-with-body` is what makes an error BOTH detectable and readable, which
# the FINAL probe below needs.
#
# Public, not underscore-private: backup.sh enumerates tables through it, so that
# enumeration gets the same status checking the exports have.
ch_post() {
  local sql="$1" timeout="${2:-$CH_EXPORT_META_TIMEOUT}"
  curl -sS --fail-with-body --max-time "$timeout" \
    "http://${CH_USER}:${CH_PASS}@${CH_HOST}:${CH_PORT}/" --data "$sql"
}

# Echoes `FINAL` when the table's engine supports it, nothing when it does not,
# and returns non-zero when the server said something else entirely.
#
# The engine list is asked of the SERVER, not hardcoded here, for the same reason
# the table list in backup.sh is: a literal list of engine names is a thing that
# falls behind a schema. A `LIMIT 0` probe costs nothing and is accurate for
# whatever ClickHouse version is actually answering.
ch_final_clause() {
  local table="$1" probe probe_status=0
  # stderr silenced HERE and nowhere else: a rejected probe is the NORMAL answer
  # for a plain MergeTree, and curl's own `curl: (22) … error: 500` on every such
  # table is noise that trains the reader to ignore the line. A failing EXPORT
  # keeps its transport error, because that one is never routine.
  # `|| probe_status=$?` rather than `if ! …; then`, ONLY where the exit code is
  # wanted in the message: in the right operand of `||`, `$?` is still the
  # assignment's status, and `||` suspends errexit just as `if !` does — so the
  # code survives without reintroducing the caller-dependent
  # `var="$(…)"; status=$?` this file's header warns about.
  probe="$(ch_post "SELECT 1 FROM ${CH_DB}.${table} FINAL LIMIT 0" 2>/dev/null)" || probe_status=$?
  if [ "${probe_status:-0}" -eq 0 ]; then
    printf 'FINAL'
    return 0
  fi

  # Matched on the exception CODE, not on the word ILLEGAL_FINAL: ClickHouse
  # echoes the query back inside its error text, so an unanchored token match
  # would also fire on an unrelated failure of a query that happens to contain
  # `FINAL` — e.g. `Unknown table expression identifier 'cockpit.x' in scope
  # SELECT 1 FROM cockpit.x FINAL LIMIT 0`, which is UNKNOWN_TABLE (60) and must
  # NOT be read as "this engine cannot dedupe".
  #
  # Announced rather than silent. Without this line no backup run says which
  # tables were read without FINAL, so the day a Replacing table is recreated as
  # a plain MergeTree the archive quietly holds un-deduplicated rows.
  if printf '%s' "$probe" | grep -qE 'Code: 181\.'; then
    _ch_export_log_info "${table}: engine does not support FINAL — exporting without it"
    return 0
  fi

  # Anything else — server down, bad credentials, table gone, an error format this
  # no longer recognises — fails. Downgrading to an un-deduplicated export on an
  # unknown error would be a silent correctness loss; a loud stop is the safe
  # direction.
  _ch_export_log_fail "${table}: could not determine FINAL support — curl exit \
${probe_status}; server said: ${probe:-<no response body>}"
  return 1
}

# Export one table to a gzipped Native file. Returns non-zero on ANY failure, in
# every call shape — see note (2) in the header.
ch_export_table() {
  local table="$1" dest="$2"
  local final_clause rows bytes body
  CH_EXPORT_ROWS=0

  if ! final_clause="$(ch_final_clause "$table")"; then
    return 1
  fi

  body="$(ch_post "SELECT count() FROM ${CH_DB}.${table} ${final_clause}")" || {
    _ch_export_log_fail "${table}: row count failed — curl exit $?; server said: ${body:-<no response body>}"
    return 1
  }
  rows="$(printf '%s' "$body" | tr -d '[:space:]')"
  if ! printf '%s' "$rows" | grep -qE '^[0-9]+$'; then
    _ch_export_log_fail "${table}: row count was not a number — '${rows}'"
    return 1
  fi

  if ! ch_post \
        "SELECT * FROM ${CH_DB}.${table} ${final_clause} FORMAT Native" \
        "$CH_EXPORT_TIMEOUT" \
      | gzip > "$dest"; then
    _ch_export_log_fail "${table}: export failed — nothing written"
    rm -f "$dest"
    return 1
  fi

  # The assertion that would have caught the original bug the day it appeared,
  # and the one that still holds if some future failure slips past the checks
  # above: a table with rows cannot export to nothing. Measured DECOMPRESSED,
  # because gzip of empty input is 20 bytes and never 0 — the same trap
  # restore.sh documents on its own side.
  bytes="$(gunzip -c "$dest" 2>/dev/null | wc -c | tr -d '[:space:]')" || bytes=0
  if [ "$rows" -gt 0 ] && [ "${bytes:-0}" -eq 0 ]; then
    _ch_export_log_fail "${table}: ${rows} rows but the export is empty — refusing to record it"
    rm -f "$dest"
    return 1
  fi

  CH_EXPORT_ROWS="$rows"
}

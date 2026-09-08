// JQL composition for per-board source filters.
//
// A board source's `jqlFilter` is a whole JQL query the user typed, so it may
// end in `ORDER BY …`. To use it as a *filter* we have to parenthesise it and
// AND it with the source's own project scope — and JQL only accepts `ORDER BY`
// as the final clause of the whole query, never inside parentheses. So the sort
// is stripped: ordering is meaningless for the key set we fetch with it anyway.

/** True for every index that sits inside a single- or double-quoted literal. */
function quotedRegions(jql: string): boolean[] {
  const inQuote = new Array<boolean>(jql.length).fill(false);
  let quoteChar: string | null = null;

  for (let i = 0; i < jql.length; i++) {
    const ch = jql[i]!;
    // JQL escapes a quote inside a literal with a backslash.
    if (quoteChar !== null && ch === '\\') {
      inQuote[i] = true;
      if (i + 1 < jql.length) inQuote[i + 1] = true;
      i++;
      continue;
    }
    if (quoteChar === null && (ch === '"' || ch === "'")) {
      quoteChar = ch;
      inQuote[i] = true;
      continue;
    }
    if (quoteChar !== null) {
      inQuote[i] = true;
      if (ch === quoteChar) quoteChar = null;
    }
  }

  return inQuote;
}

/**
 * Drops a trailing `ORDER BY …` clause from a JQL query, ignoring the words
 * when they appear inside a quoted literal. Returns the remainder, trimmed.
 */
export function stripJqlOrderBy(jql: string): string {
  const inQuote = quotedRegions(jql);
  const pattern = /\border\s+by\b/gi;
  let cut: number | null = null;

  for (let m = pattern.exec(jql); m !== null; m = pattern.exec(jql)) {
    if (!inQuote[m.index]) cut = m.index;
  }

  return (cut === null ? jql : jql.slice(0, cut)).trim();
}

/**
 * The JQL that answers "which issue keys in this project does the board
 * source's filter admit?". Without a filter it is the bare project scope, so
 * callers get the same key set the unfiltered sync would promote.
 */
export function buildFilteredKeyJql(projectKey: string, jqlFilter: string | null): string {
  const scope = `project = "${projectKey.replace(/(["\\])/g, '\\$1')}"`;
  const filter = jqlFilter === null ? '' : stripJqlOrderBy(jqlFilter);
  return filter === '' ? scope : `${scope} AND (${filter})`;
}

/**
 * True when a board source's `jqlFilter` actually restricts anything — i.e. it
 * is not null/undefined and not reducible to blank once a trailing
 * `ORDER BY …` is stripped. Shared by every reader of `BoardJiraSource` that
 * needs to tell "no filter" apart from "a filter that currently matches
 * nothing", which `filteredKeys`/`board_jira_source_keys` cannot do on its
 * own — both leave that table empty. See {@link JQL_FILTER_MATCHES_NOTHING_KEY}.
 */
export function hasActiveJqlFilter(jqlFilter: string | null | undefined): boolean {
  return jqlFilter != null && stripJqlOrderBy(jqlFilter) !== '';
}

/**
 * A sentinel issue key emitted by the intelligence scope resolvers
 * (`resolveBoardScope` in apps/api/src/intelligence/board-scope.ts,
 * `resolveScope` in apps/api/src/intelligence-query/scope/resolve-scope.ts)
 * when a board source's `jqlFilter` is active but currently admits zero real
 * issues.
 *
 * The bug this closes: `board_jira_source_keys` is empty in BOTH of these
 * cases — a source with no filter, and a source whose filter matches nothing
 * — and every consumer of `issueKeys`/`jiraIssueKeysByProject` reads "empty"
 * as "unrestricted" (deliberately: that is what lets an unfiltered board keep
 * seeing everything). Reading the second case the same way as the first is a
 * fail-OPEN defect — ordinary Jira drift (a renamed component, a stale
 * `cf[10001]` id, an ended sprint) silently reverts a scoped board to
 * project-wide analytics, with no error anywhere.
 *
 * The fix does NOT redefine what an empty `issueKeys` array means — that
 * would touch every reader in the codebase for one edge case. Instead, when
 * `hasActiveJqlFilter` is true but the resolved key set is empty, the
 * resolvers emit `[JQL_FILTER_MATCHES_NOTHING_KEY]` instead of `[]`. A real
 * Jira key is always `PROJECT-<digits>`, so this string can never collide
 * with one, and the existing guarded-disjunction narrowing
 * (`jiraScopeFilter` in apps/api/src/widgets/unions.ts, and the SQL console's
 * rewriter/assert pair) then narrows the project to exactly nothing, as a
 * filter that matches nothing should.
 *
 * The ADO analogue is `expandAdoAreaPaths` in `resolve-scope.ts`, which
 * instead makes its list non-empty by construction (unioning the raw prefix
 * back into an empty expansion). That shape doesn't transfer here: an ADO
 * area-path restriction is itself the value being matched (by prefix), so
 * keeping the prefix narrows correctly on its own. A JQL allow-list is a set
 * of concrete issue keys with no such "keep the input" fallback — a value
 * that can never be a real key is the equivalent fail-closed device.
 */
export const JQL_FILTER_MATCHES_NOTHING_KEY = '<none>';

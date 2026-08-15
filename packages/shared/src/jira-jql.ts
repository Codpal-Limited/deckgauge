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

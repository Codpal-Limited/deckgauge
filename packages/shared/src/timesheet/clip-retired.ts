import type { StatusSpan } from './types.js';

/** UPPERCASE Jira project key -> cutoff instant in epoch-ms. */
export type RetiredProjectMap = ReadonlyMap<string, number>;

/**
 * The Jira project key of an issue key: the uppercased substring before the
 * first '-' (e.g. 'PT-838' -> 'PT'). Returns null when there is no '-', which
 * excludes ADO 'project#id' keys and any malformed key.
 */
export function jiraProjectKeyOf(issueKey: string): string | null {
  const dash = issueKey.indexOf('-');
  if (dash <= 0) return null;
  return issueKey.slice(0, dash).toUpperCase();
}

/**
 * Clip the status spans of retired Jira projects to their cutoff instant:
 * - span wholly before cutoff      -> unchanged
 * - span crossing the cutoff       -> endMs shortened to cutoffMs
 * - span starting on/after cutoff  -> dropped
 * Only `provider === 'jira'` spans are considered; all other providers pass
 * through untouched. Immutable: returns a new array; inputs are not modified.
 */
export function clipRetiredSpans(
  spans: readonly StatusSpan[],
  retired: RetiredProjectMap,
): StatusSpan[] {
  if (retired.size === 0) return spans.slice();
  const out: StatusSpan[] = [];
  for (const span of spans) {
    if (span.provider !== 'jira') {
      out.push(span);
      continue;
    }
    const key = jiraProjectKeyOf(span.issueKey);
    const cutoffMs = key === null ? undefined : retired.get(key);
    if (cutoffMs === undefined) {
      out.push(span);
      continue;
    }
    if (span.startMs >= cutoffMs) continue; // wholly after cutoff -> drop
    if (span.endMs <= cutoffMs) {
      out.push(span); // wholly before cutoff -> unchanged
      continue;
    }
    out.push({ ...span, endMs: cutoffMs }); // crossing -> clip
  }
  return out;
}

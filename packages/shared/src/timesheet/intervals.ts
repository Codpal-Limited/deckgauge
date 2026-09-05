import type { RawTransition, StatusSpan } from './types.js';

/**
 * Reconstruct contiguous status spans per issue from its transition events.
 * Each transition opens a span that ends at the next transition (same issue),
 * or at `nowMs` for the most recent one. Zero-length spans (duplicate
 * timestamps) are dropped. Input is not mutated.
 */
export function reconstructIntervals(transitions: RawTransition[], nowMs: number): StatusSpan[] {
  const byIssue = new Map<string, RawTransition[]>();
  for (const tr of transitions) {
    const list = byIssue.get(tr.issueKey);
    if (list) list.push(tr);
    else byIssue.set(tr.issueKey, [tr]);
  }

  const spans: StatusSpan[] = [];
  for (const list of byIssue.values()) {
    const sorted = [...list].sort((a, b) => a.transitionedAtMs - b.transitionedAtMs);
    for (let i = 0; i < sorted.length; i++) {
      const cur = sorted[i]!;
      const endMs = i + 1 < sorted.length ? sorted[i + 1]!.transitionedAtMs : nowMs;
      if (endMs <= cur.transitionedAtMs) continue; // drop zero/negative-length
      spans.push({
        issueKey: cur.issueKey,
        provider: cur.provider,
        assignee: cur.assignee,
        status: cur.status,
        category: cur.category,
        startMs: cur.transitionedAtMs,
        endMs,
      });
    }
  }
  return spans;
}

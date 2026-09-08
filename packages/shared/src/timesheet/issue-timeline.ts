import { spanIsInProgress, type ResolvedStatusConfig } from './status-rules.js';
import type { StatusSpan } from './types.js';

/**
 * One status the issue sat in, for the ticket drill-down drawer.
 *
 * `counted` answers "did this stretch of time reach the engineer's timesheet
 * row" and is decided by the SAME `spanIsInProgress` predicate the grid engine
 * uses, so the drawer never disagrees with the cell that opened it about WHICH
 * time counted. It deliberately says nothing about HOW MUCH — see the note on
 * `wallMs` in `StatusDuration`.
 */
export interface TimelineSegment {
  status: string;
  category: string | null;
  startMs: number;
  endMs: number;
  counted: boolean;
}

export interface StatusDuration {
  status: string;
  /**
   * WALL-CLOCK milliseconds the issue spent in this status — not hours
   * attributed to anyone.
   *
   * The two are genuinely different quantities and must not be conflated in the
   * UI. The grid's seconds come out of `computeTimesheet`, which splits time
   * across concurrently in-progress tickets (`normalizeConcurrent`) and then
   * scales any day over the cap (`resolveDailyCapSeconds`). A ticket held in
   * "In Progress" for 13 days alongside two others contributes far fewer than
   * 13 days of attributed work. Summing wall-clock here and labelling it
   * "counted hours" would restate the cell wrongly, which is exactly the
   * confusion the drawer exists to remove.
   */
  wallMs: number;
  /** How many separate times the issue entered this status. */
  visits: number;
  /** True when at least one visit counted toward the timesheet. */
  counted: boolean;
}

export interface BuildIssueTimelineInput {
  /** Every reconstructed span for ONE issue, in any order. */
  spans: StatusSpan[];
  /** The in-progress config resolved exactly as the grid engine resolves it. */
  config: ResolvedStatusConfig;
  /**
   * Whether a span belongs to the engineer whose row was clicked. Spans that
   * fail it stay in the timeline — reassignment is part of the ticket's story —
   * but can never be marked counted. Defaults to "every span is theirs", for
   * callers that have already filtered by assignee.
   */
  isOwnSpan?: (span: StatusSpan) => boolean;
  /**
   * Retirement cutoff for this issue's project, or null when it has none.
   *
   * The grid runs its spans through `clipRetiredSpans` BEFORE counting them, so
   * time after a retired project's cutoff reaches nobody's timesheet. A drawer
   * that ignored this showed an hour bar marked counted for hours the grid had
   * attributed as zero — the exact disagreement the `counted` flag exists to
   * prevent. Segments stay VISIBLE past the cutoff (the ticket's story does not
   * stop when the accounting does); they simply cannot be counted.
   */
  countableUntilMs?: number | null;
}

/** Every status the issue passed through, chronological, each flagged counted or not. */
export function buildIssueTimeline({
  spans,
  config,
  isOwnSpan,
  countableUntilMs,
}: BuildIssueTimelineInput): TimelineSegment[] {
  const owns = isOwnSpan ?? (() => true);
  const cutoff = countableUntilMs ?? null;
  const ordered = [...spans].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  const out: TimelineSegment[] = [];
  for (const s of ordered) {
    const eligible = owns(s) && spanIsInProgress(s, config);
    const base = { status: s.status, category: s.category };

    // Crossing the cutoff: emit the countable part and the rest separately, so
    // the bar shows exactly how much of that stretch actually counted.
    if (cutoff !== null && eligible && s.startMs < cutoff && s.endMs > cutoff) {
      out.push({ ...base, startMs: s.startMs, endMs: cutoff, counted: true });
      out.push({ ...base, startMs: cutoff, endMs: s.endMs, counted: false });
      continue;
    }

    const pastCutoff = cutoff !== null && s.startMs >= cutoff;
    out.push({
      ...base,
      startMs: s.startMs,
      endMs: s.endMs,
      counted: eligible && !pastCutoff,
    });
  }
  return out;
}

/** Roll a timeline up per status, heaviest first. */
export function summarizeByStatus(segments: TimelineSegment[]): StatusDuration[] {
  const byStatus = new Map<string, StatusDuration>();
  for (const seg of segments) {
    const row = byStatus.get(seg.status);
    if (row) {
      row.wallMs += seg.endMs - seg.startMs;
      row.visits += 1;
      row.counted = row.counted || seg.counted;
    } else {
      byStatus.set(seg.status, {
        status: seg.status,
        wallMs: seg.endMs - seg.startMs,
        visits: 1,
        counted: seg.counted,
      });
    }
  }
  return [...byStatus.values()].sort((a, b) => b.wallMs - a.wallMs);
}

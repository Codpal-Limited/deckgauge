import type { TimelineSegmentDto } from '@deckgauge/shared';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/**
 * Elapsed time as a person would say it: `45m`, `5h 20m`, `2d 3h`.
 *
 * Deliberately NOT `formatHours` from `timesheet-ui.ts`. That renders a decimal
 * hour count ("18.7h") because it fills grid cells that must line up in a
 * column; the drawer is prose and reads better with mixed units. The two are
 * measuring different things anyway — see the `wallMs` note in
 * `packages/shared/src/timesheet/issue-timeline.ts`.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  if (ms < MIN) return '<1m';
  if (ms < HOUR) return `${Math.floor(ms / MIN)}m`;
  if (ms < DAY) {
    const h = Math.floor(ms / HOUR);
    const m = Math.floor((ms % HOUR) / MIN);
    return m === 0 ? `${h}h` : `${h}h ${m}m`;
  }
  const d = Math.floor(ms / DAY);
  const h = Math.floor((ms % DAY) / HOUR);
  return h === 0 ? `${d}d` : `${d}d ${h}h`;
}

/**
 * The viewer's own clock.
 *
 * The panel this replaces rendered `new Date(ms).toISOString().slice(0,16)` —
 * a UTC instant with no marker, which anyone outside UTC reads as their own
 * time and misjudges by their offset. `formatUtcTooltip` keeps the unambiguous
 * instant one hover away.
 */
export function formatLocalDateTime(ms: number | null): string {
  if (ms == null) return '—';
  return new Date(ms).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatLocalDate(ms: number | null): string {
  if (ms == null) return '—';
  return new Date(ms).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export function formatUtcTooltip(ms: number | null): string {
  if (ms == null) return '';
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export interface StripSegment {
  status: string;
  counted: boolean;
  pct: number;
  startMs: number;
  endMs: number;
}

/** Timeline segments as percentage widths of the issue's whole life. */
export function stripSegments(timeline: TimelineSegmentDto[]): StripSegment[] {
  if (timeline.length === 0) return [];
  // `reconstructIntervals` yields contiguous spans, so the last-starting
  // segment does end last — but taking the max removes the dependency on that
  // rather than relying on it from a module that cannot see it.
  const first = Math.min(...timeline.map((s) => s.startMs));
  const last = Math.max(...timeline.map((s) => s.endMs));
  const total = last - first;
  if (total <= 0) return [];
  return timeline.map((s) => ({
    status: s.status,
    counted: s.counted,
    startMs: s.startMs,
    endMs: s.endMs,
    pct: ((s.endMs - s.startMs) / total) * 100,
  }));
}

export type ActivityKind = 'commit' | 'pr' | 'status' | 'other';

/** The three PR/MR sources the server's UNION emits today. */
const PR_SOURCES: ReadonlySet<string> = new Set(['github', 'gitlab', 'ado']);

/**
 * Collapse the server's `source` strings into filter buckets.
 *
 * Unknown sources map to `other` rather than to `pr`. They are still rendered
 * (under "All"), so a UNION arm added server-side shows up without a change
 * here — but calling it a pull request would be an assertion, not a default: a
 * future commit source not suffixed `-commit` would land under the PRs filter
 * with the wrong marker and a truncated sha. `other` says "shown, unclassified".
 */
export function activityKind(source: string): ActivityKind {
  if (source.endsWith('-commit')) return 'commit';
  if (source === 'jira') return 'status';
  if (PR_SOURCES.has(source)) return 'pr';
  return 'other';
}

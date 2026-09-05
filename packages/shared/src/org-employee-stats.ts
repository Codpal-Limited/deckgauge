import type { EmployeeStats } from './org-tree-schemas.js';

export const ACTIVE_WINDOW_DAYS = 90;
export const UNMAPPED = '(unmapped)';

export interface MatchedActivityRow {
  employeeId: string;
  boards: string[];
  isAssignment: boolean;
  contributedCode: boolean;
  lastTs: string | null;
  boardNames: Record<string, string>;
}

/**
 * ClickHouse stores UTC but renders "YYYY-MM-DD HH:MM:SS" with no zone, and
 * `new Date()` reads a zone-less string as LOCAL time. West of UTC that shifts
 * timestamps into the future, which the `ms >= 0` guard below then treats as invalid —
 * silently dropping the most recent activity. The aggregator now emits explicit UTC;
 * this repairs anything zone-less that still reaches us (e.g. values already stored).
 */
/**
 * A zone-less timestamp: `YYYY-MM-DD HH:MM:SS`, optionally with fractional seconds,
 * and optionally `T`-separated. This is how ClickHouse renders a DateTime, and it
 * carries no zone even though the stored value is UTC.
 *
 * Fractional seconds are matched because a DateTime64 column emits them; the `T` form
 * because some callers hand back an already-half-normalised string. Either falling
 * through to `new Date()` would be parsed as LOCAL time, which is the bug.
 */
const ZONELESS_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/;

/**
 * Force a zone-less ClickHouse timestamp to explicit UTC; pass anything else through
 * untouched (already-ISO values, values with an offset, and garbage alike).
 *
 * Exported and shared deliberately. This logic previously existed as two independent
 * copies — one here, one in the worker's org-sync aggregator — and they drifted apart
 * on fractional seconds, re-arming the exact bug they were written to prevent. One
 * definition, imported by both, is the only thing that actually holds them together.
 */
export function toUtcIso(ts: string): string {
  return ZONELESS_TIMESTAMP.test(ts) ? `${ts.replace(' ', 'T')}Z` : ts;
}

function parseUtc(ts: string): number {
  return new Date(toUtcIso(ts)).getTime();
}

export function isWithinActiveWindow(ts: string | null, nowIso: string): boolean {
  if (!ts) return false;
  const ms = new Date(nowIso).getTime() - parseUtc(ts);
  return ms <= ACTIVE_WINDOW_DAYS * 24 * 60 * 60 * 1000 && ms >= 0;
}

function maxTs(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

export function reduceEmployeeSnapshot(
  rows: MatchedActivityRow[],
  nowIso: string
): {
  matched: boolean;
  isActive: boolean;
  hasAssignment: boolean;
  lastContributionAt: string | null;
  stats: EmployeeStats;
} {
  const boardAcc = new Map<
    string,
    { name: string; code: boolean; assign: boolean; last: string | null; lastAny: string | null }
  >();
  const other = { contributedCode: false, lastContributionAt: null as string | null };
  let hasAssignment = false;
  let lastCode: string | null = null;

  for (const r of rows) {
    if (r.isAssignment) hasAssignment = true;
    if (r.contributedCode) lastCode = maxTs(lastCode, r.lastTs);
    for (const b of r.boards) {
      if (b === UNMAPPED) {
        if (r.contributedCode) {
          other.contributedCode = true;
          other.lastContributionAt = maxTs(other.lastContributionAt, r.lastTs);
        }
        continue;
      }
      const cur = boardAcc.get(b) ?? { name: r.boardNames[b] ?? b, code: false, assign: false, last: null, lastAny: null };
      if (r.contributedCode) {
        cur.code = true;
        cur.last = maxTs(cur.last, r.lastTs);
      }
      if (r.isAssignment) cur.assign = true;
      // Recency for the chip window is code OR assignment: an assignment-only
      // board never sets `last` (that stays code-only for display), so without
      // this it could not be aged out at all.
      cur.lastAny = maxTs(cur.lastAny, r.lastTs);
      boardAcc.set(b, cur);
    }
  }

  const boards = [...boardAcc.entries()]
    // A board chip claims "this person is on this board". Board membership is
    // derived from activity, and activity never expires in the source tables, so
    // without this window a 2023 ticket assignment renders identically to work
    // done today. Age chips out on the same window that drives `isActive`.
    .filter(([, v]) => isWithinActiveWindow(v.lastAny, nowIso))
    .map(([boardId, v]) => ({
      boardId, boardName: v.name, contributedCode: v.code, hasAssignment: v.assign, lastContributionAt: v.last,
    }))
    .sort((a, b) => a.boardName.localeCompare(b.boardName));

  return {
    matched: rows.length > 0,
    isActive: isWithinActiveWindow(lastCode, nowIso),
    hasAssignment,
    lastContributionAt: lastCode,
    stats: { boards, other },
  };
}

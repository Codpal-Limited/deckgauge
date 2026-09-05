import type { Provider } from './types.js';
import type { GridCell } from './aggregate.js';
import type { Classification } from './classification.js';

interface ClassSplit {
  capexSeconds: number;
  opexSeconds: number;
  unclassifiedSeconds: number;
}

/** One employee's contribution to an epic, split by classification. */
export interface EpicEmployeeSeconds extends ClassSplit {
  employeeId: string;
  totalSeconds: number;
}

/** One epic's rolled-up time, split by classification. `classification` is the
 *  dominant-by-hours CapEx/OpEx — the single colour that marks the row, always
 *  consistent with the CapEx/OpEx split of its hours. `byEmployee` breaks the
 *  same total down per developer (drill-down), sorted by hours descending. */
export interface EpicBreakdownRow extends ClassSplit {
  epicKey: string;
  provider: Provider;
  classification: Classification;
  totalSeconds: number;
  byEmployee: EpicEmployeeSeconds[];
}

export interface EpicBreakdownInput {
  grid: GridCell[];
  parentOf: Map<string, string>;
  /** Page size (top-N by hours). Omit or non-positive → return all remaining. */
  limit?: number;
  /** 0-based offset into the ranked list, for paging. Omit → start at the top. */
  offset?: number;
}

/** A page of the epic leaderboard plus the total number of epics behind it, so
 *  callers can paginate without recomputing the full rollup for a count. */
export interface EpicBreakdownResult {
  epics: EpicBreakdownRow[];
  total: number;
}

/**
 * Walk the parent chain to its root; that root IS the epic. An issue with no
 * parent is its own epic. Cycle-safe: stops on the first already-visited node.
 */
export function resolveEpicKey(issueKey: string, parentOf: Map<string, string>): string {
  const visited = new Set<string>([issueKey]);
  let current = issueKey;
  for (;;) {
    const parent = parentOf.get(current);
    if (parent === undefined || visited.has(parent)) return current;
    visited.add(parent);
    current = parent;
  }
}

function emptySplit(): ClassSplit {
  return { capexSeconds: 0, opexSeconds: 0, unclassifiedSeconds: 0 };
}

function addSeconds(split: ClassSplit, classification: Classification, seconds: number): void {
  if (classification === 'CAPEX') split.capexSeconds += seconds;
  else if (classification === 'OPEX') split.opexSeconds += seconds;
  else split.unclassifiedSeconds += seconds;
}

function totalOf(split: ClassSplit): number {
  return split.capexSeconds + split.opexSeconds + split.unclassifiedSeconds;
}

/** The epic's single CapEx/OpEx mark: whichever bucket holds the most hours.
 *  Kept in lockstep with the split so the pill/colour never contradicts the bar. */
function dominantClassification(split: ClassSplit): Classification {
  if (split.capexSeconds === 0 && split.opexSeconds === 0) return 'Unclassified';
  return split.capexSeconds >= split.opexSeconds ? 'CAPEX' : 'OPEX';
}

interface Accumulator extends ClassSplit {
  provider: Provider;
  byEmployee: Map<string, ClassSplit>;
}

/**
 * Roll per-issue grid seconds up to their epic (root of the parent chain), split
 * by each issue's classification, and — within each epic — by developer. Sorted
 * by total hours descending (ties broken by key for stable ordering). Only issues
 * present in the grid contribute, so the result reflects exactly the epics
 * developers spent in-progress time on.
 *
 * Returns the requested page (`offset`/`limit`) plus `total` — the count of all
 * epics before paging — so the UI can show "N of total" and page without a
 * second pass.
 */
export function buildEpicBreakdown(input: EpicBreakdownInput): EpicBreakdownResult {
  const { grid, parentOf, limit, offset } = input;
  const byEpic = new Map<string, Accumulator>();

  for (const cell of grid) {
    const epicKey = resolveEpicKey(cell.issueKey, parentOf);
    let acc = byEpic.get(epicKey);
    if (!acc) {
      acc = { provider: cell.provider, ...emptySplit(), byEmployee: new Map() };
      byEpic.set(epicKey, acc);
    }
    addSeconds(acc, cell.classification, cell.seconds);

    let emp = acc.byEmployee.get(cell.employeeId);
    if (!emp) {
      emp = emptySplit();
      acc.byEmployee.set(cell.employeeId, emp);
    }
    addSeconds(emp, cell.classification, cell.seconds);
  }

  const rows: EpicBreakdownRow[] = [...byEpic.entries()].map(([epicKey, acc]) => {
    const byEmployee: EpicEmployeeSeconds[] = [...acc.byEmployee.entries()]
      .map(([employeeId, split]) => ({ employeeId, ...split, totalSeconds: totalOf(split) }))
      .sort((a, b) => b.totalSeconds - a.totalSeconds || a.employeeId.localeCompare(b.employeeId));
    return {
      epicKey,
      provider: acc.provider,
      classification: dominantClassification(acc),
      totalSeconds: totalOf(acc),
      capexSeconds: acc.capexSeconds,
      opexSeconds: acc.opexSeconds,
      unclassifiedSeconds: acc.unclassifiedSeconds,
      byEmployee,
    };
  });

  rows.sort((a, b) => b.totalSeconds - a.totalSeconds || a.epicKey.localeCompare(b.epicKey));

  const total = rows.length;
  const start = offset != null && offset > 0 ? offset : 0;
  const end = limit != null && limit > 0 ? start + limit : undefined;
  const epics = start === 0 && end === undefined ? rows : rows.slice(start, end);

  return { epics, total };
}

import type { Provider, StatusSpan } from './types.js';
import { clipToWindow } from './clip.js';
import { resolveInProgressStatuses, spanIsInProgress, type StatusRule, type ResolvedStatusConfig } from './status-rules.js';
import { splitIntoBuckets, bucketKeyFor, type Granularity } from './buckets.js';
import { normalizeConcurrent } from './normalize.js';
import { resolveClassification, type Classification } from './classification.js';

export interface EmployeeInput {
  id: string;
  role: string | null;
}

export interface ComputeInput {
  employees: EmployeeInput[];
  rules: StatusRule[];
  spans: StatusSpan[];
  assigneeToEmployeeId: (assignee: string | null, provider: Provider) => string | null;
  ownClassification: Map<string, 'CAPEX' | 'OPEX'>;
  parentOf: Map<string, string>;
  fromMs: number;
  toMs: number;
  granularity: Granularity;
  mode: 'normalized' | 'raw';
  /** When non-null, overrides per-employee rules: every employee uses this exact active-status set. Empty array = count nothing. */
  orgTreeActiveStatuses?: string[] | null;
  /**
   * Cap on one employee's counted seconds per calendar day. When a day exceeds
   * it, that day's contributions are scaled down proportionally (preserving the
   * CapEx/OpEx split) before aggregating into the display buckets. `null`/omitted
   * or non-positive = no cap.
   */
  dailyCapSeconds?: number | null;
}

export interface GridCell {
  employeeId: string;
  bucketKey: string;
  issueKey: string;
  provider: Provider;
  classification: Classification;
  seconds: number;
}

export interface ReportCell {
  classification: Classification;
  bucketKey: string;
  seconds: number;
}

export interface ComputeResult {
  grid: GridCell[];
  report: ReportCell[];
  unmatched: { assignee: string; provider: Provider; seconds: number }[];
}

/** One span's contribution to a single calendar day, before the cap is applied. */
interface DayContribution {
  span: StatusSpan;
  /** A timestamp inside the day this contribution falls in (for display-bucket mapping). */
  atMs: number;
  /** Day key ("YYYY-MM-DD") used to group and cap contributions per calendar day. */
  dayKey: string;
  seconds: number;
}

export function computeTimesheet(input: ComputeInput): ComputeResult {
  const overrideConfig: ResolvedStatusConfig | null =
    input.orgTreeActiveStatuses != null
      ? { statuses: new Set(input.orgTreeActiveStatuses), useCategoryFallback: false }
      : null;
  const configByEmployee = new Map(
    input.employees.map(
      (e) => [e.id, overrideConfig ?? resolveInProgressStatuses(e, input.rules)] as const,
    ),
  );

  // In-progress config for UNMATCHED assignees: no per-employee/role rule can
  // apply, so mirror the matched path with the org-tree override when set, else
  // the name-based default (anything that isn't a To Do / Done state). Without
  // this filter, idle time in Done / To Do / Code Review / QA etc. inflates the
  // unmatched bucket, while matched employees only ever accrue in-progress time.
  const unmatchedConfig: ResolvedStatusConfig =
    overrideConfig ?? { statuses: new Set(), useCategoryFallback: true };

  const perEmployeeSpans = new Map<string, StatusSpan[]>();
  const unmatchedMs = new Map<string, number>(); // `${assignee}|${provider}` -> ms

  for (const span of input.spans) {
    const empId = input.assigneeToEmployeeId(span.assignee, span.provider);
    if (empId === null || !configByEmployee.has(empId)) {
      if (!spanIsInProgress(span, unmatchedConfig)) continue;
      const clipped = clipToWindow(span, input.fromMs, input.toMs);
      if (clipped && span.assignee) {
        const key = `${span.assignee}|${span.provider}`;
        unmatchedMs.set(key, (unmatchedMs.get(key) ?? 0) + (clipped.endMs - clipped.startMs));
      }
      continue;
    }
    const config = configByEmployee.get(empId)!;
    if (!spanIsInProgress(span, config)) continue;
    const clipped = clipToWindow(span, input.fromMs, input.toMs);
    if (!clipped) continue;
    const list = perEmployeeSpans.get(empId);
    if (list) list.push(clipped);
    else perEmployeeSpans.set(empId, [clipped]);
  }

  // A positive cap is applied per calendar day; anything else means "no cap".
  const capSeconds =
    input.dailyCapSeconds != null && input.dailyCapSeconds > 0 ? input.dailyCapSeconds : null;

  const gridMap = new Map<string, GridCell>();
  const reportMap = new Map<string, ReportCell>();

  for (const [empId, spans] of perEmployeeSpans) {
    const weighted = normalizeConcurrent(spans, input.mode);

    // Split every weighted span into per-DAY contributions so the cap can be
    // applied per calendar day regardless of the display granularity. Week/month
    // buckets are whole-day aligned (UTC), so each day contribution maps to
    // exactly one display bucket.
    const contributions: DayContribution[] = [];
    const secondsByDay = new Map<string, number>();
    for (const { span, seconds } of weighted) {
      const spanMs = span.endMs - span.startMs;
      if (spanMs <= 0) continue;
      for (const slice of splitIntoBuckets(span, 'day')) {
        const sliceSeconds = seconds * ((slice.endMs - slice.startMs) / spanMs);
        contributions.push({ span, atMs: slice.startMs, dayKey: slice.bucketKey, seconds: sliceSeconds });
        secondsByDay.set(slice.bucketKey, (secondsByDay.get(slice.bucketKey) ?? 0) + sliceSeconds);
      }
    }

    for (const c of contributions) {
      const dayTotal = secondsByDay.get(c.dayKey)!;
      const factor = capSeconds !== null && dayTotal > capSeconds ? capSeconds / dayTotal : 1;
      const seconds = c.seconds * factor;
      const classification = resolveClassification(c.span.issueKey, input.ownClassification, input.parentOf);
      const bucketKey = bucketKeyFor(c.atMs, input.granularity);

      const gKey = `${empId}|${bucketKey}|${c.span.issueKey}|${c.span.provider}|${classification}`;
      const g = gridMap.get(gKey);
      if (g) g.seconds += seconds;
      else
        gridMap.set(gKey, {
          employeeId: empId,
          bucketKey,
          issueKey: c.span.issueKey,
          provider: c.span.provider,
          classification,
          seconds,
        });

      const rKey = `${classification}|${bucketKey}`;
      const r = reportMap.get(rKey);
      if (r) r.seconds += seconds;
      else reportMap.set(rKey, { classification, bucketKey, seconds });
    }
  }

  const unmatched = [...unmatchedMs.entries()].map(([key, ms]) => {
    const [assignee, provider] = key.split('|');
    return { assignee: assignee!, provider: provider as Provider, seconds: ms / 1000 };
  });

  return { grid: [...gridMap.values()], report: [...reportMap.values()], unmatched };
}

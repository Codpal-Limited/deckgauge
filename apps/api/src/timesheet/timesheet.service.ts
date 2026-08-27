import {
  reconstructIntervals,
  clipToWindow,
  clipRetiredSpans,
  computeTimesheet,
  resolveDailyCapSeconds,
  resolveInProgressStatuses,
  spanIsInProgress,
  buildEpicBreakdown,
  type RawTransition,
  type StatusSpan,
  type StatusRule,
  type ResolvedStatusConfig,
  type ComputeResult,
  type TimesheetGridQuery,
  type CapexReportQuery,
  type EpicBreakdownQuery,
  type IntervalsQuery,
  type TimesheetGridResponse,
  type CapexReportResponse,
  type EpicBreakdownResponse,
  type IntervalsResponse,
  type RetiredProjectMap,
} from '@deckgauge/shared';
import { makeAssigneeResolver } from './assignee-resolver.js';
import { shapeGrid, shapeReport, type EmployeeMeta } from './timesheet-shape.js';
import { TtlCache } from './ttl-cache.js';

interface LoadedEmployee {
  id: string;
  name: string;
  role: string | null;
  managerId: string | null;
  aliases: { provider: string; kind: string; value: string }[];
}

export interface TimesheetDeps {
  loadEmployees: (orgTreeId: string) => Promise<LoadedEmployee[]>;
  loadRules: (organizationId: string) => Promise<StatusRule[]>;
  loadOrgTreeActiveStatuses: (orgTreeId: string) => Promise<string[] | null>;
  /** Per-day working-hours cap in hours for a tree; null when unconfigured (→ engine default). */
  loadOrgTreeDailyCapHours: (orgTreeId: string) => Promise<number | null>;
  /**
   * The four ClickHouse-backed deps take `organizationId` FIRST, exactly like the
   * Prisma-backed `loadRules` and `loadRetiredProjects` beside them.
   *
   * Not decoration: it is what lets `buildTimesheetDeps` resolve a reader scoped
   * to that organization per call (tenancy §11 precondition 8) while this service
   * stays a SINGLE instance. It has to stay single — the `TtlCache` below is
   * per-instance, and building one service per request would hand every request a
   * cold cache on the most expensive read path in the product.
   *
   * `fetchTransitions` is additionally bounded BELOW by `fromMs`, not just above:
   * it fetches the window plus one carry-in transition per issue rather than all
   * history. See the note in `timesheet-fetch.ts`; 0 means "all history".
   */
  fetchTransitions: (
    organizationId: string,
    fromMs: number,
    toMs: number,
  ) => Promise<RawTransition[]>;
  /** UPPERCASE Jira project key -> cutoff epoch-ms; issues of these projects stop accruing after the cutoff. */
  loadRetiredProjects: (organizationId: string) => Promise<RetiredProjectMap>;
  fetchParentLinks: (organizationId: string) => Promise<Map<string, string>>;
  fetchClassificationMap: (organizationId: string) => Promise<Map<string, 'CAPEX' | 'OPEX'>>;
  /** issueKey -> { title, source deep link }. One fetch, cached in the engine run. */
  loadIssueMeta: (organizationId: string) => Promise<Map<string, { title: string; url: string | null }>>;
  now?: () => number;
  cacheTtlMs?: number;
}

interface EngineRun {
  result: ComputeResult;
  employees: EmployeeMeta[];
  titleByIssueKey: Map<string, string>;
  // Retained so the epic breakdown can attach source links without a second scan.
  urlByIssueKey: Map<string, string>;
  // Retained so the epic breakdown can roll the per-issue grid up to its epics.
  parentOf: Map<string, string>;
}

export class TimesheetService {
  private readonly now: () => number;
  private readonly cache: TtlCache<EngineRun>;

  constructor(private readonly deps: TimesheetDeps) {
    this.now = deps.now ?? Date.now;
    // Cap cached engine runs: each is large (a full grid over the window), and the
    // report page pins two per org tree (month CapEx + year epic). Bounding to 6
    // keeps a couple of trees' worth live while preventing unbounded pile-up (which
    // OOM'd the API when switching between large org trees).
    this.cache = new TtlCache<EngineRun>(deps.cacheTtlMs ?? 60_000, this.now, 6);
  }

  private async runEngine(
    organizationId: string,
    orgTreeId: string,
    fromMs: number,
    toMs: number,
    granularity: 'day' | 'week' | 'month',
    mode: 'normalized' | 'raw',
  ): Promise<EngineRun> {
    // Like activeStatuses, the per-tree daily cap is baked into the cached
    // result rather than the key; a cap change takes effect within the TTL.
    // `organizationId` is part of the key, not just the queries. The engine's
    // RESULT is organization-dependent — status rules and retirement cutoffs are
    // both scoped below — so an organization-agnostic key would let an org-A
    // request compute with A's rules and cache the result under a key an org-B
    // request also matches, serving A's numbers to B for the whole TTL.
    // (§11 precondition 6 of the tenancy design.)
    const key = `${organizationId}|${orgTreeId}|${fromMs}|${toMs}|${granularity}|${mode}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    const nowMs = this.now();
    const [
      loaded,
      rules,
      orgTreeActiveStatuses,
      dailyCapHours,
      transitions,
      parentOf,
      ownClassification,
      issueMeta,
      retired,
    ] = await Promise.all([
      this.deps.loadEmployees(orgTreeId),
      this.deps.loadRules(organizationId),
      this.deps.loadOrgTreeActiveStatuses(orgTreeId),
      this.deps.loadOrgTreeDailyCapHours(orgTreeId),
      this.deps.fetchTransitions(organizationId, fromMs, toMs),
      this.deps.fetchParentLinks(organizationId),
      this.deps.fetchClassificationMap(organizationId),
      this.deps.loadIssueMeta(organizationId),
      this.deps.loadRetiredProjects(organizationId),
    ]);

    const titleByIssueKey = new Map<string, string>();
    const urlByIssueKey = new Map<string, string>();
    for (const [key, meta] of issueMeta) {
      if (meta.title) titleByIssueKey.set(key, meta.title);
      if (meta.url) urlByIssueKey.set(key, meta.url);
    }

    const dailyCapSeconds = resolveDailyCapSeconds(dailyCapHours);
    const resolve = makeAssigneeResolver(loaded);
    const spans = clipRetiredSpans(reconstructIntervals(transitions, nowMs), retired);
    const result = computeTimesheet({
      employees: loaded.map((e) => ({ id: e.id, role: e.role })),
      rules,
      orgTreeActiveStatuses,
      spans,
      assigneeToEmployeeId: resolve,
      ownClassification,
      parentOf,
      fromMs,
      toMs,
      granularity,
      mode,
      dailyCapSeconds,
    });
    const employees: EmployeeMeta[] = loaded.map((e) => ({
      id: e.id,
      name: e.name,
      role: e.role,
      managerId: e.managerId,
    }));
    const run: EngineRun = { result, employees, titleByIssueKey, urlByIssueKey, parentOf };
    this.cache.set(key, run);
    return run;
  }

  async getGrid(organizationId: string, q: TimesheetGridQuery): Promise<TimesheetGridResponse> {
    const run = await this.runEngine(
      organizationId,
      q.orgTreeId,
      Date.parse(q.from),
      Date.parse(q.to),
      q.granularity,
      q.mode,
    );
    const { buckets, employees } = shapeGrid(run.result.grid, run.employees, run.titleByIssueKey);
    return {
      from: q.from,
      to: q.to,
      granularity: q.granularity,
      mode: q.mode,
      buckets,
      employees,
      unmatched: run.result.unmatched,
    };
  }

  async getCapexReport(organizationId: string, q: CapexReportQuery): Promise<CapexReportResponse> {
    const run = await this.runEngine(
      organizationId,
      q.orgTreeId,
      Date.parse(q.from),
      Date.parse(q.to),
      q.granularity,
      q.mode,
    );
    const { totals, byBucket, byGroup } = shapeReport(
      run.result.report,
      run.result.grid,
      run.employees,
      q.groupBy,
    );
    return { from: q.from, to: q.to, totals, byBucket, byGroup };
  }

  async getEpicBreakdown(organizationId: string, q: EpicBreakdownQuery): Promise<EpicBreakdownResponse> {
    // The rollup ignores display buckets, so 'month' granularity is an arbitrary
    // but valid choice for the engine run (the epic window rarely matches the
    // report/grid window, so this run is typically computed on its own).
    const run = await this.runEngine(
      organizationId,
      q.orgTreeId,
      Date.parse(q.from),
      Date.parse(q.to),
      'month',
      q.mode,
    );
    const { epics: rows, total } = buildEpicBreakdown({
      grid: run.result.grid,
      parentOf: run.parentOf,
      limit: q.limit,
      offset: q.offset,
    });
    const nameById = new Map(run.employees.map((e) => [e.id, e.name] as const));
    const epics = rows.map((r) => ({
      ...r,
      title: run.titleByIssueKey.get(r.epicKey) ?? null,
      url: run.urlByIssueKey.get(r.epicKey) ?? null,
      byEmployee: r.byEmployee.map((e) => ({
        ...e,
        name: nameById.get(e.employeeId) ?? '(unknown)',
      })),
    }));
    return { from: q.from, to: q.to, epics, total };
  }

  async getIntervals(organizationId: string, q: IntervalsQuery): Promise<IntervalsResponse> {
    const fromMs = Date.parse(q.from);
    const toMs = Date.parse(q.to);
    const nowMs = this.now();
    // loadEmployees('') returns ALL employees for issue-scoped drill-down (Task 6 contract).
    const [transitions, loaded, rules, orgTreeActiveStatuses, retired] = await Promise.all([
      this.deps.fetchTransitions(organizationId, fromMs, toMs),
      this.deps.loadEmployees(''),
      this.deps.loadRules(organizationId),
      this.deps.loadOrgTreeActiveStatuses(q.orgTreeId),
      this.deps.loadRetiredProjects(organizationId),
    ]);
    const resolve = makeAssigneeResolver(loaded);
    // Resolve the in-progress config exactly like the grid engine so the drawer's
    // intervals match the counted total: org-tree override wins, else per-employee/role rules.
    const employee = loaded.find((e) => e.id === q.employeeId) ?? null;
    const config: ResolvedStatusConfig =
      orgTreeActiveStatuses != null
        ? { statuses: new Set(orgTreeActiveStatuses), useCategoryFallback: false }
        : resolveInProgressStatuses({ id: q.employeeId, role: employee?.role ?? null }, rules);
    const spans = clipRetiredSpans(reconstructIntervals(transitions, nowMs), retired)
      .filter((s) => s.issueKey === q.issueKey && resolve(s.assignee, s.provider) === q.employeeId)
      .filter((s) => spanIsInProgress(s, config))
      .map((s) => clipToWindow(s, fromMs, toMs))
      .filter((s): s is StatusSpan => s !== null);
    return {
      issueKey: q.issueKey,
      employeeId: q.employeeId,
      intervals: spans.map((s) => ({
        provider: s.provider,
        status: s.status,
        startMs: s.startMs,
        endMs: s.endMs,
      })),
    };
  }
}

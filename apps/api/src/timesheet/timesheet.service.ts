import {
  reconstructIntervals,
  clipToWindow,
  clipRetiredSpans,
  computeTimesheet,
  resolveDailyCapSeconds,
  resolveInProgressStatuses,
  spanIsInProgress,
  buildEpicBreakdown,
  buildIssueTimeline,
  summarizeByStatus,
  jiraProjectKeyOf,
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
import type { IssueDetail } from './issue-detail-fetch.js';
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
  /**
   * The two DRAWER-ONLY reads, both scoped to a single issue.
   *
   * They are separate from `loadIssueMeta` / `fetchTransitions` rather than
   * widening them, and that separation is load-bearing on both sides:
   *
   * - `loadIssueMeta` scans both issue tables whole and feeds the CACHED engine
   *   run. Adding the drawer's dozen columns to it would widen the hottest read
   *   in the product to serve a panel opened one issue at a time.
   * - `fetchTransitions` is bounded to the requested window on purpose (see the
   *   OOM note in `timesheet-fetch.ts`), so it cannot answer "when did this
   *   ticket open" for anything created earlier. Scoped to one issue, full
   *   history is a handful of rows.
   */
  fetchIssueTimeline: (organizationId: string, issueKey: string) => Promise<RawTransition[]>;
  fetchIssueDetail: (organizationId: string, issueKey: string) => Promise<IssueDetail | null>;
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
    const [transitions, loaded, rules, orgTreeActiveStatuses, retired, history, detail] =
      await Promise.all([
        this.deps.fetchTransitions(organizationId, fromMs, toMs),
        this.deps.loadEmployees(''),
        this.deps.loadRules(organizationId),
        this.deps.loadOrgTreeActiveStatuses(q.orgTreeId),
        this.deps.loadRetiredProjects(organizationId),
        this.deps.fetchIssueTimeline(organizationId, q.issueKey),
        this.deps.fetchIssueDetail(organizationId, q.issueKey),
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
    const intervals = spans.map((s) => ({
      provider: s.provider,
      status: s.status,
      startMs: s.startMs,
      endMs: s.endMs,
    }));

    // ---- drawer detail, from the two issue-scoped reads ----
    // NOT clipped to the window and not filtered by assignee: the drawer's job
    // is the ticket's whole story, including the stretches somebody else held
    // it. `counted` (below) is what carries the narrower question of which time
    // reached THIS engineer's row, decided by the same predicate as the grid.
    const historySpans = reconstructIntervals(history, nowMs).filter(
      (s) => s.issueKey === q.issueKey,
    );
    // The hours path above clips these with `clipRetiredSpans`; the drawer must
    // honour the same cutoff or it marks time as counted that the grid
    // attributed as zero.
    //
    // GATE ON THE PROVIDER, not just the key shape. `clipRetiredSpans` tests
    // `span.provider !== 'jira'` FIRST, and `jiraProjectKeyOf` excludes ADO keys
    // only by the absence of a '-' — so an ADO project whose name contains one
    // ('Core-Platform#5' -> 'CORE') would inherit a Jira project's retirement
    // here and have its span split, understating hours the grid counted in full.
    // That is the round-1 defect mirrored, and `clip-retired.test.ts` already
    // pins the same collision on the hours side.
    const isJira = historySpans.some((s) => s.provider === 'jira');
    const jiraKey = isJira ? jiraProjectKeyOf(q.issueKey) : null;
    const countableUntilMs = jiraKey === null ? null : (retired.get(jiraKey) ?? null);
    const timeline = buildIssueTimeline({
      spans: historySpans,
      config,
      isOwnSpan: (s) => resolve(s.assignee, s.provider) === q.employeeId,
      countableUntilMs,
    });

    return {
      issueKey: q.issueKey,
      employeeId: q.employeeId,
      intervals,
      provider: detail?.provider ?? null,
      title: detail?.title ?? null,
      url: detail?.url ?? null,
      issueType: detail?.issueType ?? null,
      reporter: detail?.reporter ?? null,
      assignee: detail?.assignee ?? null,
      priority: detail?.priority ?? null,
      storyPoints: detail?.storyPoints ?? null,
      sprint: detail?.sprint ?? null,
      epic: detail?.epic ?? null,
      // Prefer the issue's own creation timestamp; fall back to the first
      // transition we have, which is the best available answer for a warehouse
      // row that is missing or predates the issue table.
      openedAtMs: detail?.openedAtMs ?? timeline[0]?.startMs ?? null,
      resolvedAtMs: detail?.resolvedAtMs ?? null,
      currentStatus: detail?.currentStatus ?? timeline[timeline.length - 1]?.status ?? null,
      // From the TIMELINE, not `intervals`. Both were once summed from
      // `intervals`, which is clipped to the requested window — so the drawer
      // read "5h of 100h elapsed" directly above a per-status row saying 95h,
      // because numerator and denominator were scoped differently. The
      // window-scoped figure is already shown separately, and comes from the
      // grid cell itself.
      inProgressMs: timeline.reduce(
        (acc, s) => (s.counted ? acc + (s.endMs - s.startMs) : acc),
        0,
      ),
      timeline,
      byStatus: summarizeByStatus(timeline),
    };
  }
}

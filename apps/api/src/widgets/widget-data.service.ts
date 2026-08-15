import { PrismaClient, clickhouse as defaultClickhouse, type ClickHouseClient } from '@deckgauge/db';
import {
  BENCHMARKS_V1,
  tierFor,
  type Tier,
  aggregateInvestmentAllocation,
  type InvestmentSlice,
  buildDoraScorecard,
  type DoraMetric,
  buildPeriodComparison,
  type PeriodComparisonMetric,
  type PeriodMetricKey,
} from '@deckgauge/shared';
import { getWidgetBoardScope } from './widget-board-scope.js';
import {
  castRows,
  buildTrendWeekBuckets,
  MERGE_FREQ_TREND_WEEKS,
  COMMITS_PER_DEV_TREND_WEEKS,
  resolveWeeks,
  BACKLOG_AGE_BUCKETS,
  PR_SIZE_BUCKETS,
} from './widget-helpers.js';
import { buildMergeFrequencyPerDevSql } from '../intelligence-query/builders/merge-frequency-per-dev.js';
import { buildCommitsPerDevSql } from '../intelligence-query/builders/commits-per-dev.js';
import { buildChCompletionTrendSql } from '../intelligence-query/builders/ch-completion-trend.js';
import { buildChVelocitySql } from '../intelligence-query/builders/ch-velocity.js';
import { buildChCycleTimeTrendSql } from '../intelligence-query/builders/ch-cycle-time-trend.js';
import { buildChBacklogAgeSql } from '../intelligence-query/builders/ch-backlog-age.js';
import { buildLeadTimeForChangesSql } from '../intelligence-query/builders/lead-time-for-changes.js';
import { buildPrCycleTimeScatterSql } from '../intelligence-query/builders/pr-cycle-time-scatter.js';
import { buildReviewPickupTimeSql } from '../intelligence-query/builders/review-pickup-time.js';
import { buildPrSizeDistributionSql } from '../intelligence-query/builders/pr-size-distribution.js';
import { buildReworkRateSql } from '../intelligence-query/builders/rework-rate.js';
import { buildBugRateSql } from '../intelligence-query/builders/bug-rate.js';
import { buildIterationPlanningAccuracySql } from '../intelligence-query/builders/iteration-planning-accuracy.js';
import { buildVelocityWithConfidenceSql } from '../intelligence-query/builders/velocity-with-confidence.js';
import { buildInitiativeRiskRadarSql } from '../intelligence-query/builders/initiative-risk-radar.js';
import { mergeInitiativeRows, type SourceInitiativeRow } from './initiative-risk-merge.js';
import { buildIssuesOpenedVsClosedSql } from '../intelligence-query/builders/issues-opened-vs-closed.js';
import { buildWipCountSql } from '../intelligence-query/builders/wip-count.js';
import { buildTicketCoverageRateSql } from '../intelligence-query/builders/ticket-coverage-rate.js';
import { buildAiAssistedPrPctSql } from '../intelligence-query/builders/ai-assisted-pr-pct.js';
import { buildReviewMixSql } from '../intelligence-query/builders/review-mix.js';
import { buildBotVsHumanSql } from '../intelligence-query/builders/bot-vs-human.js';
import { buildReviewerParticipationSql } from '../intelligence-query/builders/reviewer-participation.js';
import { buildReviewQualityIndexSql } from '../intelligence-query/builders/review-quality-index.js';
import { buildReviewQualityTrendSql } from '../intelligence-query/builders/review-quality-trend.js';
import { buildFlowThroughputCycleSql } from '../intelligence-query/builders/flow-throughput-cycle.js';
import { buildDeliveryTrendAnnotatedSql } from '../intelligence-query/builders/delivery-trend-annotated.js';
import { buildAiAdoptionSql } from '../intelligence-query/builders/ai-adoption.js';
import { buildInvestmentAllocationSql } from '../intelligence-query/builders/investment-allocation.js';
import { buildDoraMetricsSql } from '../intelligence-query/builders/dora-metrics.js';
import { resolvePeriod, resolveComparePeriods } from '../intelligence-query/builders/period.js';
import {
  buildPeriodComparisonSql,
  buildPeriodComparisonTrendSql,
} from '../intelligence-query/builders/period-comparison.js';
import { getBoardScopes, type BoardScopeEntry } from '../intelligence/board-scope.js';
import {
  countMetricComparability,
  rateMetricComparability,
  type ComparabilityFlag,
} from '../intelligence/comparison-metadata.js';

export interface ChCompletionTrendResult {
  points: Array<{ date: string; count: number }>;
}
export interface ChVelocityResult {
  weeks: Array<{ week_start: string; prs: number }>;
}
export interface ChCycleTimeTrendResult {
  weeks: Array<{ week_start: string; p50_hours: number }>;
}
export interface ChBacklogAgeResult {
  buckets: Array<{ label: string; count: number }>;
}
export interface InvestmentAllocationResult {
  slices: InvestmentSlice[];
  total: number;
  emptyReason?: 'no_issue_source';
}
export interface DoraMetricsResult {
  metrics: DoraMetric[];
  weeks: number;
  /**
   * Where Deployment Frequency came from: 'deployments' = real deployment
   * records; 'merge_proxy' = merged-PR count, because the board's scope has no
   * deployment source. Surfaced so the widget can label a proxied number rather
   * than presenting it as observed.
   */
  deploySource?: 'deployments' | 'merge_proxy';
  /**
   * Where Change Failure Rate came from: 'deployments' = the share of production
   * releases that did not succeed, observed from real deployment status;
   * 'commit_proxy' = the corrective-commit ratio, used when the board's scope
   * yields no classifiable production release. Labelled for the same reason as
   * {@link deploySource}.
   */
  changeFailureSource?: 'deployments' | 'commit_proxy';
  emptyReason?: 'no_source';
}

// Keyed by the shared PeriodMetricKey union so the trajectories map can't
// drift from the metric keys buildPeriodComparison actually produces. Built
// incrementally from ClickHouse rows (which arrive as plain strings), so the
// accumulator narrows each row's `metric` with a cast rather than claiming
// every key is always populated (a source-less board only fills the keys its
// connected sources support).
export type PeriodTrajectories = Record<PeriodMetricKey, Array<{ month: string; value: number | null }>>;

export interface PeriodComparisonResult {
  metrics: PeriodComparisonMetric[];
  periodA: { from: string; to: string };
  periodB: { from: string; to: string };
  trajectories: PeriodTrajectories;
  emptyReason?: string;
}

export interface LeadTimeForChangesResult {
  weeks: Array<{ week_start: string; p50_hours: number; tier: Tier }>;
  emptyReason?: 'no_pr_source';
}

export interface PrCycleTimeScatterResult {
  points: Array<{
    x: string;
    y: number;
    label: string;
    href: string;
    tier: Tier;
    author?: string;
  }>;
  emptyReason?: 'no_pr_source';
}

export interface ReviewPickupTimeResult {
  weeks: Array<{ week_start: string; avg_hours: number; tier: Tier }>;
  emptyReason?: 'no_pr_source';
}

export interface PrSizeDistributionResult {
  buckets: Array<{ label: string; count: number; tier: Tier }>;
  emptyReason?: 'no_pr_source';
}

export interface MergeFrequencyPerDevResult {
  rows: Array<{
    author: string;
    prs_merged: number;
    avg_per_week: number;
    trend: number[]; // length MERGE_FREQ_TREND_WEEKS
    tier: Tier;
  }>;
  emptyReason?: 'no_pr_source';
}

export interface ReworkRateResult {
  weeks: Array<{ week_start: string; rework_pct: number; tier: Tier }>;
  emptyReason?: 'no_commit_source';
}

export interface BugRateResult {
  weeks: Array<{ week_start: string; bugs: number; other: number }>;
  emptyReason?: 'no_issue_source';
}

export interface IterationPlanningAccuracyResult {
  sprints: Array<{
    iteration_name: string;
    completed: number;
    committed: number;
    accuracy_pct: number;
  }>;
  emptyReason?: 'no_issue_source' | 'no_sprintable_source';
}

export interface VelocityWithConfidenceResult {
  sprints: Array<{
    sprint_name: string;
    completed: number;
    lower: number;
    upper: number;
  }>;
  emptyReason?: 'no_issue_source' | 'no_sprintable_source' | 'no_sprint_data';
}

export type InitiativeRiskStatus = 'on_track' | 'at_risk' | 'overdue';
export type InitiativeSource = 'jira' | 'github';

export interface InitiativeRiskRadarResult {
  initiatives: Array<{
    name: string;
    due_date: string;
    days_until_due: number;
    status: InitiativeRiskStatus;
    source: InitiativeSource;
  }>;
  emptyReason?: 'no_issue_source';
}

export interface IssuesOpenedVsClosedResult {
  weeks: Array<{ week_start: string; opened: number; closed: number }>;
  emptyReason?: 'no_issue_source';
}

export interface WipCountResult {
  current: number;
  trend: number[];
  emptyReason?: 'no_issue_source';
}

export interface TicketCoverageRateResult {
  current_pct: number;
  trend: number[];
  tier: Tier;
  emptyReason?: 'no_pr_source';
}

export interface AiAssistedPrPctResult {
  current_pct: number;
  trend: number[];
  emptyReason?: 'no_pr_source';
}

export interface ReviewMixResult {
  summary: {
    bot_pct: number;
    human_p50_hours: number;
    bot_p50_hours: number;
    // Comment-review split: bots like Copilot's PR reviewer review by commenting,
    // so substantive-review bot share misses them. This is the bot share of all
    // 'commented'-state reviews in the period.
    comment_bot_pct: number;
    comment_bot_count: number;
    comment_human_count: number;
  };
  weeks: Array<{ week_start: string; bot_pct: number }>;
  emptyReason?: 'no_github_source';
}

export interface ReviewerParticipationResult {
  rows: Array<{
    reviewer: string;
    provider: string;
    reviews_given: number;
    approvals: number;
  }>;
  emptyReason?: 'no_review_source';
}

export interface BotVsHumanResult {
  summary: {
    total: number;
    bot_count: number;
    human_count: number;
    bot_pct: number;
  };
  weeks: Array<{ week_start: string; total: number; bot_count: number; human_count: number }>;
  emptyReason?: 'no_commit_source';
}

export interface CommitsPerDevResult {
  rows: Array<{
    email: string;
    name: string;
    userId: string | null;
    commits: number;
    additions: number;
    deletions: number;
    ai_pct: number;
    trend: number[];
  }>;
  emptyReason?: 'no_commit_source';
}

export interface ReviewQualityIndexResult {
  coverage_pct: number | null;
  median_open_h: number | null;
  instant_pct: number | null;
  comment_pct: number | null;
  ticket_pct: number | null;
  merged_prs: number;
  emptyReason?: 'no_pr_source';
}

export interface ReviewQualityTrendPoint {
  period: string;
  coverage_pct: number | null;
  comment_pct: number | null;
  sample: number;
}

export interface ReviewQualityTrendResult {
  trend: ReviewQualityTrendPoint[];
  scorecard: ReviewQualityIndexResult;
  emptyReason?: 'no_pr_source';
}

export interface FlowThroughputCyclePoint {
  period: string;
  delivered: number;
  cycle_days: number | null;
  sample: number;
  flagged: boolean;
}

export interface FlowThroughputCycleResult {
  series: FlowThroughputCyclePoint[];
  emptyReason?: 'no_issue_source';
}

export interface AiAdoptionRow {
  period: string;
  ai_pr_pct: number;
  ai_commit_pct: number;
  pr_total: number;
  commit_total: number;
}

export interface AiAdoptionResult {
  rows: AiAdoptionRow[];
  emptyReason?: 'no_code_source';
}

export interface DeliveryTrendAnnotatedSeriesPoint {
  period: string;
  delivered: number;
  sample: number;
}

export interface DeliveryTrendAnnotatedPeak {
  period: string;
  value: number;
}

export interface DeliveryTrendAnnotatedEvent {
  label: string;
  kind: string;
  startsAt: string;
  endsAt: string;
  color: string | null;
}

export interface DeliveryTrendAnnotatedResult {
  series: DeliveryTrendAnnotatedSeriesPoint[];
  peak: DeliveryTrendAnnotatedPeak | null;
  events: DeliveryTrendAnnotatedEvent[];
  emptyReason?: 'no_issue_source';
}

// ---------------------------------------------------------------------------
// P6 — multi-board comparison result shapes. Each comparison widget fans an
// existing single-board result out across the comparison's board set, tags each
// with its board, and attaches per-metric comparability flags the web layer
// uses to grey non-comparable cells.
// ---------------------------------------------------------------------------

export interface CompareBoardMeta {
  boardId: string;
  boardName: string;
  /** Effective-developer headcount from the org tree; null when no org link. */
  effectiveDevHeadcount: number | null;
}

export interface CompareReviewQualityBoard extends CompareBoardMeta {
  scorecard: ReviewQualityIndexResult;
  trend: ReviewQualityTrendPoint[];
  emptyReason?: 'no_pr_source';
}

export interface CompareReviewQualityResult {
  boards: CompareReviewQualityBoard[];
  comparability: {
    coverage_pct: ComparabilityFlag;
    median_open_h: ComparabilityFlag;
    comment_pct: ComparabilityFlag;
    merged_prs: ComparabilityFlag;
  };
}

export interface CompareFlowBoard extends CompareBoardMeta {
  series: FlowThroughputCyclePoint[];
  emptyReason?: 'no_issue_source';
}

export interface CompareFlowResult {
  boards: CompareFlowBoard[];
  comparability: {
    cycle_days: ComparabilityFlag;
    delivered: ComparabilityFlag;
  };
}

export interface CompareDeliveryBoard extends CompareBoardMeta {
  series: DeliveryTrendAnnotatedSeriesPoint[];
  peak: DeliveryTrendAnnotatedPeak | null;
  emptyReason?: 'no_issue_source';
}

export interface CompareDeliveryResult {
  boards: CompareDeliveryBoard[];
  /** Freeze/migration/holiday overlay, shared across all boards' series. */
  events: DeliveryTrendAnnotatedEvent[];
  comparability: {
    delivered: ComparabilityFlag;
  };
}

export class WidgetDataService {
  private readonly clickhouse: ClickHouseClient;

  constructor(
    private readonly prisma: PrismaClient,
    clickhouseClient?: ClickHouseClient
  ) {
    this.clickhouse = clickhouseClient ?? defaultClickhouse;
  }

  async getStatusDistribution(boardId: string, _config: Record<string, unknown>) {
    const statuses = await this.prisma.boardStatus.findMany({
      where: { boardId },
      select: { id: true, label: true, color: true },
      orderBy: { order: 'asc' },
    });
    const statusMap = new Map(statuses.map((s) => [s.id, s]));

    const groups = await this.prisma.project.groupBy({
      by: ['statusId'],
      where: { boardId, statusId: { not: null } },
      _count: { id: true },
    });

    const items = groups
      .filter((g) => g.statusId && statusMap.has(g.statusId))
      .map((g) => {
        const status = statusMap.get(g.statusId!)!;
        return { label: status.label, value: g._count.id, color: status.color };
      });

    return { items };
  }

  async getStatusByGroup(boardId: string, _config: Record<string, unknown>) {
    const projects = await this.prisma.project.findMany({
      where: { boardId, groupId: { not: null } },
      select: {
        groupId: true,
        group: { select: { name: true } },
        boardStatus: { select: { label: true, color: true } },
      },
    });

    const groupMap = new Map<
      string,
      { name: string; statuses: Map<string, { count: number; color: string }> }
    >();

    for (const p of projects) {
      if (!p.groupId || !p.group || !p.boardStatus) continue;
      if (!groupMap.has(p.groupId)) {
        groupMap.set(p.groupId, { name: p.group.name, statuses: new Map() });
      }
      const group = groupMap.get(p.groupId)!;
      const existing = group.statuses.get(p.boardStatus.label);
      if (existing) {
        existing.count++;
      } else {
        group.statuses.set(p.boardStatus.label, { count: 1, color: p.boardStatus.color });
      }
    }

    const result = Array.from(groupMap.values()).map((g) => ({
      name: g.name,
      statuses: Array.from(g.statuses.entries()).map(([label, data]) => ({
        label,
        count: data.count,
        color: data.color,
      })),
    }));

    return { groups: result };
  }

  async getItemsByOwner(boardId: string, config: Record<string, unknown>) {
    const where: Record<string, unknown> = { boardId, ownerId: { not: null } };
    if (config.statusFilter && typeof config.statusFilter === 'string') {
      where.status = config.statusFilter;
    }

    const projects = await this.prisma.project.findMany({
      where,
      select: { boardOwner: { select: { name: true } } },
    });

    const counts = new Map<string, number>();
    for (const p of projects) {
      if (!p.boardOwner) continue;
      counts.set(p.boardOwner.name, (counts.get(p.boardOwner.name) ?? 0) + 1);
    }

    const owners = Array.from(counts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);

    return { owners };
  }

  async getVelocityLeaderboard(boardId: string, config: Record<string, unknown>) {
    const days = typeof config.days === 'number' ? config.days : 30;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const doneChanges = await this.prisma.projectStatusChange.findMany({
      where: {
        toStatus: { in: ['Done', 'DONE'] },
        changedAt: { gte: since },
        project: { boardId },
      },
      include: {
        project: {
          select: { boardOwner: { select: { name: true } } },
        },
      },
      orderBy: { changedAt: 'desc' },
    });

    const projectIds = [...new Set(doneChanges.map((c) => c.projectId))];
    const inProgressChanges = await this.prisma.projectStatusChange.findMany({
      where: {
        projectId: { in: projectIds },
        toStatus: { in: ['In progress', 'IN_PROGRESS'] },
      },
      orderBy: { changedAt: 'desc' },
    });

    const inProgressMap = new Map<string, Date>();
    for (const change of inProgressChanges) {
      if (!inProgressMap.has(change.projectId)) {
        inProgressMap.set(change.projectId, change.changedAt);
      }
    }

    const engineerTimes = new Map<string, number[]>();
    for (const done of doneChanges) {
      const ownerName = done.project.boardOwner?.name;
      if (!ownerName) continue;
      const startDate = inProgressMap.get(done.projectId);
      if (!startDate) continue;
      const durationDays = (done.changedAt.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000);
      if (durationDays < 0) continue;
      if (!engineerTimes.has(ownerName)) engineerTimes.set(ownerName, []);
      engineerTimes.get(ownerName)!.push(durationDays);
    }

    const engineers = Array.from(engineerTimes.entries())
      .map(([name, times]) => ({
        name,
        avgDays: Math.round((times.reduce((a, b) => a + b, 0) / times.length) * 10) / 10,
        completedCount: times.length,
      }))
      .sort((a, b) => a.avgDays - b.avgDays);

    return { engineers, days };
  }

  async getCompletionRate(boardId: string, config: Record<string, unknown>) {
    const days = typeof config.days === 'number' ? config.days : 30;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const completions = await this.prisma.projectStatusChange.findMany({
      where: {
        toStatus: { in: ['Done', 'DONE'] },
        changedAt: { gte: since },
        project: { boardId },
      },
      select: { projectId: true },
      distinct: ['projectId'],
    });

    const total = await this.prisma.project.count({ where: { boardId } });
    const completed = completions.length;

    return {
      total,
      completed,
      rate: total > 0 ? Math.round((completed / total) * 100) / 100 : 0,
    };
  }

  async getRecentlyCompleted(boardId: string, config: Record<string, unknown>) {
    const limit = typeof config.limit === 'number' ? config.limit : 10;

    const changes = await this.prisma.projectStatusChange.findMany({
      where: {
        toStatus: { in: ['Done', 'DONE'] },
        project: { boardId },
      },
      include: {
        project: {
          select: { name: true, boardOwner: { select: { name: true } } },
        },
      },
      orderBy: { changedAt: 'desc' },
      take: limit,
    });

    const items = changes.map((c) => ({
      projectId: c.projectId,
      name: c.project.name,
      owner: c.project.boardOwner?.name ?? 'Unassigned',
      completedAt: c.changedAt,
    }));

    return { items };
  }

  async getStuckIssues(boardId: string, config: Record<string, unknown>) {
    const thresholdDays = typeof config.thresholdDays === 'number' ? config.thresholdDays : 7;
    const threshold = new Date(Date.now() - thresholdDays * 24 * 60 * 60 * 1000);

    const changes = await this.prisma.projectStatusChange.findMany({
      where: {
        toStatus: { in: ['In progress', 'IN_PROGRESS'] },
        changedAt: { lte: threshold },
        project: { boardId, status: 'IN_PROGRESS' },
      },
      include: {
        project: {
          select: { name: true, status: true, boardOwner: { select: { name: true } } },
        },
      },
      orderBy: { changedAt: 'asc' },
    });

    const seen = new Set<string>();
    const items = changes
      .filter((c) => {
        if (seen.has(c.projectId)) return false;
        seen.add(c.projectId);
        return true;
      })
      .map((c) => ({
        projectId: c.projectId,
        name: c.project.name,
        owner: c.project.boardOwner?.name ?? 'Unassigned',
        inProgressSince: c.changedAt,
        daysStuck: Math.floor((Date.now() - c.changedAt.getTime()) / (24 * 60 * 60 * 1000)),
      }))
      .sort((a, b) => b.daysStuck - a.daysStuck);

    return { items, thresholdDays };
  }

  async getBlockedItems(boardId: string, _config: Record<string, unknown>) {
    const projects = await this.prisma.project.findMany({
      where: { boardId, status: 'BLOCKED' },
      select: {
        id: true,
        name: true,
        updatedAt: true,
        boardOwner: { select: { name: true } },
      },
      orderBy: { updatedAt: 'asc' },
    });

    const items = projects.map((p) => ({
      projectId: p.id,
      name: p.name,
      owner: p.boardOwner?.name ?? 'Unassigned',
      blockedSince: p.updatedAt,
      daysBlocked: Math.floor((Date.now() - p.updatedAt.getTime()) / (24 * 60 * 60 * 1000)),
    }));

    return { items };
  }

  async getStaleItems(boardId: string, config: Record<string, unknown>) {
    const thresholdDays = typeof config.thresholdDays === 'number' ? config.thresholdDays : 14;
    const threshold = new Date(Date.now() - thresholdDays * 24 * 60 * 60 * 1000);

    const projects = await this.prisma.project.findMany({
      where: { boardId, updatedAt: { lte: threshold }, status: { not: 'DONE' } },
      select: {
        id: true,
        name: true,
        updatedAt: true,
        boardOwner: { select: { name: true } },
      },
      orderBy: { updatedAt: 'asc' },
    });

    const items = projects.map((p) => ({
      projectId: p.id,
      name: p.name,
      owner: p.boardOwner?.name ?? 'Unassigned',
      lastUpdated: p.updatedAt,
      daysSinceUpdate: Math.floor((Date.now() - p.updatedAt.getTime()) / (24 * 60 * 60 * 1000)),
    }));

    return { items, thresholdDays };
  }

  async getTotalCount(boardId: string, config: Record<string, unknown>) {
    const where: Record<string, unknown> = { boardId };
    if (config.statusFilter && typeof config.statusFilter === 'string') {
      where.status = config.statusFilter;
    }
    const count = await this.prisma.project.count({ where });
    return { count };
  }

  async getStatusSummary(boardId: string, _config: Record<string, unknown>) {
    const statuses = await this.prisma.boardStatus.findMany({
      where: { boardId },
      select: { id: true, label: true, color: true },
      orderBy: { order: 'asc' },
    });

    const groups = await this.prisma.project.groupBy({
      by: ['statusId'],
      where: { boardId, statusId: { not: null } },
      _count: { id: true },
    });

    const countMap = new Map(groups.map((g) => [g.statusId!, g._count.id]));

    const result = statuses.map((s) => ({
      label: s.label,
      count: countMap.get(s.id) ?? 0,
      color: s.color,
    }));

    return { statuses: result };
  }

  // ── ClickHouse-powered widgets (P3) ───────────────────────────────────────
  // All four are board-scoped via Board*Source → external identifier mapping.

  async getChCompletionTrend(
    boardId: string,
    config: { days?: number } | Record<string, unknown>
  ): Promise<ChCompletionTrendResult> {
    const scope = await getWidgetBoardScope(this.prisma, boardId);
    const built = buildChCompletionTrendSql({ config, scope });
    if (built === null) return { points: [] };

    const result = await this.clickhouse.query({
      query: built.sql,
      query_params: built.params,
      format: 'JSONEachRow',
    });
    const rows = castRows<{ date: string; count: number | string }>(await result.json());
    return {
      points: rows.map((r) => ({ date: r.date, count: Number(r.count) })),
    };
  }

  async getChVelocity(
    boardId: string,
    config: { weeks?: number } | Record<string, unknown>
  ): Promise<ChVelocityResult> {
    const scope = await getWidgetBoardScope(this.prisma, boardId);
    const built = buildChVelocitySql({ config, scope });
    if (built === null) return { weeks: [] };

    const result = await this.clickhouse.query({
      query: built.sql,
      query_params: built.params,
      format: 'JSONEachRow',
    });
    const rows = castRows<{ week_start: string; prs: number | string }>(await result.json());
    return {
      weeks: rows.map((r) => ({ week_start: r.week_start, prs: Number(r.prs) })),
    };
  }

  async getChCycleTimeTrend(
    boardId: string,
    config: { weeks?: number } | Record<string, unknown>
  ): Promise<ChCycleTimeTrendResult> {
    const scope = await getWidgetBoardScope(this.prisma, boardId);
    const built = buildChCycleTimeTrendSql({ config, scope });
    if (built === null) return { weeks: [] };

    const result = await this.clickhouse.query({
      query: built.sql,
      query_params: built.params,
      format: 'JSONEachRow',
    });
    const rows = castRows<{ week_start: string; p50_hours: number | string | null }>(
      await result.json()
    );
    return {
      weeks: rows.map((r) => ({
        week_start: r.week_start,
        p50_hours: Math.round((Number(r.p50_hours ?? 0)) * 10) / 10,
      })),
    };
  }

  async getChBacklogAge(
    boardId: string,
    _config: Record<string, unknown>
  ): Promise<ChBacklogAgeResult> {
    const scope = await getWidgetBoardScope(this.prisma, boardId);
    const built = buildChBacklogAgeSql({ config: _config, scope });
    if (built === null) {
      return { buckets: BACKLOG_AGE_BUCKETS.map((b) => ({ label: b.label, count: 0 })) };
    }

    const result = await this.clickhouse.query({
      query: built.sql,
      query_params: built.params,
      format: 'JSONEachRow',
    });
    const rows = castRows<{ bucket: string; count: number | string }>(await result.json());
    const countMap = new Map<string, number>(rows.map((r) => [r.bucket, Number(r.count)]));
    return {
      buckets: BACKLOG_AGE_BUCKETS.map((b) => ({
        label: b.label,
        count: countMap.get(b.label) ?? 0,
      })),
    };
  }

  // Lead time for changes: weekly p50 PR cycle time across every PR provider
  // in scope. Each row is tagged with the DX 2025 tier (elite / high / medium /
  // low) so the widget can render a benchmark band and a per-week dot colour.
  //
  // Empty payload (`emptyReason: 'no_pr_source'`) is returned without touching
  // ClickHouse when the board has no GitHub / GitLab / ADO scope — the union
  // would have no legs and produce a SQL error.
  async getLeadTimeForChanges(
    boardId: string,
    config: { weeks?: number } | Record<string, unknown>
  ): Promise<LeadTimeForChangesResult> {
    const scope = await getWidgetBoardScope(this.prisma, boardId);
    const built = buildLeadTimeForChangesSql({ config, scope });
    if (built === null) return { weeks: [], emptyReason: 'no_pr_source' };

    const result = await this.clickhouse.query({
      query: built.sql,
      query_params: built.params,
      format: 'JSONEachRow',
    });
    const rows = castRows<{ week_start: string; p50_hours: number | string | null }>(
      await result.json()
    );
    const cfg = BENCHMARKS_V1.LEAD_TIME_FOR_CHANGES!;
    return {
      weeks: rows.map((r) => {
        const p50 = Math.round(Number(r.p50_hours ?? 0) * 10) / 10;
        return { week_start: r.week_start, p50_hours: p50, tier: tierFor(p50, cfg) };
      }),
    };
  }

  // PR cycle-time scatter: one dot per merged PR over the window, capped at
  // 500 so the chart stays readable. Each point carries an `href` for
  // click-through; tier is derived from the same LEAD_TIME_FOR_CHANGES
  // benchmark used by the trend widget, so the colour story matches.
  async getPrCycleTimeScatter(
    boardId: string,
    config: { weeks?: number } | Record<string, unknown>
  ): Promise<PrCycleTimeScatterResult> {
    const scope = await getWidgetBoardScope(this.prisma, boardId);
    const built = buildPrCycleTimeScatterSql({ config, scope });
    if (built === null) return { points: [], emptyReason: 'no_pr_source' };

    const result = await this.clickhouse.query({
      query: built.sql,
      query_params: built.params,
      format: 'JSONEachRow',
    });
    const rows = castRows<{
      x: string;
      y: number | string;
      label: string;
      href: string;
      author?: string | null;
    }>(await result.json());
    const cfg = BENCHMARKS_V1.LEAD_TIME_FOR_CHANGES!;
    return {
      points: rows.map((r) => {
        const y = Number(r.y);
        const author = typeof r.author === 'string' && r.author.length > 0 ? r.author : undefined;
        return { x: r.x, y, label: r.label, href: r.href, tier: tierFor(y, cfg), author };
      }),
    };
  }

  // Review pickup time: weekly average hours between PR open and first
  // non-comment review. Tier per week against BENCHMARKS_V1.REVIEW_PICKUP_TIME.
  // Empty payload when no PR provider is in scope.
  async getReviewPickupTime(
    boardId: string,
    config: { weeks?: number } | Record<string, unknown>
  ): Promise<ReviewPickupTimeResult> {
    const scope = await getWidgetBoardScope(this.prisma, boardId);
    const built = buildReviewPickupTimeSql({ config, scope });
    if (built === null) return { weeks: [], emptyReason: 'no_pr_source' };

    const result = await this.clickhouse.query({
      query: built.sql,
      query_params: built.params,
      format: 'JSONEachRow',
    });
    const rows = castRows<{ week_start: string; avg_hours: number | string | null }>(
      await result.json()
    );
    const cfg = BENCHMARKS_V1.REVIEW_PICKUP_TIME!;
    return {
      weeks: rows.map((r) => {
        const avg = Math.round(Number(r.avg_hours ?? 0) * 10) / 10;
        return { week_start: r.week_start, avg_hours: avg, tier: tierFor(avg, cfg) };
      }),
    };
  }

  // PR size distribution: counts merged PRs into five fixed buckets by
  // (additions + deletions). Each bucket has a hard-coded tier so the chart
  // colours stay stable regardless of the data. Always returns all 5 buckets
  // (zero-fill missing rows from ClickHouse) so the chart is readable even
  // when only a couple of bucket sizes actually occurred.
  async getPrSizeDistribution(
    boardId: string,
    config: { weeks?: number } | Record<string, unknown>
  ): Promise<PrSizeDistributionResult> {
    const scope = await getWidgetBoardScope(this.prisma, boardId);
    const built = buildPrSizeDistributionSql({ config, scope });
    if (built === null) {
      return { buckets: [], emptyReason: 'no_pr_source' };
    }

    const result = await this.clickhouse.query({
      query: built.sql,
      query_params: built.params,
      format: 'JSONEachRow',
    });
    const rows = castRows<{ label: string; count: number | string }>(await result.json());
    const countMap = new Map<string, number>(rows.map((r) => [r.label, Number(r.count)]));
    return {
      buckets: PR_SIZE_BUCKETS.map((b) => ({
        label: b.label,
        count: countMap.get(b.label) ?? 0,
        tier: b.tier,
      })),
    };
  }

  // Merge frequency per developer: one row per author with prs_merged in the
  // window, avg_per_week = prs_merged / window, an 8-cell trend of weekly
  // merge counts (oldest first), and the DX 2025 tier derived from the
  // weekly average. The trend window is fixed at MERGE_FREQ_TREND_WEEKS
  // regardless of the config window, so authors with sparse activity still
  // get a comparable sparkline.
  async getMergeFrequencyPerDev(
    boardId: string,
    config: Record<string, unknown>
  ): Promise<MergeFrequencyPerDevResult> {
    const scope = await getWidgetBoardScope(this.prisma, boardId);
    const built = buildMergeFrequencyPerDevSql({ config, scope });
    if (built === null) return { rows: [], emptyReason: 'no_pr_source' };

    const result = await this.clickhouse.query({
      query: built.sql,
      query_params: built.params,
      format: 'JSONEachRow',
    });
    const rows = castRows<{
      author: string;
      prs_merged: number | string;
      merged_weeks: string[];
    }>(await result.json());

    const trendBuckets = buildTrendWeekBuckets(new Date(), MERGE_FREQ_TREND_WEEKS);
    const bucketIndex = new Map<string, number>(trendBuckets.map((b, i) => [b, i]));
    const cfg = BENCHMARKS_V1.MERGE_FREQUENCY_PER_DEV!;
    const weeks = resolveWeeks((config as { weeks?: unknown }).weeks, MERGE_FREQ_TREND_WEEKS);

    return {
      rows: rows.map((r) => {
        const prsMerged = Number(r.prs_merged);
        const trend = new Array<number>(MERGE_FREQ_TREND_WEEKS).fill(0);
        for (const week of r.merged_weeks ?? []) {
          const idx = bucketIndex.get(week);
          if (idx !== undefined) trend[idx] = (trend[idx] ?? 0) + 1;
        }
        const avgPerWeek = prsMerged / weeks;
        return {
          author: r.author,
          prs_merged: prsMerged,
          avg_per_week: avgPerWeek,
          trend,
          tier: tierFor(avgPerWeek, cfg),
        };
      }),
    };
  }

  // Per-reviewer review load + approvals across github_reviews ∪ ado_reviews.
  // Returns emptyReason when the board has no GitHub repo / ADO project scope
  // (no review source). SQL lives in
  // intelligence-query/builders/reviewer-participation.ts.
  async getReviewerParticipation(
    boardId: string,
    config: Record<string, unknown>
  ): Promise<ReviewerParticipationResult> {
    const scope = await getWidgetBoardScope(this.prisma, boardId);
    const built = buildReviewerParticipationSql({ config, scope });
    if (built === null) return { rows: [], emptyReason: 'no_review_source' };

    const result = await this.clickhouse.query({
      query: built.sql,
      query_params: built.params,
      format: 'JSONEachRow',
    });
    const rows = castRows<{
      reviewer: string;
      provider: string;
      reviews_given: number | string;
      approvals: number | string;
    }>(await result.json());

    return {
      rows: rows.map((r) => ({
        reviewer: r.reviewer,
        provider: r.provider,
        reviews_given: Number(r.reviews_given),
        approvals: Number(r.approvals),
      })),
    };
  }

  // Commits per developer, unified across GitHub / GitLab / ADO. The builder
  // keys identity on the developer's display name (not git email) so one person
  // committing under several emails collapses into a single row; `email` is a
  // representative address for that person. Display name resolved via
  // developer_profiles (email → displayName), falling back to the commit
  // author_name, then the email. AI% is the share of the developer's commits
  // flagged ai_assisted; trend is weekly commit counts over the window. Empty
  // when the board has no commit-bearing source.
  async getCommitsPerDev(
    boardId: string,
    config: { weeks?: number } | Record<string, unknown>
  ): Promise<CommitsPerDevResult> {
    const scope = await getWidgetBoardScope(this.prisma, boardId);
    const built = buildCommitsPerDevSql({ config, scope });
    if (built === null) return { rows: [], emptyReason: 'no_commit_source' };

    const result = await this.clickhouse.query({
      query: built.sql,
      query_params: built.params,
      format: 'JSONEachRow',
    });
    const rows = castRows<{
      email: string;
      name: string;
      commits: number | string;
      additions: number | string;
      deletions: number | string;
      ai_commits: number | string;
      commit_weeks: string[];
    }>(await result.json());

    const emails = rows.map((r) => r.email).filter((e) => e.length > 0);
    const profiles = emails.length
      ? await this.prisma.developerProfile.findMany({
          where: { email: { in: emails } },
          select: { email: true, displayName: true, userId: true },
        })
      : [];
    const byEmail = new Map<string, { displayName: string | null; userId: string | null }>();
    for (const p of profiles) {
      if (p.email && !byEmail.has(p.email)) {
        byEmail.set(p.email, { displayName: p.displayName, userId: p.userId });
      }
    }

    const weeks = resolveWeeks(
      (config as { weeks?: unknown }).weeks,
      COMMITS_PER_DEV_TREND_WEEKS
    );
    const trendBuckets = buildTrendWeekBuckets(new Date(), weeks);
    const bucketIndex = new Map<string, number>(trendBuckets.map((b, i) => [b, i]));

    return {
      rows: rows.map((r) => {
        const commits = Number(r.commits);
        const aiCommits = Number(r.ai_commits);
        const trend = new Array<number>(weeks).fill(0);
        for (const wk of r.commit_weeks ?? []) {
          const idx = bucketIndex.get(wk);
          if (idx !== undefined) trend[idx] = (trend[idx] ?? 0) + 1;
        }
        const profile = byEmail.get(r.email);
        const name = profile?.displayName ?? (r.name && r.name.length > 0 ? r.name : r.email);
        return {
          email: r.email,
          name,
          userId: profile?.userId ?? null,
          commits,
          additions: Number(r.additions),
          deletions: Number(r.deletions),
          ai_pct: commits > 0 ? Math.round((aiCommits / commits) * 1000) / 10 : 0,
          trend,
        };
      }),
    };
  }

  // Rework rate: % of non-merge commits per week that follow the same author's
  // previous commit by less than 21 days. High rates suggest churn / rework
  // cycles on the same area. Tier per week from BENCHMARKS_V1.REWORK_RATE.
  // Empty when board has no commit provider in scope.
  async getReworkRate(
    boardId: string,
    config: { weeks?: number } | Record<string, unknown>
  ): Promise<ReworkRateResult> {
    const scope = await getWidgetBoardScope(this.prisma, boardId);
    const built = buildReworkRateSql({ config, scope });
    if (built === null) return { weeks: [], emptyReason: 'no_commit_source' };

    const result = await this.clickhouse.query({
      query: built.sql,
      query_params: built.params,
      format: 'JSONEachRow',
    });
    const rows = castRows<{ week_start: string; rework_pct: number | string | null }>(
      await result.json()
    );
    const cfg = BENCHMARKS_V1.REWORK_RATE!;
    return {
      weeks: rows.map((r) => {
        const pct = Math.round(Number(r.rework_pct ?? 0) * 10) / 10;
        return { week_start: r.week_start, rework_pct: pct, tier: tierFor(pct, cfg) };
      }),
    };
  }

  // Bug rate: weekly count of issues whose canonical `type` matches bug/defect
  // versus everything else. Per-leg semantics already collapse provider-specific
  // type fields in issuesUnion (jira issue_type, ado work_item_type,
  // synthesised from github labels). No benchmark band — interpret in context.
  async getBugRate(
    boardId: string,
    config: { weeks?: number } | Record<string, unknown>
  ): Promise<BugRateResult> {
    const scope = await getWidgetBoardScope(this.prisma, boardId);
    const built = buildBugRateSql({ config, scope });
    if (!built) {
      return { weeks: [], emptyReason: 'no_issue_source' };
    }

    const result = await this.clickhouse.query({
      query: built.sql,
      query_params: built.params,
      format: 'JSONEachRow',
    });
    const rows = castRows<{ week_start: string; bugs: number | string; other: number | string }>(
      await result.json()
    );
    return {
      weeks: rows.map((r) => ({
        week_start: r.week_start,
        bugs: Number(r.bugs),
        other: Number(r.other),
      })),
    };
  }

  // Investment allocation: how delivered work (issues closed in the window)
  // splits across investment categories (feature / bug / tech-debt / KTLO /
  // other). The builder emits raw per-type counts; classification + share math
  // lives in @deckgauge/shared so it stays provider-agnostic and unit-tested.
  async getInvestmentAllocation(
    boardId: string,
    config: { days?: number } | Record<string, unknown>
  ): Promise<InvestmentAllocationResult> {
    const scope = await getWidgetBoardScope(this.prisma, boardId);
    const built = buildInvestmentAllocationSql({ config, scope });
    if (!built) {
      return { slices: [], total: 0, emptyReason: 'no_issue_source' };
    }

    const result = await this.clickhouse.query({
      query: built.sql,
      query_params: built.params,
      format: 'JSONEachRow',
    });
    const rows = castRows<{ type: string; count: number | string }>(await result.json());
    const { slices, total } = aggregateInvestmentAllocation(
      rows.map((r) => ({ type: r.type, count: Number(r.count) }))
    );
    return { slices, total };
  }

  // DORA metrics scorecard: the four DORA delivery-performance metrics with
  // Elite/High/Medium/Low tiers. One ClickHouse round-trip returns the raw
  // aggregates; the service derives the per-week deploy rate and the change-
  // failure ratio, then @deckgauge/shared tiers them. Deployment Frequency now
  // reads real deployment records when the board's scope has any (falling back
  // to the merged-PR proxy, reported via deploySource); lead time, change
  // failure rate and time to restore are still proxies — see dora.ts. Any metric
  // whose source is absent comes back null → rendered "—".
  async getDoraMetrics(
    boardId: string,
    config: { weeks?: number } | Record<string, unknown>
  ): Promise<DoraMetricsResult> {
    const weeks =
      typeof (config as { weeks?: unknown }).weeks === 'number' &&
      (config as { weeks: number }).weeks > 0
        ? (config as { weeks: number }).weeks
        : 12;

    const scope = await getWidgetBoardScope(this.prisma, boardId);
    const built = buildDoraMetricsSql({ config, scope });
    if (!built) {
      return { metrics: [], weeks, emptyReason: 'no_source' };
    }

    const result = await this.clickhouse.query({
      query: built.sql,
      query_params: built.params,
      format: 'JSONEachRow',
    });
    const rows = castRows<{
      lead_time_hours: number | string | null;
      deploys_real: number | string | null;
      deploys_proxy: number | string | null;
      corrective_commits: number | string | null;
      total_commits: number | string | null;
      ttr_hours: number | string | null;
      failed_releases: number | string | null;
      total_releases: number | string | null;
    }>(await result.json());
    const r = rows[0];

    const num = (v: number | string | null | undefined): number | null =>
      v == null || v === '' ? null : Number(v);

    // Prefer real deployment records, but fall back to the merged-PR proxy when
    // they yield ZERO production deploys — a board whose pipelines only ever
    // deploy to DEV/UAT, or whose stages carry ADO's default "Stage 1" name,
    // has a deployment source that the production heuristic cannot read. Showing
    // it 0/wk as an observed number is worse than showing the proxy it replaced.
    const deploysReal = num(r?.deploys_real);
    const deploysProxy = num(r?.deploys_proxy);
    const useReal = deploysReal != null && deploysReal > 0;
    const deploys = useReal ? deploysReal : deploysProxy;
    const deploySource: 'deployments' | 'merge_proxy' = useReal ? 'deployments' : 'merge_proxy';
    const totalCommits = num(r?.total_commits);
    const corrective = num(r?.corrective_commits);

    // Change Failure Rate from OBSERVED release outcomes when there are releases
    // to measure, else the corrective-commit proxy.
    //
    // The switch keys on "were there any classifiable production releases", not
    // on "did the measurement come out above zero" — unlike deploy frequency
    // above, where a real zero and an unreadable zero are indistinguishable. Here
    // they are not: total_releases = 0 means nothing was measurable, while
    // failed = 0 out of 20 is a genuine clean run and must be reported as such.
    // Falling through on a true 0% would replace good news with a commit-message
    // guess.
    const failedReleases = num(r?.failed_releases);
    const totalReleases = num(r?.total_releases);
    const haveReleases = totalReleases != null && totalReleases > 0 && failedReleases != null;
    const changeFailureSource: 'deployments' | 'commit_proxy' = haveReleases
      ? 'deployments'
      : 'commit_proxy';
    const changeFailureRatePct = haveReleases
      ? (failedReleases / totalReleases) * 100
      : totalCommits == null || totalCommits === 0 || corrective == null
        ? null
        : (corrective / totalCommits) * 100;

    const metrics = buildDoraScorecard({
      leadTimeHours: num(r?.lead_time_hours),
      deployFreqPerWeek: deploys == null ? null : deploys / weeks,
      changeFailureRatePct,
      timeToRestoreHours: num(r?.ttr_hours),
    });

    return { metrics, weeks, deploySource, changeFailureSource };
  }

  // Period-over-Period scorecard. Runs the two-window builder in one round-trip,
  // converts merged-PR counts to a per-week deploy frequency for each window,
  // and derives the change-failure ratio, then hands raw values to the shared
  // direction-aware delta builder.
  async getPeriodComparison(
    boardId: string,
    config: Record<string, unknown>,
  ): Promise<PeriodComparisonResult> {
    const { a, b } = resolveComparePeriods(config, Date.now);
    const periodA = { from: a.from.toISOString(), to: a.to.toISOString() };
    const periodB = { from: b.from.toISOString(), to: b.to.toISOString() };

    const scope = await getWidgetBoardScope(this.prisma, boardId);
    const built = buildPeriodComparisonSql({ config, scope });
    if (!built)
      return {
        metrics: [],
        periodA,
        periodB,
        trajectories: {} as PeriodTrajectories,
        emptyReason: 'no_source',
      };

    const result = await this.clickhouse.query({
      query: built.sql,
      query_params: built.params,
      format: 'JSONEachRow',
    });
    const rows = castRows<Record<string, number | string | null>>(await result.json());
    const r = rows[0] ?? {};

    const num = (v: number | string | null | undefined): number | null =>
      v == null || v === '' ? null : Number(v);
    const weeks = (from: Date, to: Date) =>
      Math.max((to.getTime() - from.getTime()) / (7 * 24 * 60 * 60 * 1000), 1);
    const perWeek = (count: number | null, from: Date, to: Date) =>
      count == null ? null : count / weeks(from, to);
    const ratioPct = (part: number | null, total: number | null) =>
      part == null || total == null || total === 0 ? null : (part / total) * 100;

    const metrics = buildPeriodComparison({
      cycleTimeHours: { a: num(r.cycle_a), b: num(r.cycle_b) },
      issueCycleHours: { a: num(r.issue_cycle_a), b: num(r.issue_cycle_b) },
      deployFreqPerWeek: {
        a: perWeek(num(r.deploys_a), a.from, a.to),
        b: perWeek(num(r.deploys_b), b.from, b.to),
      },
      changeFailureRatePct: {
        a: ratioPct(num(r.corrective_a), num(r.total_a)),
        b: ratioPct(num(r.corrective_b), num(r.total_b)),
      },
      timeToRestoreHours: { a: num(r.ttr_a), b: num(r.ttr_b) },
      throughput: { a: num(r.throughput_a), b: num(r.throughput_b) },
    });

    const trendBuilt = buildPeriodComparisonTrendSql({ config, scope });
    // Built as a partial accumulator since only metrics whose source is in
    // scope get a leg in the trend SQL; cast to the full PeriodTrajectories
    // record at the return boundary (mirrors PeriodComparisonMetric['key'],
    // which is drawn from the same PeriodMetricKey union).
    const trajectories: Partial<PeriodTrajectories> = {};
    if (trendBuilt) {
      const tResult = await this.clickhouse.query({
        query: trendBuilt.sql,
        query_params: trendBuilt.params,
        format: 'JSONEachRow',
      });
      const tRows = castRows<{ metric: string; month: string; value: number | string | null }>(
        await tResult.json(),
      );
      for (const row of tRows) {
        const key = row.metric as PeriodMetricKey;
        (trajectories[key] ??= []).push({ month: row.month, value: num(row.value) });
      }
    }

    return { metrics, periodA, periodB, trajectories: trajectories as PeriodTrajectories };
  }

  // Iteration planning accuracy: % of items committed to a sprint/iteration
  // that ended up in a Done-equivalent state at closure. Only Jira sprints
  // and ADO iterations carry the data, so this builds a custom inline union
  // (NOT issuesUnion — github issues have no sprint concept).
  //
  // Two empty-reasons distinguish "no data sources" from "no data sources of
  // the right kind" so the widget can render a meaningful empty state.
  async getIterationPlanningAccuracy(
    boardId: string,
    config: { sprints?: number } | Record<string, unknown>
  ): Promise<IterationPlanningAccuracyResult> {
    const scope = await getWidgetBoardScope(this.prisma, boardId);
    const built = buildIterationPlanningAccuracySql({ config, scope });

    if (scope.isEmpty) {
      return { sprints: [], emptyReason: 'no_issue_source' };
    }
    if (built === null) {
      return { sprints: [], emptyReason: 'no_sprintable_source' };
    }

    const result = await this.clickhouse.query({
      query: built.sql,
      query_params: built.params,
      format: 'JSONEachRow',
    });
    const rows = castRows<{
      iteration_name: string;
      completed: number | string;
      committed: number | string;
      accuracy_pct: number | string | null;
    }>(await result.json());
    return {
      sprints: rows.map((r) => ({
        iteration_name: r.iteration_name,
        completed: Number(r.completed),
        committed: Number(r.committed),
        accuracy_pct: Math.round(Number(r.accuracy_pct ?? 0) * 10) / 10,
      })),
    };
  }

  // Velocity with confidence: per-sprint completed counts plus a flat ±1σ
  // confidence band derived from the last N sprints (mean ± stddevPop). The
  // band tells the VP whether the next sprint commitment is statistically
  // reasonable. Uses issuesUnion's sprint_name column; github rows alias
  // sprint_name to NULL so they self-filter out of the sprint aggregation.
  // Three empty reasons make the widget self-explanatory:
  //   no_issue_source     — board has no sources connected at all
  //   no_sprintable_source — sources connected, but only GitHub/GitLab (no sprints)
  //   no_sprint_data      — sprintable source connected but ClickHouse has zero sprint rows
  async getVelocityWithConfidence(
    boardId: string,
    config: { sprints?: number } | Record<string, unknown>
  ): Promise<VelocityWithConfidenceResult> {
    const scope = await getWidgetBoardScope(this.prisma, boardId);
    const built = buildVelocityWithConfidenceSql({ config, scope });

    if (scope.isEmpty) {
      return { sprints: [], emptyReason: 'no_issue_source' };
    }
    if (built === null) {
      return { sprints: [], emptyReason: 'no_sprintable_source' };
    }

    const result = await this.clickhouse.query({
      query: built.sql,
      query_params: built.params,
      format: 'JSONEachRow',
    });
    const rows = castRows<{
      sprint_name: string;
      completed: number | string;
      lower: number | string | null;
      upper: number | string | null;
    }>(await result.json());
    if (rows.length === 0) {
      return { sprints: [], emptyReason: 'no_sprint_data' };
    }
    return {
      sprints: rows.map((r) => ({
        sprint_name: r.sprint_name,
        completed: Number(r.completed),
        lower: Math.round(Number(r.lower ?? 0) * 10) / 10,
        upper: Math.round(Number(r.upper ?? 0) * 10) / 10,
      })),
    };
  }

  // Initiative risk radar: outstanding epics / milestones with deadlines,
  // bucketed by how soon they fall due relative to a configurable horizon.
  //
  // Schema-driven choices:
  //  - The plan referenced a `cockpit.jira_epics` table that doesn't exist
  //    in this build; epics live in jira_issues where issue_type='Epic'.
  //  - ADO work_items have no target_date / due_date column, so the ADO leg
  //    is intentionally absent. If a target-date column is added (or
  //    surfaced from custom_fields), this method can grow an ADO leg
  //    without changing its output shape.
  async getInitiativeRiskRadar(
    boardId: string,
    config: { horizon_days?: number } | Record<string, unknown>
  ): Promise<InitiativeRiskRadarResult> {
    const cfgHorizon = (config as { horizon_days?: unknown }).horizon_days;
    const horizonDays =
      typeof cfgHorizon === 'number' && cfgHorizon > 0 ? cfgHorizon : 30;

    const scope = await getWidgetBoardScope(this.prisma, boardId);
    const built = buildInitiativeRiskRadarSql({ config, scope });

    // Board projects carry the manually-editable Due date, which overrides the
    // synced Jira/GitHub deadline and can add board-native initiatives.
    const boardProjects = await this.prisma.project.findMany({
      where: { boardId },
      select: { name: true, status: true, dueDate: true, jiraKey: true, githubIssueId: true },
    });

    let sourceRows: SourceInitiativeRow[] = [];
    if (built !== null) {
      const result = await this.clickhouse.query({
        query: built.sql,
        query_params: built.params,
        format: 'JSONEachRow',
      });
      sourceRows = castRows<{
        name: string;
        due_date: string;
        status: string;
        source: InitiativeSource;
      }>(await result.json());
    }

    // Truly empty only when there is neither a synced source nor any board due
    // date to fall back on — otherwise the board-set dates carry the widget.
    if (built === null && boardProjects.every((p) => p.dueDate === null)) {
      return { initiatives: [], emptyReason: 'no_issue_source' };
    }

    const initiatives = mergeInitiativeRows(sourceRows, boardProjects, new Date(), horizonDays);
    return { initiatives };
  }

  // Issues opened vs closed: per-week count of issues created and closed
  // within the window. FULL OUTER JOIN means a week with opens-but-no-closes
  // (or vice versa) still surfaces, with the other side zero-filled.
  async getIssuesOpenedVsClosed(
    boardId: string,
    config: { weeks?: number } | Record<string, unknown>
  ): Promise<IssuesOpenedVsClosedResult> {
    const scope = await getWidgetBoardScope(this.prisma, boardId);
    const built = buildIssuesOpenedVsClosedSql({ config, scope });
    if (built === null) {
      return { weeks: [], emptyReason: 'no_issue_source' };
    }

    const result = await this.clickhouse.query({
      query: built.sql,
      query_params: built.params,
      format: 'JSONEachRow',
    });
    const rows = castRows<{
      week_start: string;
      opened: number | string;
      closed: number | string;
    }>(await result.json());
    return {
      weeks: rows.map((r) => ({
        week_start: r.week_start,
        opened: Number(r.opened),
        closed: Number(r.closed),
      })),
    };
  }

  // Work-in-progress count: per-week count of issues that were created on or
  // before week n and not yet closed by the end of week n. ARRAY JOIN over
  // range(0, weeks) is ClickHouse's idiomatic way to evaluate the same
  // expression across a series of offsets.
  //
  // Note: the WIP_STATES set is the cross-provider best effort; widgets
  // displaying WIP for GitHub-only boards will mostly show zeros since
  // GitHub issues have no in-progress state vocabulary.
  async getWipCount(
    boardId: string,
    config: { weeks?: number } | Record<string, unknown>
  ): Promise<WipCountResult> {
    const scope = await getWidgetBoardScope(this.prisma, boardId);
    const built = buildWipCountSql({ config, scope });
    if (built === null) {
      return { current: 0, trend: [], emptyReason: 'no_issue_source' };
    }

    const result = await this.clickhouse.query({
      query: built.sql,
      query_params: built.params,
      format: 'JSONEachRow',
    });
    const rows = castRows<{ week_start: string; wip: number | string }>(await result.json());
    const trend = rows.map((r) => Number(r.wip));
    const current = trend.length > 0 ? trend[trend.length - 1]! : 0;
    return { current, trend };
  }

  // Ticket coverage rate: % of merged PRs that carry at least one linked
  // ticket key (Jira/ADO/etc). Tier is computed on the *current* (latest)
  // weekly value, since the user reads this widget as a now-state indicator
  // with trend context.
  async getTicketCoverageRate(
    boardId: string,
    config: { weeks?: number } | Record<string, unknown>
  ): Promise<TicketCoverageRateResult> {
    const cfg = BENCHMARKS_V1.TICKET_COVERAGE_RATE!;

    const scope = await getWidgetBoardScope(this.prisma, boardId);
    const built = buildTicketCoverageRateSql({ config, scope });
    if (built === null) {
      return {
        current_pct: 0,
        trend: [],
        tier: tierFor(0, cfg),
        emptyReason: 'no_pr_source',
      };
    }

    const result = await this.clickhouse.query({
      query: built.sql,
      query_params: built.params,
      format: 'JSONEachRow',
    });
    const rows = castRows<{ week_start: string; coverage_pct: number | string | null }>(
      await result.json()
    );
    const trend = rows.map((r) => Math.round(Number(r.coverage_pct ?? 0) * 10) / 10);
    const currentPct = trend.length > 0 ? trend[trend.length - 1]! : 0;
    return { current_pct: currentPct, trend, tier: tierFor(currentPct, cfg) };
  }

  // AI-assisted PR percentage: weekly share of merged PRs flagged by the
  // upstream ai_assisted detector. No benchmark band — every team's AI
  // adoption story is its own context.
  async getAiAssistedPrPct(
    boardId: string,
    config: { weeks?: number } | Record<string, unknown>
  ): Promise<AiAssistedPrPctResult> {
    const scope = await getWidgetBoardScope(this.prisma, boardId);
    const built = buildAiAssistedPrPctSql({ config, scope });
    if (built === null) {
      return { current_pct: 0, trend: [], emptyReason: 'no_pr_source' };
    }

    const result = await this.clickhouse.query({
      query: built.sql,
      query_params: built.params,
      format: 'JSONEachRow',
    });
    const rows = castRows<{
      week_start: string;
      ai_pct: number | string | null;
      ai_count: number | string | null;
      pr_total: number | string | null;
    }>(await result.json());
    const trend = rows.map((r) => Math.round(Number(r.ai_pct ?? 0) * 10) / 10);
    // Headline is the whole-window aggregate (total AI-flagged merged PRs /
    // total merged PRs), NOT the last weekly bucket — the newest bucket is the
    // current partial week and reads as a misleading 0% on low volume. Weight
    // by counts, since averaging the rounded weekly percentages over-weights
    // small weeks and diverges from the AI Adoption widget.
    const totalAi = rows.reduce((sum, r) => sum + Number(r.ai_count ?? 0), 0);
    const totalPrs = rows.reduce((sum, r) => sum + Number(r.pr_total ?? 0), 0);
    const currentPct = totalPrs > 0 ? Math.round((1000 * totalAi) / totalPrs) / 10 : 0;
    return { current_pct: currentPct, trend };
  }

  // Review Mix: split GitHub PR reviews into bot vs human and surface (a) the
  // bot share of "first non-comment reviews" per PR, (b) median pickup time
  // for each reviewer type, and (c) a weekly trend of bot share. SQL lives in
  // intelligence-query/builders/review-mix.ts; this method just fans the
  // UNION ALL rows back into the typed summary + weekly result shape.
  //
  // GitHub-only: github_reviews has no parallel gitlab/ado table today, so a
  // board with only those providers returns emptyReason='no_github_source'.
  async getReviewMix(
    boardId: string,
    config: { weeks?: number } | Record<string, unknown>
  ): Promise<ReviewMixResult> {
    const emptySummary = {
      bot_pct: 0,
      human_p50_hours: 0,
      bot_p50_hours: 0,
      comment_bot_pct: 0,
      comment_bot_count: 0,
      comment_human_count: 0,
    };

    const scope = await getWidgetBoardScope(this.prisma, boardId);
    const built = buildReviewMixSql({ config: config as Record<string, unknown>, scope });
    if (built === null) {
      return { summary: emptySummary, weeks: [], emptyReason: 'no_github_source' };
    }

    const result = await this.clickhouse.query({
      query: built.sql,
      query_params: built.params,
      format: 'JSONEachRow',
    });
    const rows = castRows<{
      kind: 'summary' | 'human_p50' | 'bot_p50' | 'weekly' | 'comments';
      week_start: string;
      total: number | string;
      bot_count: number | string;
      p50_hours: number | string | null;
    }>(await result.json());

    const summaryRow = rows.find((r) => r.kind === 'summary');
    const humanP50Row = rows.find((r) => r.kind === 'human_p50');
    const botP50Row = rows.find((r) => r.kind === 'bot_p50');
    const commentsRow = rows.find((r) => r.kind === 'comments');

    const total = Number(summaryRow?.total ?? 0);
    const botCount = Number(summaryRow?.bot_count ?? 0);
    const botPct = total > 0 ? Math.round((botCount / total) * 1000) / 10 : 0;
    const humanP50 = Math.round(Number(humanP50Row?.p50_hours ?? 0) * 10) / 10;
    const botP50 = Math.round(Number(botP50Row?.p50_hours ?? 0) * 10) / 10;

    const commentTotal = Number(commentsRow?.total ?? 0);
    const commentBotCount = Number(commentsRow?.bot_count ?? 0);
    const commentBotPct =
      commentTotal > 0 ? Math.round((commentBotCount / commentTotal) * 1000) / 10 : 0;

    const weeks = rows
      .filter((r) => r.kind === 'weekly')
      .sort((a, b) => a.week_start.localeCompare(b.week_start))
      .map((r) => {
        const t = Number(r.total);
        const b = Number(r.bot_count);
        const pct = t > 0 ? Math.round((b / t) * 1000) / 10 : 0;
        return { week_start: r.week_start, bot_pct: pct };
      });

    return {
      summary: {
        bot_pct: botPct,
        human_p50_hours: humanP50,
        bot_p50_hours: botP50,
        comment_bot_pct: commentBotPct,
        comment_bot_count: commentBotCount,
        comment_human_count: commentTotal - commentBotCount,
      },
      weeks,
    };
  }

  // Bot vs Human authorship: commit-based human/bot split of work landed in the
  // period. "Bot" = AI-assisted commits (Claude Code & other assistants) as
  // flagged by the upstream ai_assisted detector. Multi-source via commitsUnion;
  // a board with no commit source returns emptyReason='no_commit_source'.
  // SQL lives in intelligence-query/builders/bot-vs-human.ts.
  async getBotVsHuman(
    boardId: string,
    config: { weeks?: number } | Record<string, unknown>
  ): Promise<BotVsHumanResult> {
    const emptySummary = { total: 0, bot_count: 0, human_count: 0, bot_pct: 0 };

    const scope = await getWidgetBoardScope(this.prisma, boardId);
    const built = buildBotVsHumanSql({ config: config as Record<string, unknown>, scope });
    if (built === null) {
      return { summary: emptySummary, weeks: [], emptyReason: 'no_commit_source' };
    }

    const result = await this.clickhouse.query({
      query: built.sql,
      query_params: built.params,
      format: 'JSONEachRow',
    });
    const rows = castRows<{
      kind: 'summary' | 'weekly';
      week_start: string;
      total: number | string;
      bot_count: number | string;
    }>(await result.json());

    const summaryRow = rows.find((r) => r.kind === 'summary');
    const total = Number(summaryRow?.total ?? 0);
    const botCount = Number(summaryRow?.bot_count ?? 0);
    const botPct = total > 0 ? Math.round((botCount / total) * 1000) / 10 : 0;

    const weeks = rows
      .filter((r) => r.kind === 'weekly')
      .sort((a, b) => a.week_start.localeCompare(b.week_start))
      .map((r) => {
        const t = Number(r.total);
        const b = Number(r.bot_count);
        return { week_start: r.week_start, total: t, bot_count: b, human_count: t - b };
      });

    return {
      summary: { total, bot_count: botCount, human_count: total - botCount, bot_pct: botPct },
      weeks,
    };
  }

  // Review Quality Index: one scorecard row of five review-quality KPIs over
  // merged PRs in the window (coverage %, median open hours, instant-merge %,
  // comment %, ticket %). github_reviews ∪ ado_reviews; empty when the board
  // has no GitHub repo / ADO project scope. SQL in
  // intelligence-query/builders/review-quality-index.ts.
  async getReviewQualityIndex(
    boardId: string,
    config: Record<string, unknown>
  ): Promise<ReviewQualityIndexResult> {
    const scope = await getWidgetBoardScope(this.prisma, boardId);
    const built = buildReviewQualityIndexSql({ config, scope });
    if (built === null) {
      return {
        coverage_pct: null,
        median_open_h: null,
        instant_pct: null,
        comment_pct: null,
        ticket_pct: null,
        merged_prs: 0,
        emptyReason: 'no_pr_source',
      };
    }

    const result = await this.clickhouse.query({
      query: built.sql,
      query_params: built.params,
      format: 'JSONEachRow',
    });
    const [row] = castRows<Record<string, string | number | null>>(await result.json());
    const num = (v: unknown): number | null =>
      v === null || v === undefined ? null : Number(v);
    return {
      coverage_pct: num(row?.coverage_pct),
      median_open_h: num(row?.median_open_h),
      instant_pct: num(row?.instant_pct),
      comment_pct: num(row?.comment_pct),
      ticket_pct: num(row?.ticket_pct),
      merged_prs: Number(row?.merged_prs ?? 0),
    };
  }

  // Review Quality Trend (Phase 2): peer-approval-coverage-over-time line with
  // a comment-rate line overlaid, plus the Phase-1 five-KPI scorecard for the
  // whole window. SQL returns two row shapes discriminated by `kind` in one
  // BuiltSql (mirrors getReviewMix's UNION ALL fan-out); this method splits
  // them back into `trend[]` + `scorecard`. Empty when the board has no
  // GitHub repo / ADO project scope. SQL in
  // intelligence-query/builders/review-quality-trend.ts.
  async getReviewQualityTrend(
    boardId: string,
    config: Record<string, unknown>
  ): Promise<ReviewQualityTrendResult> {
    const emptyScorecard: ReviewQualityIndexResult = {
      coverage_pct: null,
      median_open_h: null,
      instant_pct: null,
      comment_pct: null,
      ticket_pct: null,
      merged_prs: 0,
    };

    const scope = await getWidgetBoardScope(this.prisma, boardId);
    const built = buildReviewQualityTrendSql({ config, scope });
    if (built === null) {
      return { trend: [], scorecard: emptyScorecard, emptyReason: 'no_pr_source' };
    }

    const result = await this.clickhouse.query({
      query: built.sql,
      query_params: built.params,
      format: 'JSONEachRow',
    });
    const rows = castRows<{
      kind: 'trend' | 'scorecard';
      period: string;
      coverage_pct: string | number | null;
      comment_pct: string | number | null;
      sample: string | number;
      median_open_h: string | number | null;
      instant_pct: string | number | null;
      ticket_pct: string | number | null;
      merged_prs: string | number;
    }>(await result.json());

    const num = (v: unknown): number | null =>
      v === null || v === undefined ? null : Number(v);

    const trend = rows
      .filter((r) => r.kind === 'trend')
      .sort((a, b) => a.period.localeCompare(b.period))
      .map((r) => ({
        period: r.period,
        coverage_pct: num(r.coverage_pct),
        comment_pct: num(r.comment_pct),
        sample: Number(r.sample ?? 0),
      }));

    const scorecardRow = rows.find((r) => r.kind === 'scorecard');
    const scorecard: ReviewQualityIndexResult = scorecardRow
      ? {
          coverage_pct: num(scorecardRow.coverage_pct),
          median_open_h: num(scorecardRow.median_open_h),
          instant_pct: num(scorecardRow.instant_pct),
          comment_pct: num(scorecardRow.comment_pct),
          ticket_pct: num(scorecardRow.ticket_pct),
          merged_prs: Number(scorecardRow.merged_prs ?? 0),
        }
      : emptyScorecard;

    return { trend, scorecard };
  }

  // Flow throughput & cycle time: per-period items delivered (bar) plus the
  // age-filtered median cycle time (line), with a `flagged` marker when a
  // period has items older than the configured maxAgeDays. Jira + ADO done
  // dates; empty when the board has no jira/ado scope. SQL in
  // intelligence-query/builders/flow-throughput-cycle.ts.
  async getFlowThroughputCycle(
    boardId: string,
    config: Record<string, unknown>
  ): Promise<FlowThroughputCycleResult> {
    const scope = await getWidgetBoardScope(this.prisma, boardId);
    const built = buildFlowThroughputCycleSql({ config, scope });
    if (built === null) return { series: [], emptyReason: 'no_issue_source' };

    const result = await this.clickhouse.query({
      query: built.sql,
      query_params: built.params,
      format: 'JSONEachRow',
    });
    const rows = castRows<{
      period: string;
      delivered: number | string;
      cycle_days: number | string | null;
      sample: number | string;
      flagged: number | boolean;
    }>(await result.json());
    return {
      series: rows.map((r) => ({
        period: r.period,
        delivered: Number(r.delivered),
        cycle_days: r.cycle_days === null ? null : Number(r.cycle_days),
        sample: Number(r.sample),
        flagged: Boolean(Number(r.flagged)),
      })),
    };
  }

  // AI Adoption: per-period AI-assisted PR% and commit% across
  // github_pull_requests ∪ ado_pull_requests (PR leg) and
  // github_commits ∪ ado_commits (non-merge commit leg). Bucketed weekly or
  // monthly via config.bucket. Detection is trailer-based; absence ≠ zero use.
  // Empty when the board has no GitHub / ADO code source. SQL in
  // intelligence-query/builders/ai-adoption.ts.
  async getAiAdoption(
    boardId: string,
    config: Record<string, unknown>
  ): Promise<AiAdoptionResult> {
    const scope = await getWidgetBoardScope(this.prisma, boardId);
    const built = buildAiAdoptionSql({ config, scope });
    if (built === null) return { rows: [], emptyReason: 'no_code_source' };

    const result = await this.clickhouse.query({
      query: built.sql,
      query_params: built.params,
      format: 'JSONEachRow',
    });
    const rows = castRows<{
      period: string;
      ai_pr_pct: number | string;
      ai_commit_pct: number | string;
      pr_total: number | string;
      commit_total: number | string;
    }>(await result.json());
    return {
      rows: rows.map((r) => ({
        period: r.period,
        ai_pr_pct: Number(r.ai_pr_pct),
        ai_commit_pct: Number(r.ai_commit_pct),
        pr_total: Number(r.pr_total),
        commit_total: Number(r.commit_total),
      })),
    };
  }

  // Delivery trend with calendar overlay + peak marker. Runs the Jira/ADO
  // items-delivered-per-period builder, then attaches (a) the max-delivered
  // period as `peak` and (b) any board_calendar_events (board-scoped or
  // global) overlapping the resolved window, read from Postgres via Prisma.
  // Empty when the board has no jira/ado scope.
  async getDeliveryTrendAnnotated(
    boardId: string,
    config: Record<string, unknown>
  ): Promise<DeliveryTrendAnnotatedResult> {
    const scope = await getWidgetBoardScope(this.prisma, boardId);
    const built = buildDeliveryTrendAnnotatedSql({ config, scope });
    if (built === null) {
      return { series: [], peak: null, events: [], emptyReason: 'no_issue_source' };
    }

    const result = await this.clickhouse.query({
      query: built.sql,
      query_params: built.params,
      format: 'JSONEachRow',
    });
    const rows = castRows<{
      period: string;
      delivered: number | string;
      sample: number | string;
    }>(await result.json());
    const series: DeliveryTrendAnnotatedSeriesPoint[] = rows.map((r) => ({
      period: r.period,
      delivered: Number(r.delivered),
      sample: Number(r.sample),
    }));

    const peak = series.reduce<DeliveryTrendAnnotatedPeak | null>((best, p) => {
      if (best === null || p.delivered > best.value) {
        return { period: p.period, value: p.delivered };
      }
      return best;
    }, null);

    const weeks = resolveWeeks((config as { weeks?: unknown }).weeks, 12);
    const { from, to } = resolvePeriod(config, Date.now, weeks * 7);
    const eventRows = await this.prisma.boardCalendarEvent.findMany({
      where: {
        OR: [{ boardId }, { boardId: null }],
        startsAt: { lt: to },
        endsAt: { gt: from },
      },
      orderBy: { startsAt: 'asc' },
    });
    const events: DeliveryTrendAnnotatedEvent[] = eventRows.map((e) => ({
      label: e.label,
      kind: e.kind,
      startsAt: e.startsAt.toISOString(),
      endsAt: e.endsAt.toISOString(),
      color: e.color,
    }));

    return { series, peak, events };
  }

  // -------------------------------------------------------------------------
  // P6 — multi-board comparison methods.
  //
  // Each resolves the comparison's persisted board set (comparison_members
  // ordered by position), fans an EXISTING single-board method out once per
  // board (never duplicating metric SQL), and labels each result with its
  // board + effective-dev headcount. Per-metric comparability flags are
  // computed from the resolved scopes so the web layer can grey non-comparable
  // cells. The `:boardId` route slot carries the Comparison id.
  // -------------------------------------------------------------------------

  /** Resolve the ordered board set for a comparison, with names + scopes. */
  private async resolveComparisonBoards(comparisonId: string): Promise<BoardScopeEntry[]> {
    const members = await this.prisma.comparisonMember.findMany({
      where: { comparisonId },
      orderBy: { position: 'asc' },
      select: { boardId: true },
    });
    return getBoardScopes(this.prisma, members.map((m) => m.boardId));
  }

  /**
   * Effective-developer headcount per board. The current schema has no
   * Board→OrgTree link, so this resolves to null for every board today (→
   * per-capita metrics are flagged non-comparable). Isolated here so a later
   * slice can wire the org roster in one place without touching callers.
   */
  private async resolveEffectiveDevHeadcounts(
    _entries: ReadonlyArray<BoardScopeEntry>
  ): Promise<Map<string, number | null>> {
    return new Map(_entries.map((e) => [e.boardId, null as number | null]));
  }

  async getCompareReviewQuality(
    comparisonId: string,
    config: Record<string, unknown>
  ): Promise<CompareReviewQualityResult> {
    const entries = await this.resolveComparisonBoards(comparisonId);
    const headcounts = await this.resolveEffectiveDevHeadcounts(entries);

    const boards: CompareReviewQualityBoard[] = await Promise.all(
      entries.map(async (e) => {
        const r = await this.getReviewQualityTrend(e.boardId, config);
        return {
          boardId: e.boardId,
          boardName: e.boardName,
          effectiveDevHeadcount: headcounts.get(e.boardId) ?? null,
          scorecard: r.scorecard,
          trend: r.trend,
          ...(r.emptyReason ? { emptyReason: r.emptyReason } : {}),
        };
      })
    );

    return {
      boards,
      comparability: {
        coverage_pct: rateMetricComparability(),
        median_open_h: rateMetricComparability(),
        comment_pct: rateMetricComparability(),
        merged_prs: countMetricComparability(entries),
      },
    };
  }

  async getCompareFlow(
    comparisonId: string,
    config: Record<string, unknown>
  ): Promise<CompareFlowResult> {
    const entries = await this.resolveComparisonBoards(comparisonId);
    const headcounts = await this.resolveEffectiveDevHeadcounts(entries);

    const boards: CompareFlowBoard[] = await Promise.all(
      entries.map(async (e) => {
        const r = await this.getFlowThroughputCycle(e.boardId, config);
        return {
          boardId: e.boardId,
          boardName: e.boardName,
          effectiveDevHeadcount: headcounts.get(e.boardId) ?? null,
          series: r.series,
          ...(r.emptyReason ? { emptyReason: r.emptyReason } : {}),
        };
      })
    );

    return {
      boards,
      comparability: {
        cycle_days: rateMetricComparability(),
        delivered: countMetricComparability(entries),
      },
    };
  }

  async getCompareDelivery(
    comparisonId: string,
    config: Record<string, unknown>
  ): Promise<CompareDeliveryResult> {
    const entries = await this.resolveComparisonBoards(comparisonId);
    const headcounts = await this.resolveEffectiveDevHeadcounts(entries);

    const perBoard = await Promise.all(
      entries.map(async (e) => {
        const r = await this.getDeliveryTrendAnnotated(e.boardId, config);
        return { entry: e, result: r };
      })
    );

    const boards: CompareDeliveryBoard[] = perBoard.map(({ entry, result }) => ({
      boardId: entry.boardId,
      boardName: entry.boardName,
      effectiveDevHeadcount: headcounts.get(entry.boardId) ?? null,
      series: result.series,
      peak: result.peak,
      ...(result.emptyReason ? { emptyReason: result.emptyReason } : {}),
    }));

    // Freeze/migration/holiday overlay is shared: merge each board's events and
    // dedupe on (label, startsAt, endsAt) so a global event isn't drawn N times.
    const seen = new Set<string>();
    const events: DeliveryTrendAnnotatedEvent[] = [];
    for (const { result } of perBoard) {
      for (const ev of result.events) {
        const key = `${ev.label}|${ev.startsAt}|${ev.endsAt}`;
        if (seen.has(key)) continue;
        seen.add(key);
        events.push(ev);
      }
    }

    return {
      boards,
      events,
      comparability: {
        delivered: countMetricComparability(entries),
      },
    };
  }
}

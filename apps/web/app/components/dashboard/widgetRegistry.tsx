import { ComponentType } from 'react';
import StatusDistributionWidget from './widgets/StatusDistributionWidget';
import StatusByGroupWidget from './widgets/StatusByGroupWidget';
import ItemsByOwnerWidget from './widgets/ItemsByOwnerWidget';
import VelocityLeaderboardWidget from './widgets/VelocityLeaderboardWidget';
import CompletionRateWidget from './widgets/CompletionRateWidget';
import RecentlyCompletedWidget from './widgets/RecentlyCompletedWidget';
import StuckIssuesWidget from './widgets/StuckIssuesWidget';
import BlockedItemsWidget from './widgets/BlockedItemsWidget';
import StaleItemsWidget from './widgets/StaleItemsWidget';
import TotalCountWidget from './widgets/TotalCountWidget';
import StatusSummaryWidget from './widgets/StatusSummaryWidget';
import ChCompletionTrendWidget from './widgets/ChCompletionTrendWidget';
import ChVelocityWidget from './widgets/ChVelocityWidget';
import ChCycleTimeTrendWidget from './widgets/ChCycleTimeTrendWidget';
import ChBacklogAgeWidget from './widgets/ChBacklogAgeWidget';
import LeadTimeForChangesWidget from './widgets/LeadTimeForChangesWidget';
import PrCycleTimeScatterWidget from './widgets/PrCycleTimeScatterWidget';
import ReviewPickupTimeWidget from './widgets/ReviewPickupTimeWidget';
import PrSizeDistributionWidget from './widgets/PrSizeDistributionWidget';
import MergeFrequencyPerDevWidget from './widgets/MergeFrequencyPerDevWidget';
import ReworkRateWidget from './widgets/ReworkRateWidget';
import BugRateWidget from './widgets/BugRateWidget';
import IterationPlanningAccuracyWidget from './widgets/IterationPlanningAccuracyWidget';
import VelocityWithConfidenceWidget from './widgets/VelocityWithConfidenceWidget';
import InitiativeRiskRadarWidget from './widgets/InitiativeRiskRadarWidget';
import IssuesOpenedVsClosedWidget from './widgets/IssuesOpenedVsClosedWidget';
import WipCountWidget from './widgets/WipCountWidget';
import TicketCoverageRateWidget from './widgets/TicketCoverageRateWidget';
import AiAssistedPrPctWidget from './widgets/AiAssistedPrPctWidget';
import ReviewMixWidget from './widgets/ReviewMixWidget';
import BotVsHumanWidget from './widgets/BotVsHumanWidget';
import CommitsPerDevWidget from './widgets/CommitsPerDevWidget';
import ReviewerParticipationWidget from './widgets/ReviewerParticipationWidget';
import ReviewQualityIndexWidget from './widgets/ReviewQualityIndexWidget';
import ReviewQualityTrendWidget from './widgets/ReviewQualityTrendWidget';
import FlowThroughputCycleWidget from './widgets/FlowThroughputCycleWidget';
import DeliveryTrendAnnotatedWidget from './widgets/DeliveryTrendAnnotatedWidget';
import AiAdoptionWidget from './widgets/AiAdoptionWidget';
import InvestmentAllocationWidget from './widgets/InvestmentAllocationWidget';
import DoraMetricsWidget from './widgets/DoraMetricsWidget';
import PeriodComparisonWidget from './widgets/PeriodComparisonWidget';
import CompareReviewQualityWidget from './widgets/CompareReviewQualityWidget';
import CompareFlowWidget from './widgets/CompareFlowWidget';
import CompareDeliveryWidget from './widgets/CompareDeliveryWidget';
import {
  BENCHMARKS_V1,
  type WidgetSubject,
  type WidgetCategory,
  type ChartKind,
} from '@deckgauge/shared';

interface ConfigField {
  key: string;
  label: string;
  type: 'number' | 'select';
  default: unknown;
  options?: Array<{ label: string; value: unknown }>;
}

export interface WidgetDefinition {
  type: string;
  label: string;
  description: string;
  category: WidgetCategory;
  defaultSize: { w: number; h: number };
  configFields?: ConfigField[];
  component: ComponentType<{ boardId: string; config: Record<string, unknown> }>;

  // new metadata
  subject: WidgetSubject;
  sources: Array<'jira' | 'github' | 'gitlab' | 'ado'>;
  requiredScopeAny?: Array<
    'jiraProjectKeys' | 'githubRepoFullNames' | 'gitlabProjectPaths' | 'adoProjects'
  >;
  chartKind: ChartKind;
  benchmarks?: (typeof BENCHMARKS_V1)[keyof typeof BENCHMARKS_V1];
  drillDownHref?: string;
  // Maps a row/point field to the ClickHouse column to filter on when the
  // user clicks that element. Presence opts the widget into the intelligence
  // console drill-through path.
  drillDimensions?: Record<string, string>;
  timeAware?: boolean;
  // P6 — comparison widgets render only on a standalone Comparison (fed the
  // comparison id in the boardId slot). Excluded from the normal
  // dashboard widget picker.
  requiresComparisonView?: boolean;
}

export const WIDGET_CATALOG: WidgetDefinition[] = [
  {
    type: 'STATUS_DISTRIBUTION',
    label: 'Status Distribution',
    description: 'Pie chart showing project count per status',
    category: 'board-health',
    subject: 'board_state',
    sources: [],
    chartKind: 'donut',
    defaultSize: { w: 4, h: 3 },
    component: StatusDistributionWidget,
  },
  {
    type: 'STATUS_BY_GROUP',
    label: 'Status by Group',
    description: 'Stacked bar chart with status breakdown per group',
    category: 'board-health',
    subject: 'board_state',
    sources: [],
    chartKind: 'bar',
    defaultSize: { w: 6, h: 4 },
    component: StatusByGroupWidget,
  },
  {
    type: 'ITEMS_BY_OWNER',
    label: 'Items by Owner',
    description: 'Horizontal bar chart of projects per owner',
    category: 'board-health',
    subject: 'board_state',
    sources: [],
    chartKind: 'bar',
    defaultSize: { w: 4, h: 4 },
    configFields: [
      {
        key: 'statusFilter',
        label: 'Status Filter',
        type: 'select',
        default: '',
        options: [
          { label: 'All', value: '' },
          { label: 'In Progress', value: 'IN_PROGRESS' },
          { label: 'Blocked', value: 'BLOCKED' },
        ],
      },
    ],
    component: ItemsByOwnerWidget,
  },
  {
    type: 'VELOCITY_LEADERBOARD',
    label: 'Velocity Leaderboard',
    description: 'Engineers ranked by average task completion time',
    category: 'speed',
    subject: 'pull_requests',
    sources: [],
    chartKind: 'list',
    timeAware: true,
    defaultSize: { w: 5, h: 4 },
    configFields: [
      {
        key: 'days',
        label: 'Time Range (days)',
        type: 'select',
        default: 30,
        options: [
          { label: '7 days', value: 7 },
          { label: '14 days', value: 14 },
          { label: '30 days', value: 30 },
        ],
      },
    ],
    component: VelocityLeaderboardWidget,
  },
  {
    type: 'COMPLETION_RATE',
    label: 'Completion Rate',
    description: 'Percentage of items completed in a time period',
    category: 'flow',
    subject: 'board_state',
    sources: [],
    chartKind: 'kpi',
    timeAware: true,
    defaultSize: { w: 3, h: 2 },
    configFields: [
      {
        key: 'days',
        label: 'Time Range (days)',
        type: 'select',
        default: 30,
        options: [
          { label: '7 days', value: 7 },
          { label: '14 days', value: 14 },
          { label: '30 days', value: 30 },
        ],
      },
    ],
    component: CompletionRateWidget,
  },
  {
    type: 'RECENTLY_COMPLETED',
    label: 'Recently Completed',
    description: 'List of items most recently moved to Done',
    category: 'flow',
    subject: 'board_state',
    sources: [],
    chartKind: 'list',
    defaultSize: { w: 5, h: 4 },
    configFields: [
      {
        key: 'limit',
        label: 'Show',
        type: 'select',
        default: 10,
        options: [
          { label: '5 items', value: 5 },
          { label: '10 items', value: 10 },
          { label: '20 items', value: 20 },
        ],
      },
    ],
    component: RecentlyCompletedWidget,
  },
  {
    type: 'STUCK_ISSUES',
    label: 'Stuck in Progress',
    description: 'Items in progress longer than a threshold',
    category: 'board-health',
    subject: 'board_state',
    sources: [],
    chartKind: 'list',
    defaultSize: { w: 6, h: 4 },
    configFields: [
      { key: 'thresholdDays', label: 'Threshold (days)', type: 'number', default: 7 },
    ],
    component: StuckIssuesWidget,
  },
  {
    type: 'BLOCKED_ITEMS',
    label: 'Blocked Items',
    description: 'All items currently in Blocked status',
    category: 'board-health',
    subject: 'board_state',
    sources: [],
    chartKind: 'list',
    defaultSize: { w: 6, h: 3 },
    component: BlockedItemsWidget,
  },
  {
    type: 'STALE_ITEMS',
    label: 'Stale Items',
    description: 'Items not updated within a threshold period',
    category: 'board-health',
    subject: 'board_state',
    sources: [],
    chartKind: 'list',
    defaultSize: { w: 6, h: 4 },
    configFields: [
      { key: 'thresholdDays', label: 'Staleness (days)', type: 'number', default: 14 },
    ],
    component: StaleItemsWidget,
  },
  {
    type: 'TOTAL_COUNT',
    label: 'Total Count',
    description: 'Total number of projects on this board',
    category: 'board-health',
    subject: 'board_state',
    sources: [],
    chartKind: 'kpi',
    defaultSize: { w: 2, h: 2 },
    configFields: [
      {
        key: 'statusFilter',
        label: 'Status Filter',
        type: 'select',
        default: '',
        options: [
          { label: 'All', value: '' },
          { label: 'In Progress', value: 'IN_PROGRESS' },
          { label: 'Done', value: 'DONE' },
        ],
      },
    ],
    component: TotalCountWidget,
  },
  {
    type: 'STATUS_SUMMARY',
    label: 'Status Summary',
    description: 'Number cards for each status with count',
    category: 'board-health',
    subject: 'board_state',
    sources: [],
    chartKind: 'kpi',
    defaultSize: { w: 6, h: 2 },
    component: StatusSummaryWidget,
  },
  // ── ClickHouse-powered widgets (P3 — Phase 3) ────────────────────────────
  {
    type: 'CH_COMPLETION_TREND',
    label: 'Completion Trend',
    description: 'Daily count of completed Jira issues (from ClickHouse)',
    category: 'flow',
    subject: 'issues',
    sources: ['jira'],
    chartKind: 'line',
    timeAware: true,
    defaultSize: { w: 6, h: 4 },
    configFields: [
      {
        key: 'days',
        label: 'Range (days)',
        type: 'select',
        default: 30,
        options: [
          { label: '14 days', value: 14 },
          { label: '30 days', value: 30 },
          { label: '60 days', value: 60 },
          { label: '90 days', value: 90 },
        ],
      },
    ],
    component: ChCompletionTrendWidget,
  },
  {
    type: 'CH_VELOCITY',
    label: 'PR Velocity',
    description: 'Weekly count of merged GitHub PRs (from ClickHouse)',
    category: 'speed',
    subject: 'pull_requests',
    sources: ['github'],
    chartKind: 'bar',
    timeAware: true,
    defaultSize: { w: 6, h: 4 },
    configFields: [
      {
        key: 'weeks',
        label: 'Range (weeks)',
        type: 'select',
        default: 12,
        options: [
          { label: '4 weeks', value: 4 },
          { label: '8 weeks', value: 8 },
          { label: '12 weeks', value: 12 },
          { label: '26 weeks', value: 26 },
        ],
      },
    ],
    component: ChVelocityWidget,
  },
  {
    type: 'CH_CYCLE_TIME_TREND',
    label: 'PR Cycle Time Trend',
    description: 'Weekly p50 cycle time (hours) for merged PRs (from ClickHouse)',
    category: 'speed',
    subject: 'pull_requests',
    sources: ['github'],
    chartKind: 'line',
    timeAware: true,
    defaultSize: { w: 6, h: 4 },
    configFields: [
      {
        key: 'weeks',
        label: 'Range (weeks)',
        type: 'select',
        default: 12,
        options: [
          { label: '4 weeks', value: 4 },
          { label: '8 weeks', value: 8 },
          { label: '12 weeks', value: 12 },
          { label: '26 weeks', value: 26 },
        ],
      },
    ],
    component: ChCycleTimeTrendWidget,
  },
  {
    type: 'CH_BACKLOG_AGE',
    label: 'Backlog Age',
    description: 'Distribution of open Jira issues by age bucket (from ClickHouse)',
    category: 'board-health',
    subject: 'issues',
    sources: ['jira'],
    chartKind: 'bar',
    defaultSize: { w: 4, h: 3 },
    component: ChBacklogAgeWidget,
  },
  // ── New v1 widgets ───────────────────────────────────────────
  {
    type: 'LEAD_TIME_FOR_CHANGES',
    label: 'Lead Time for Changes',
    description: 'Weekly p50 hours: first commit → PR merged. DX Core 4 Speed metric.',
    timeAware: true,
    category: 'speed', subject: 'pull_requests',
    sources: ['github', 'gitlab', 'ado'],
    requiredScopeAny: ['githubRepoFullNames', 'gitlabProjectPaths', 'adoProjects'],
    chartKind: 'line', benchmarks: BENCHMARKS_V1.LEAD_TIME_FOR_CHANGES,
    defaultSize: { w: 6, h: 4 },
    configFields: [{ key: 'weeks', label: 'Range (weeks)', type: 'select', default: 12,
      options: [{ label: '8 weeks', value: 8 }, { label: '12 weeks', value: 12 }, { label: '26 weeks', value: 26 }] }],
    component: LeadTimeForChangesWidget,
  },
  {
    type: 'PR_CYCLE_TIME_SCATTER',
    label: 'PR Cycle Time Scatter',
    description: 'One dot per merged PR, coloured by tier. Click → open PR.',
    timeAware: true,
    category: 'speed', subject: 'pull_requests',
    sources: ['github', 'gitlab', 'ado'],
    requiredScopeAny: ['githubRepoFullNames', 'gitlabProjectPaths', 'adoProjects'],
    chartKind: 'scatter', benchmarks: BENCHMARKS_V1.LEAD_TIME_FOR_CHANGES,
    drillDimensions: { author: 'author', repo: 'repo' },
    defaultSize: { w: 8, h: 4 },
    configFields: [{ key: 'weeks', label: 'Range (weeks)', type: 'select', default: 8,
      options: [{ label: '4 weeks', value: 4 }, { label: '8 weeks', value: 8 }, { label: '12 weeks', value: 12 }] }],
    component: PrCycleTimeScatterWidget,
  },
  {
    type: 'REVIEW_PICKUP_TIME', label: 'Review Pickup Time',
    description: 'Avg hours from PR opened → first review.',
    timeAware: true,
    category: 'speed', subject: 'pull_requests',
    sources: ['github', 'gitlab', 'ado'],
    requiredScopeAny: ['githubRepoFullNames', 'gitlabProjectPaths', 'adoProjects'],
    chartKind: 'line', benchmarks: BENCHMARKS_V1.REVIEW_PICKUP_TIME,
    defaultSize: { w: 4, h: 4 },
    configFields: [{ key: 'weeks', label: 'Range (weeks)', type: 'select', default: 12,
      options: [{ label: '4 weeks', value: 4 }, { label: '12 weeks', value: 12 }] }],
    component: ReviewPickupTimeWidget,
  },
  {
    type: 'PR_SIZE_DISTRIBUTION', label: 'PR Size Distribution',
    description: 'Histogram of merged PR sizes (XS/S/M/L/XL by lines changed).',
    timeAware: true,
    category: 'speed', subject: 'pull_requests',
    sources: ['github', 'gitlab', 'ado'],
    requiredScopeAny: ['githubRepoFullNames', 'gitlabProjectPaths', 'adoProjects'],
    chartKind: 'histogram', benchmarks: BENCHMARKS_V1.PR_SIZE_DISTRIBUTION,
    defaultSize: { w: 4, h: 4 },
    configFields: [{ key: 'weeks', label: 'Range (weeks)', type: 'select', default: 12,
      options: [{ label: '4 weeks', value: 4 }, { label: '12 weeks', value: 12 }] }],
    component: PrSizeDistributionWidget,
  },
  {
    type: 'MERGE_FREQUENCY_PER_DEV', label: 'Merge Frequency per Developer',
    description: 'PRs merged per dev with 8-week sparkline trend. Row click → developer profile.',
    timeAware: true,
    category: 'speed', subject: 'pull_requests',
    sources: ['github', 'gitlab', 'ado'],
    requiredScopeAny: ['githubRepoFullNames', 'gitlabProjectPaths', 'adoProjects'],
    chartKind: 'table', benchmarks: BENCHMARKS_V1.MERGE_FREQUENCY_PER_DEV,
    drillDownHref: '/boards/{boardId}/insights/developers/{login}',
    drillDimensions: { author: 'author' },
    defaultSize: { w: 8, h: 5 },
    configFields: [{ key: 'weeks', label: 'Range (weeks)', type: 'select', default: 8,
      options: [{ label: '4 weeks', value: 4 }, { label: '8 weeks', value: 8 }] }],
    component: MergeFrequencyPerDevWidget,
  },
  {
    type: 'REWORK_RATE', label: 'Rework Rate',
    description: '% of non-merge commits modifying lines touched within 21 days.',
    timeAware: true,
    category: 'quality', subject: 'pull_requests',
    sources: ['github', 'gitlab', 'ado'],
    requiredScopeAny: ['githubRepoFullNames', 'gitlabProjectPaths', 'adoProjects'],
    chartKind: 'line', benchmarks: BENCHMARKS_V1.REWORK_RATE,
    defaultSize: { w: 4, h: 4 },
    configFields: [{ key: 'weeks', label: 'Range (weeks)', type: 'select', default: 12,
      options: [{ label: '4 weeks', value: 4 }, { label: '12 weeks', value: 12 }] }],
    component: ReworkRateWidget,
  },
  {
    type: 'BUG_RATE', label: 'Bug Rate',
    description: 'Weekly bugs opened vs other issue types.',
    timeAware: true,
    category: 'quality', subject: 'issues',
    sources: ['jira', 'ado', 'github'],
    requiredScopeAny: ['jiraProjectKeys', 'adoProjects', 'githubRepoFullNames'],
    chartKind: 'bar',
    defaultSize: { w: 4, h: 4 },
    configFields: [{ key: 'weeks', label: 'Range (weeks)', type: 'select', default: 12,
      options: [{ label: '4 weeks', value: 4 }, { label: '12 weeks', value: 12 }] }],
    component: BugRateWidget,
  },
  {
    type: 'ITERATION_PLANNING_ACCURACY', label: 'Iteration Planning Accuracy',
    description: '% of issues planned at iteration start that finished in scope.',
    category: 'planning', subject: 'issues',
    sources: ['jira', 'ado'],
    requiredScopeAny: ['jiraProjectKeys', 'adoProjects'],
    chartKind: 'bar',
    defaultSize: { w: 6, h: 4 },
    configFields: [{ key: 'sprints', label: 'Iterations', type: 'select', default: 8,
      options: [{ label: '4', value: 4 }, { label: '8', value: 8 }, { label: '12', value: 12 }] }],
    component: IterationPlanningAccuracyWidget,
  },
  {
    type: 'VELOCITY_WITH_CONFIDENCE', label: 'Velocity with Confidence Band',
    description: 'Sprint velocity + ±1σ confidence band.',
    category: 'planning', subject: 'issues',
    sources: ['jira', 'ado', 'github'],
    requiredScopeAny: ['jiraProjectKeys', 'adoProjects', 'githubRepoFullNames'],
    chartKind: 'line',
    defaultSize: { w: 6, h: 4 },
    configFields: [{ key: 'sprints', label: 'Sprints', type: 'select', default: 8,
      options: [{ label: '4', value: 4 }, { label: '8', value: 8 }, { label: '12', value: 12 }] }],
    component: VelocityWithConfidenceWidget,
  },
  {
    type: 'INITIATIVE_RISK_RADAR', label: 'Initiative Risk Radar',
    description: 'Epics / features / milestones with due dates, badged on-track / at-risk / overdue.',
    category: 'planning', subject: 'issues',
    sources: ['jira', 'ado', 'github'],
    requiredScopeAny: ['jiraProjectKeys', 'adoProjects', 'githubRepoFullNames'],
    chartKind: 'list',
    defaultSize: { w: 4, h: 5 },
    configFields: [{ key: 'horizon_days', label: 'Horizon (days)', type: 'number', default: 90 }],
    component: InitiativeRiskRadarWidget,
  },
  {
    type: 'ISSUES_OPENED_VS_CLOSED', label: 'Issues Opened vs Closed',
    description: 'Weekly opened vs closed issue counts.',
    timeAware: true,
    category: 'flow', subject: 'issues',
    sources: ['jira', 'ado', 'github'],
    requiredScopeAny: ['jiraProjectKeys', 'adoProjects', 'githubRepoFullNames'],
    chartKind: 'bar',
    defaultSize: { w: 6, h: 4 },
    configFields: [{ key: 'weeks', label: 'Range (weeks)', type: 'select', default: 12,
      options: [{ label: '4 weeks', value: 4 }, { label: '12 weeks', value: 12 }] }],
    component: IssuesOpenedVsClosedWidget,
  },
  {
    type: 'WIP_COUNT', label: 'Work in Progress',
    description: 'Current count of in-progress issues with 8-week sparkline.',
    timeAware: true,
    category: 'flow', subject: 'issues',
    sources: ['jira', 'ado', 'github'],
    requiredScopeAny: ['jiraProjectKeys', 'adoProjects', 'githubRepoFullNames'],
    chartKind: 'kpi',
    defaultSize: { w: 4, h: 2 },
    component: WipCountWidget,
  },
  {
    type: 'TICKET_COVERAGE_RATE', label: 'Ticket Coverage Rate',
    description: '% of merged PRs that link to ≥1 ticket.',
    timeAware: true,
    category: 'correlation', subject: 'pull_requests',
    sources: ['github', 'gitlab', 'ado'],
    requiredScopeAny: ['githubRepoFullNames', 'gitlabProjectPaths', 'adoProjects'],
    chartKind: 'kpi', benchmarks: BENCHMARKS_V1.TICKET_COVERAGE_RATE,
    defaultSize: { w: 4, h: 2 },
    component: TicketCoverageRateWidget,
  },
  {
    type: 'AI_ASSISTED_PR_PCT', label: 'AI-Assisted PR %',
    description: '% of merged PRs flagged as AI-assisted.',
    timeAware: true,
    category: 'ai', subject: 'pull_requests',
    sources: ['github', 'gitlab', 'ado'],
    requiredScopeAny: ['githubRepoFullNames', 'gitlabProjectPaths', 'adoProjects'],
    chartKind: 'kpi',
    defaultSize: { w: 4, h: 2 },
    component: AiAssistedPrPctWidget,
  },
  {
    type: 'REVIEW_MIX', label: 'Review Mix (Bot vs Human)',
    description: 'Bot share of first non-comment reviews, median pickup time per type, weekly trend.',
    timeAware: true,
    category: 'ai', subject: 'pull_requests',
    sources: ['github'],
    requiredScopeAny: ['githubRepoFullNames'],
    chartKind: 'line',
    defaultSize: { w: 6, h: 4 },
    configFields: [
      {
        key: 'weeks',
        label: 'Range (weeks)',
        type: 'select',
        default: 12,
        options: [
          { label: '4 weeks', value: 4 },
          { label: '12 weeks', value: 12 },
          { label: '26 weeks', value: 26 },
        ],
      },
    ],
    component: ReviewMixWidget,
  },
  {
    type: 'BOT_VS_HUMAN', label: 'Bot vs Human (Authorship)',
    description: 'Share of commits authored with AI assistance (Claude Code & others) vs human, with weekly trend.',
    timeAware: true,
    category: 'ai', subject: 'commits',
    sources: ['github', 'gitlab', 'ado'],
    requiredScopeAny: ['githubRepoFullNames', 'gitlabProjectPaths', 'adoProjects'],
    chartKind: 'line',
    defaultSize: { w: 6, h: 4 },
    configFields: [
      {
        key: 'weeks',
        label: 'Range (weeks)',
        type: 'select',
        default: 12,
        options: [
          { label: '4 weeks', value: 4 },
          { label: '12 weeks', value: 12 },
          { label: '26 weeks', value: 26 },
        ],
      },
    ],
    component: BotVsHumanWidget,
  },
  {
    type: 'COMMITS_PER_DEV', label: 'Commits per Developer',
    description: 'Commits per developer across GitHub, GitLab & ADO with lines changed, AI-assist %, and a weekly trend.',
    timeAware: true,
    category: 'speed', subject: 'commits',
    sources: ['github', 'gitlab', 'ado'],
    requiredScopeAny: ['githubRepoFullNames', 'gitlabProjectPaths', 'adoProjects'],
    chartKind: 'table',
    defaultSize: { w: 8, h: 5 },
    configFields: [{ key: 'weeks', label: 'Range (weeks)', type: 'select', default: 12,
      options: [{ label: '4 weeks', value: 4 }, { label: '12 weeks', value: 12 }, { label: '26 weeks', value: 26 }] }],
    component: CommitsPerDevWidget,
  },
  {
    type: 'REVIEWER_PARTICIPATION', label: 'Reviewer Participation',
    description: 'Per-reviewer review load and approvals across GitHub and Azure DevOps.',
    timeAware: true,
    category: 'flow', subject: 'pull_requests',
    sources: ['github', 'ado'],
    requiredScopeAny: ['githubRepoFullNames', 'adoProjects'],
    chartKind: 'table',
    defaultSize: { w: 8, h: 5 },
    configFields: [{ key: 'weeks', label: 'Range (weeks)', type: 'select', default: 12,
      options: [{ label: '4 weeks', value: 4 }, { label: '8 weeks', value: 8 }, { label: '12 weeks', value: 12 }] }],
    component: ReviewerParticipationWidget,
  },
  {
    type: 'REVIEW_QUALITY_INDEX', label: 'Review Quality Index',
    description: 'Coverage, dwell, instant-merge, comment and ticket rates in one review-quality scorecard.',
    category: 'quality', subject: 'pull_requests',
    sources: ['github', 'ado'],
    requiredScopeAny: ['githubRepoFullNames', 'adoProjects'],
    chartKind: 'table', timeAware: true,
    defaultSize: { w: 6, h: 5 },
    configFields: [{ key: 'weeks', label: 'Range (weeks)', type: 'select', default: 12,
      options: [{ label: '4 weeks', value: 4 }, { label: '8 weeks', value: 8 }, { label: '12 weeks', value: 12 }] }],
    component: ReviewQualityIndexWidget,
  },
  {
    type: 'REVIEW_QUALITY_TREND', label: 'Review Quality Trend',
    description: 'Peer-approval coverage and comment-rate lines over time, plus the review-quality scorecard.',
    timeAware: true,
    category: 'quality', subject: 'pull_requests',
    sources: ['github', 'ado'],
    requiredScopeAny: ['githubRepoFullNames', 'adoProjects'],
    chartKind: 'line',
    defaultSize: { w: 12, h: 8 },
    configFields: [
      { key: 'weeks', label: 'Range (weeks)', type: 'select', default: 12,
        options: [{ label: '4 weeks', value: 4 }, { label: '8 weeks', value: 8 }, { label: '12 weeks', value: 12 }, { label: '26 weeks', value: 26 }] },
      { key: 'bucket', label: 'Bucket', type: 'select', default: 'week',
        options: [{ label: 'Week', value: 'week' }, { label: 'Month', value: 'month' }] },
    ],
    component: ReviewQualityTrendWidget,
  },
  {
    type: 'AI_ADOPTION', label: 'AI Adoption',
    description: 'Monthly AI-assisted PR% and commit% over time. Detection is trailer-based; absence ≠ zero use.',
    timeAware: true,
    category: 'ai', subject: 'pull_requests',
    sources: ['github', 'ado'],
    requiredScopeAny: ['githubRepoFullNames', 'adoProjects'],
    chartKind: 'table',
    defaultSize: { w: 8, h: 5 },
    configFields: [
      { key: 'weeks', label: 'Range (weeks)', type: 'select', default: 12,
        options: [{ label: '4 weeks', value: 4 }, { label: '12 weeks', value: 12 }, { label: '26 weeks', value: 26 }] },
      { key: 'bucket', label: 'Bucket', type: 'select', default: 'month',
        options: [{ label: 'Week', value: 'week' }, { label: 'Month', value: 'month' }] },
    ],
    component: AiAdoptionWidget,
  },
  {
    type: 'FLOW_THROUGHPUT_CYCLE', label: 'Flow: Throughput & Cycle Time',
    description: 'Items delivered per period (bars) with age-filtered median cycle time (line).',
    timeAware: true,
    category: 'flow', subject: 'issues',
    sources: ['jira', 'ado'],
    requiredScopeAny: ['jiraProjectKeys', 'adoProjects'],
    chartKind: 'bar',
    defaultSize: { w: 12, h: 6 },
    configFields: [
      { key: 'weeks', label: 'Range (weeks)', type: 'select', default: 12,
        options: [{ label: '8 weeks', value: 8 }, { label: '12 weeks', value: 12 }, { label: '26 weeks', value: 26 }] },
      { key: 'maxAgeDays', label: 'Max age (days)', type: 'number', default: 90 },
    ],
    component: FlowThroughputCycleWidget,
  },
  {
    type: 'DELIVERY_TREND_ANNOTATED', label: 'Delivery Trend (Annotated)',
    description: 'Items delivered per period with shaded calendar bands and an auto-highlighted peak.',
    timeAware: true,
    category: 'flow', subject: 'issues',
    sources: ['jira', 'ado'],
    requiredScopeAny: ['jiraProjectKeys', 'adoProjects'],
    chartKind: 'line',
    defaultSize: { w: 12, h: 6 },
    configFields: [{ key: 'weeks', label: 'Range (weeks)', type: 'select', default: 12,
      options: [{ label: '8 weeks', value: 8 }, { label: '12 weeks', value: 12 }, { label: '26 weeks', value: 26 }] }],
    component: DeliveryTrendAnnotatedWidget,
  },
  {
    type: 'INVESTMENT_ALLOCATION', label: 'Investment Allocation',
    description: 'Where delivered effort went: feature vs bug vs tech-debt vs KTLO, by issues closed in the window.',
    timeAware: true,
    category: 'planning', subject: 'issues',
    sources: ['jira', 'ado', 'github'],
    requiredScopeAny: ['jiraProjectKeys', 'adoProjects', 'githubRepoFullNames'],
    chartKind: 'donut',
    defaultSize: { w: 6, h: 4 },
    configFields: [{ key: 'days', label: 'Range (days)', type: 'select', default: 90,
      options: [{ label: '30 days', value: 30 }, { label: '90 days', value: 90 }, { label: '180 days', value: 180 }] }],
    component: InvestmentAllocationWidget,
  },
  {
    type: 'DORA_METRICS', label: 'DORA Metrics',
    description: 'The four DORA metrics (lead time, deploy frequency, change failure rate, time to restore) with Elite/High/Medium/Low tiers. DF/CFR/MTTR are proxies — no deployment/incident source yet.',
    timeAware: true,
    category: 'flow', subject: 'pull_requests',
    sources: ['github', 'gitlab', 'ado', 'jira'],
    requiredScopeAny: ['githubRepoFullNames', 'gitlabProjectPaths', 'adoProjects', 'jiraProjectKeys'],
    chartKind: 'table',
    defaultSize: { w: 6, h: 4 },
    configFields: [{ key: 'weeks', label: 'Range (weeks)', type: 'select', default: 12,
      options: [{ label: '4 weeks', value: 4 }, { label: '12 weeks', value: 12 }, { label: '26 weeks', value: 26 }] }],
    component: DoraMetricsWidget,
  },
  {
    type: 'PERIOD_COMPARISON', label: 'Period-over-Period',
    description:
      'Compares the team against its own past — KPI deltas between two windows (e.g. last two quarters), with direction-aware improved/regressed verdicts.',
    timeAware: false,
    category: 'flow', subject: 'pull_requests',
    sources: ['github', 'gitlab', 'ado', 'jira'],
    requiredScopeAny: ['githubRepoFullNames', 'gitlabProjectPaths', 'adoProjects', 'jiraProjectKeys'],
    chartKind: 'table',
    defaultSize: { w: 12, h: 6 },
    configFields: [],
    component: PeriodComparisonWidget,
  },
  // ── P6 — multi-board comparison widgets (standalone Comparison only) ────────
  {
    type: 'COMPARE_REVIEW_QUALITY', label: 'Compare: Review Quality',
    description: 'Coverage line per board plus a board-as-columns review-quality scorecard with best-board hints; non-comparable metrics are greyed.',
    timeAware: true,
    category: 'comparison', subject: 'pull_requests',
    sources: ['github', 'ado'],
    requiresComparisonView: true,
    chartKind: 'line',
    defaultSize: { w: 12, h: 8 },
    configFields: [{ key: 'weeks', label: 'Range (weeks)', type: 'select', default: 12,
      options: [{ label: '4 weeks', value: 4 }, { label: '8 weeks', value: 8 }, { label: '12 weeks', value: 12 }, { label: '26 weeks', value: 26 }] }],
    component: CompareReviewQualityWidget,
  },
  {
    type: 'COMPARE_FLOW', label: 'Compare: Flow',
    description: 'Cycle-time line per board plus a board-columns throughput/cycle scorecard; raw counts across mixed tools are greyed.',
    timeAware: true,
    category: 'comparison', subject: 'issues',
    sources: ['jira', 'ado'],
    requiresComparisonView: true,
    chartKind: 'line',
    defaultSize: { w: 12, h: 6 },
    configFields: [{ key: 'weeks', label: 'Range (weeks)', type: 'select', default: 12,
      options: [{ label: '8 weeks', value: 8 }, { label: '12 weeks', value: 12 }, { label: '26 weeks', value: 26 }] }],
    component: CompareFlowWidget,
  },
  {
    type: 'COMPARE_DELIVERY', label: 'Compare: Delivery',
    description: 'Multi-series delivery trend (one line per board) with a shared freeze/calendar overlay; non-comparable totals are greyed.',
    timeAware: true,
    category: 'comparison', subject: 'issues',
    sources: ['jira', 'ado'],
    requiresComparisonView: true,
    chartKind: 'line',
    defaultSize: { w: 12, h: 6 },
    configFields: [{ key: 'weeks', label: 'Range (weeks)', type: 'select', default: 12,
      options: [{ label: '8 weeks', value: 8 }, { label: '12 weeks', value: 12 }, { label: '26 weeks', value: 26 }] }],
    component: CompareDeliveryWidget,
  },
];

export const widgetRegistry: Record<string, WidgetDefinition> = Object.fromEntries(
  WIDGET_CATALOG.map((w) => [w.type, w])
);

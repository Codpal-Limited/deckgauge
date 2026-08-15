export const NEW_WIDGET_TYPES = [
  'LEAD_TIME_FOR_CHANGES',
  'PR_CYCLE_TIME_SCATTER',
  'REVIEW_PICKUP_TIME',
  'PR_SIZE_DISTRIBUTION',
  'MERGE_FREQUENCY_PER_DEV',
  'REWORK_RATE',
  'BUG_RATE',
  'ITERATION_PLANNING_ACCURACY',
  'VELOCITY_WITH_CONFIDENCE',
  'INITIATIVE_RISK_RADAR',
  'ISSUES_OPENED_VS_CLOSED',
  'WIP_COUNT',
  'TICKET_COVERAGE_RATE',
  'AI_ASSISTED_PR_PCT',
  'REVIEW_MIX',
  'BOT_VS_HUMAN',
  'COMMITS_PER_DEV',
  'REVIEWER_PARTICIPATION',
  'REVIEW_QUALITY_INDEX',
  'REVIEW_QUALITY_TREND',
  'FLOW_THROUGHPUT_CYCLE',
  'DELIVERY_TREND_ANNOTATED',
  'AI_ADOPTION',
  'INVESTMENT_ALLOCATION',
  'DORA_METRICS',
  'PERIOD_COMPARISON',
] as const;
export type NewWidgetType = (typeof NEW_WIDGET_TYPES)[number];

// P6 — multi-board comparison widgets. Kept SEPARATE from NEW_WIDGET_TYPES on
// purpose: comparison widgets live only on a standalone Comparison, are never
// part of the single-board engineering-intelligence preset, and are never
// persisted as board-scoped DashboardWidgets. Each one fans an existing
// single-board builder out across the comparison's board set — it introduces
// no new metric SQL. The api recognises them via KNOWN_WIDGET_TYPES +
// WIDGET_METHOD_MAP; they are deliberately absent from ALL_WIDGET_TYPES,
// WIDGET_SCOPE_REQUIREMENTS, and the preset coverage guard.
export const COMPARISON_WIDGET_TYPES = [
  'COMPARE_REVIEW_QUALITY',
  'COMPARE_FLOW',
  'COMPARE_DELIVERY',
] as const;
export type ComparisonWidgetType = (typeof COMPARISON_WIDGET_TYPES)[number];

export const WIDGET_SUBJECTS = ['issues', 'pull_requests', 'commits', 'board_state'] as const;
export type WidgetSubject = (typeof WIDGET_SUBJECTS)[number];

export const WIDGET_CATEGORIES = [
  'board-health',
  'flow',
  'speed',
  'quality',
  'planning',
  'correlation',
  'ai',
  // P6 — multi-board comparison widgets render only on a standalone Comparison.
  'comparison',
] as const;
export type WidgetCategory = (typeof WIDGET_CATEGORIES)[number];

// Source kinds a widget can require. Mirrors the four Board*Source tables.
export const WIDGET_SOURCE_KINDS = ['jira', 'github', 'gitlab', 'ado'] as const;
export type WidgetSourceKind = (typeof WIDGET_SOURCE_KINDS)[number];

// Per-widget source requirements. A widget is supported when the board has
// AT LEAST ONE of the listed source kinds attached. Kept in shared so the
// picker (web) and preset seeder (api) gate on the same rule.
export const WIDGET_SCOPE_REQUIREMENTS: Record<NewWidgetType, WidgetSourceKind[]> = {
  LEAD_TIME_FOR_CHANGES: ['github', 'gitlab', 'ado'],
  PR_CYCLE_TIME_SCATTER: ['github', 'gitlab', 'ado'],
  REVIEW_PICKUP_TIME: ['github', 'gitlab', 'ado'],
  PR_SIZE_DISTRIBUTION: ['github', 'gitlab', 'ado'],
  MERGE_FREQUENCY_PER_DEV: ['github', 'gitlab', 'ado'],
  REWORK_RATE: ['github', 'gitlab', 'ado'],
  BUG_RATE: ['jira', 'ado', 'github', 'gitlab'],
  ITERATION_PLANNING_ACCURACY: ['jira', 'ado'],
  VELOCITY_WITH_CONFIDENCE: ['jira', 'ado', 'gitlab'],
  INITIATIVE_RISK_RADAR: ['jira', 'ado', 'github'],
  ISSUES_OPENED_VS_CLOSED: ['jira', 'ado', 'github', 'gitlab'],
  WIP_COUNT: ['jira', 'ado', 'github', 'gitlab'],
  TICKET_COVERAGE_RATE: ['github', 'gitlab', 'ado'],
  AI_ASSISTED_PR_PCT: ['github', 'gitlab', 'ado'],
  // github_reviews is github-only; gitlab/ado have no parallel review table.
  REVIEW_MIX: ['github'],
  // Commit-authorship split; commits exist for all three code providers.
  BOT_VS_HUMAN: ['github', 'gitlab', 'ado'],
  // Commits per developer; commits exist for all three code providers.
  COMMITS_PER_DEV: ['github', 'gitlab', 'ado'],
  // github_reviews + ado_reviews + gitlab_reviews.
  REVIEWER_PARTICIPATION: ['github', 'ado', 'gitlab'],
  // github_reviews + ado_reviews + gitlab_reviews.
  REVIEW_QUALITY_INDEX: ['github', 'ado', 'gitlab'],
  // github_reviews + ado_reviews + gitlab_reviews (mirrors REVIEW_QUALITY_INDEX).
  REVIEW_QUALITY_TREND: ['github', 'ado', 'gitlab'],
  FLOW_THROUGHPUT_CYCLE: ['jira', 'ado'],
  DELIVERY_TREND_ANNOTATED: ['jira', 'ado'],
  AI_ADOPTION: ['github', 'ado'],
  // Investment-allocation reads canonical issue `type` across all issue
  // sources (Jira issue_type, ADO work_item_type, GitHub/GitLab label-derived type).
  INVESTMENT_ALLOCATION: ['jira', 'ado', 'github', 'gitlab'],
  // DORA scorecard spans PRs/commits (speed + change-failure) and bug issues
  // (time-to-restore), so any code or issue source makes it partially usable;
  // metrics without a matching source render as "—".
  DORA_METRICS: ['github', 'gitlab', 'ado', 'jira'],
  // Period comparison spans the DORA proxy set (PR/commit speed + change-failure)
  // plus issue throughput/time-to-restore — any code or issue source makes it
  // partially usable; unsupported metrics render "—" in both periods.
  PERIOD_COMPARISON: ['github', 'gitlab', 'ado', 'jira'],
};

export interface WidgetScopeFlags {
  hasJira: boolean;
  hasGitHub: boolean;
  hasGitLab: boolean;
  hasAdo: boolean;
}

const SCOPE_FLAG_BY_KIND: Record<WidgetSourceKind, keyof WidgetScopeFlags> = {
  jira: 'hasJira',
  github: 'hasGitHub',
  gitlab: 'hasGitLab',
  ado: 'hasAdo',
};

export function widgetIsSupportedByScope(
  widgetType: NewWidgetType,
  scope: WidgetScopeFlags
): boolean {
  const required = WIDGET_SCOPE_REQUIREMENTS[widgetType];
  return required.some((kind) => scope[SCOPE_FLAG_BY_KIND[kind]]);
}

export const CHART_KINDS = [
  'kpi',
  'line',
  'bar',
  'scatter',
  'histogram',
  'donut',
  'list',
  'table',
  'heatmap',
] as const;
export type ChartKind = (typeof CHART_KINDS)[number];

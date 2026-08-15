// Maps a widget `type` to its published documentation slug on deckgauge.com.
// Only types with a live /docs/widgets/<slug> page appear here; the in-app
// "Read the full guide" link renders only when a mapping exists.
export const WIDGET_DOC_SLUGS: Record<string, string> = {
  DORA_METRICS: 'dora-metrics',
  LEAD_TIME_FOR_CHANGES: 'lead-time-for-changes',
  PR_CYCLE_TIME_SCATTER: 'pr-cycle-time-scatter',
  REVIEW_PICKUP_TIME: 'review-pickup-time',
  REWORK_RATE: 'rework-rate',
  BUG_RATE: 'bug-rate',
  TICKET_COVERAGE_RATE: 'ticket-coverage-rate',
  INVESTMENT_ALLOCATION: 'investment-allocation',
  VELOCITY_WITH_CONFIDENCE: 'velocity-confidence',
  PR_SIZE_DISTRIBUTION: 'pr-size-distribution',
  WIP_COUNT: 'work-in-progress',
  VELOCITY_LEADERBOARD: 'velocity-leaderboard',
  CH_VELOCITY: 'pr-velocity',
  CH_CYCLE_TIME_TREND: 'pr-cycle-time-trend',
  MERGE_FREQUENCY_PER_DEV: 'merge-frequency-per-developer',
  COMMITS_PER_DEV: 'commits-per-developer',
  REVIEWER_PARTICIPATION: 'reviewer-participation',
  COMPLETION_RATE: 'completion-rate',
  CH_COMPLETION_TREND: 'completion-trend',
  ISSUES_OPENED_VS_CLOSED: 'issues-opened-vs-closed',
  FLOW_THROUGHPUT_CYCLE: 'flow-throughput-cycle-time',
  DELIVERY_TREND_ANNOTATED: 'delivery-trend',
  CH_BACKLOG_AGE: 'backlog-age',
  AI_ASSISTED_PR_PCT: 'ai-assisted-pr-percentage',
  REVIEW_MIX: 'review-mix',
  BOT_VS_HUMAN: 'bot-vs-human-commits',
  AI_ADOPTION: 'ai-adoption',
  REVIEW_QUALITY_INDEX: 'review-quality-index',
  REVIEW_QUALITY_TREND: 'review-quality-trend',
  ITERATION_PLANNING_ACCURACY: 'iteration-planning-accuracy',
  INITIATIVE_RISK_RADAR: 'initiative-risk-radar',
  PERIOD_COMPARISON: 'period-comparison',
  COMPARE_REVIEW_QUALITY: 'compare-review-quality',
  COMPARE_FLOW: 'compare-flow',
  COMPARE_DELIVERY: 'compare-delivery',
};

const DOCS_BASE = 'https://deckgauge.com/docs/widgets';

export function docUrlFor(type: string): string | null {
  const slug = WIDGET_DOC_SLUGS[type];
  return slug ? `${DOCS_BASE}/${slug}` : null;
}

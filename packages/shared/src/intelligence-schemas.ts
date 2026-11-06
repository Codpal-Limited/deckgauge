// EI-002 — Zod schemas for the intelligence DTOs.
import { z } from 'zod';

export const TeamOverviewSchema = z.object({
  prs_merged: z.number(),
  median_cycle_h: z.number().nullable(),
  active_devs: z.number(),
  ai_pct: z.number(),
});
export type TeamOverview = z.infer<typeof TeamOverviewSchema>;

export const DeveloperWeeklyPointSchema = z.object({
  week_start: z.string(),
  prs_merged: z.number(),
  prs_opened: z.number(),
  median_cycle_h: z.number().nullable(),
  additions: z.number(),
  ai_prs: z.number(),
});
export type DeveloperWeeklyPoint = z.infer<typeof DeveloperWeeklyPointSchema>;

export const DeveloperAnomalySchema = z.object({
  developer_login: z.string(),
  baseline: z.number(),
  recent: z.number(),
  delta_pct: z.number(),
});
export type DeveloperAnomaly = z.infer<typeof DeveloperAnomalySchema>;

export const AiBreakdownRowSchema = z.object({
  author_login: z.string(),
  ai_prs: z.number(),
  total_prs: z.number(),
  ai_pct: z.number(),
});
export type AiBreakdownRow = z.infer<typeof AiBreakdownRowSchema>;

export const TicketCoverageSchema = z.object({ coverage_rate: z.number() });
export type TicketCoverage = z.infer<typeof TicketCoverageSchema>;

export const TicketTimelineEventSchema = z.object({
  source: z.string(),
  ts: z.string(),
  title: z.string(),
  actor: z.string().nullable(),
  ref: z.string(),
});
export type TicketTimelineEvent = z.infer<typeof TicketTimelineEventSchema>;

export const SyncTriggerSourceSchema = z.enum(['jira', 'github', 'ado', 'gitlab', 'bitbucket', 'all']);
export type SyncTriggerSource = z.infer<typeof SyncTriggerSourceSchema>;

// P2 — developer table row (one row per engineer, last N weeks).
// P8.6 — userId + displayName joined from DeveloperProfile (Postgres).
export const DeveloperTableRowSchema = z.object({
  login: z.string(),
  prs_merged: z.number(),
  median_cycle_h: z.number().nullable(),
  ai_pct: z.number(),
  anomaly: z.boolean(),
  sparkline: z.array(z.number()),
  userId: z.string().uuid().nullable(),
  displayName: z.string().nullable(),
});
export type DeveloperTableRow = z.infer<typeof DeveloperTableRowSchema>;

export const DeveloperTableSchema = z.array(DeveloperTableRowSchema);
export type DeveloperTable = z.infer<typeof DeveloperTableSchema>;

// P2 — developer detail (90-day heatmap, recent PRs, AI weekly trend).
export const DeveloperHeatmapCellSchema = z.object({
  date: z.string(),
  count: z.number(),
});
export type DeveloperHeatmapCell = z.infer<typeof DeveloperHeatmapCellSchema>;

export const DeveloperRecentPrSchema = z.object({
  repo: z.string(),
  number: z.number(),
  title: z.string(),
  merged_at: z.string().nullable(),
  cycle_h: z.number().nullable(),
  ai_assisted: z.boolean(),
});
export type DeveloperRecentPr = z.infer<typeof DeveloperRecentPrSchema>;

export const DeveloperAiTrendPointSchema = z.object({
  week_start: z.string(),
  ai_pct: z.number(),
});
export type DeveloperAiTrendPoint = z.infer<typeof DeveloperAiTrendPointSchema>;

export const DeveloperDetailSchema = z.object({
  login: z.string(),
  heatmap: z.array(DeveloperHeatmapCellSchema),
  recent_prs: z.array(DeveloperRecentPrSchema),
  ai_trend: z.array(DeveloperAiTrendPointSchema),
});
export type DeveloperDetail = z.infer<typeof DeveloperDetailSchema>;

// P2 — paginated pull-request listing.
export const PullRequestRowSchema = z.object({
  provider: z.string(),
  repo: z.string(),
  number: z.number(),
  title: z.string(),
  author_login: z.string().nullable(),
  state: z.string(),
  created_at: z.string(),
  merged_at: z.string().nullable(),
  cycle_hours: z.number().nullable(),
  ai_assisted: z.boolean(),
});
export type PullRequestRow = z.infer<typeof PullRequestRowSchema>;

export const PullRequestListSchema = z.object({
  items: z.array(PullRequestRowSchema),
  total: z.number(),
  page: z.number(),
  perPage: z.number(),
});
export type PullRequestList = z.infer<typeof PullRequestListSchema>;

// P2 — weekly AI-assistance trend.
export const AiWeeklyTrendPointSchema = z.object({
  week_start: z.string(),
  ai_pct: z.number(),
  total_prs: z.number(),
});
export type AiWeeklyTrendPoint = z.infer<typeof AiWeeklyTrendPointSchema>;

export const AiWeeklyTrendSchema = z.array(AiWeeklyTrendPointSchema);
export type AiWeeklyTrend = z.infer<typeof AiWeeklyTrendSchema>;

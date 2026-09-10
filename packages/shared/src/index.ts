export {
  BoardSchema,
  CreateBoardInputSchema,
  UpdateBoardInputSchema,
  ProjectStatusEnum,
  ProjectSchema,
  CostClassificationEnum,
  GroupSchema,
  CreateGroupInputSchema,
  UpdateGroupInputSchema,
  ReorderGroupsInputSchema,
  type Board,
  type CreateBoardInput,
  type UpdateBoardInput,
  type ProjectStatus,
  type Project,
  type CostClassification,
  type Group,
  type CreateGroupInput,
  type UpdateGroupInput,
  type ReorderGroupsInput,
} from "./schemas.js";

export {
  BoardFolderSchema,
  UserBoardPrefSchema,
  BoardTreeResponseSchema,
  CreateBoardFolderInputSchema,
  UpdateBoardFolderInputSchema,
  UpdateBoardPrefInputSchema,
  UpdateRoadmapPrefInputSchema,
  DEFAULT_FOLDER_COLOR,
  type BoardFolderDTO,
  type UserBoardPrefDTO,
  type UserRoadmapPrefDTO,
  type BoardTreeResponse,
  type CreateBoardFolderInput,
  type UpdateBoardFolderInput,
  type UpdateBoardPrefInput,
  type UpdateRoadmapPrefInput,
  type BoardSummary,
  type BoardNodeData,
  type RoadmapNodeData,
  type FolderNodeData,
  type SidebarNode,
  type BoardTree,
} from "./board-tree-schemas.js";

export { buildBoardTree } from "./build-board-tree.js";

export {
  CreateRetiredJiraProjectInputSchema,
  UpdateRetiredJiraProjectInputSchema,
  RetiredJiraProjectDtoSchema,
} from './retired-projects-schemas.js';
export type {
  CreateRetiredJiraProjectInput,
  UpdateRetiredJiraProjectInput,
  RetiredJiraProjectDto,
} from './retired-projects-schemas.js';

export {
  WidgetDataBatchItemSchema,
  WidgetDataBatchRequestSchema,
} from './widget-data-batch-schemas.js';
export type {
  WidgetDataBatchItem,
  WidgetDataBatchRequest,
  WidgetDataBatchResultEntry,
  WidgetDataBatchResponse,
} from './widget-data-batch-schemas.js';

export {
  JiraEpicSchema,
  JiraIssueSchema,
  SyncRunSchema,
  SyncRunStatusEnum,
  SyncRunTriggerEnum,
  type JiraEpic,
  type JiraIssue,
  type SyncRun,
  type SyncRunStatus,
  type SyncRunTrigger,
} from "./jira-schemas.js";

export type { JiraPort, JiraIssueExistence, JiraCredentialState } from "./jira-port.js";

export { FakeJiraAdapter } from "./fake-jira-adapter.js";

export {
  JiraCloudAdapter,
  JiraAuthError,
} from "./jira-cloud-adapter.js";

export {
  stripJqlOrderBy,
  buildFilteredKeyJql,
  hasActiveJqlFilter,
  JQL_FILTER_MATCHES_NOTHING_KEY,
} from "./jira-jql.js";

export {
  JiraConfigSchema,
  type JiraConfig,
} from "./jira-config-schema.js";
export { formatAbsoluteShort, formatRelative } from "./format-date.js";

export {
  JiraInstanceSchema,
  JiraInstancePublicSchema,
  CreateJiraInstanceInputSchema,
  UpdateJiraInstanceInputSchema,
  ConnectionHintSchema,
  type JiraInstance,
  type JiraInstancePublic,
  type CreateJiraInstanceInput,
  type UpdateJiraInstanceInput,
  type ConnectionHint,
} from "./jira-instance-schemas.js";

export {
  ColumnTypeEnum,
  BoardColumnSchema,
  CreateColumnInputSchema,
  UpdateColumnInputSchema,
  FieldValueSchema,
  UpsertFieldValueInputSchema,
  UpsertFieldValuesInputSchema,
  BulkUpsertFieldValuesInputSchema,
  type ColumnType,
  type BoardColumn,
  type CreateColumnInput,
  type UpdateColumnInput,
  type FieldValue,
  type UpsertFieldValueInput,
  type BulkUpsertFieldValuesInput,
} from "./column-schemas.js";

export {
  MIN_COLUMN_WIDTH,
  MAX_COLUMN_WIDTH,
  BOARD_SYSTEM_COLUMN_KEYS,
  BOARD_COLUMN_META,
  DEFAULT_CUSTOM_COLUMN_WIDTH,
  ColumnLayoutSchema,
  clampColumnWidth,
  resolveColumnWidth,
  OPT_IN_SYSTEM_COLUMNS,
  isSystemColumnVisible,
  type BoardSystemColumnKey,
  type ColumnLayout,
} from "./column-layout-schemas.js";

export {
  AutomationTriggerTypeEnum,
  AutomationActionTypeEnum,
  AutomationTriggerSchema,
  AutomationActionSchema,
  AutomationRuleSchema,
  CreateAutomationRuleInputSchema,
  UpdateAutomationRuleInputSchema,
  type AutomationTriggerType,
  type AutomationActionType,
  type AutomationTrigger,
  type AutomationAction,
  type AutomationRule,
  type CreateAutomationRuleInput,
  type UpdateAutomationRuleInput,
} from "./automation-schemas.js";

export {
  CommentSchema,
  CreateCommentInputSchema,
  UpdateCommentInputSchema,
  type Comment,
  type CreateCommentInput,
  type UpdateCommentInput,
} from "./comment-schemas.js";

export {
  NotificationKindSchema,
  NotificationDtoSchema,
  NotificationListResponseSchema,
  UnreadCountResponseSchema,
  type NotificationKindValue,
  type NotificationDto,
  type NotificationListResponse,
  type UnreadCountResponse,
} from "./notification-schemas.js";

export {
  NotificationModeSchema,
  BoardNotificationLevelSchema,
  DEFAULT_NOTIFICATION_MODES,
  NotificationPreferenceSchema,
  NotificationPreferencesResponseSchema,
  UpdateNotificationPreferencesInputSchema,
  BoardNotificationSettingSchema,
  UpdateBoardNotificationSettingInputSchema,
  type NotificationMode,
  type BoardNotificationLevel,
  type NotificationPreference,
  type NotificationPreferencesResponse,
  type UpdateNotificationPreferencesInput,
  type BoardNotificationSetting,
  type UpdateBoardNotificationSettingInput,
} from "./notification-preference-schemas.js";

export {
  DEFAULT_DIGEST_WINDOW_MS,
  selectDigestReleases,
  type PendingNotificationRow,
  type DigestPayload,
  type DigestRelease,
} from "./notification-digest.js";

export {
  JiraSyncConfigSchema,
  CreateJiraSyncConfigInputSchema,
  UpdateJiraSyncConfigInputSchema,
  type JiraSyncConfig,
  type CreateJiraSyncConfigInput,
  type UpdateJiraSyncConfigInput,
  DEFAULT_STATUS_MAPPING,
  LEGACY_STATUS_LABELS,
  CURATED_JIRA_FIELDS,
} from "./jira-sync-config-schemas.js";

export {
  OWNER_COLORS,
  BoardOwnerSchema,
  CreateOwnerInputSchema,
  UpdateOwnerInputSchema,
  type BoardOwner,
  type CreateOwnerInput,
  type UpdateOwnerInput,
} from "./owner-schemas.js";

export {
  STATUS_COLORS,
  DEFAULT_BOARD_STATUSES,
  DELETED_STATUS_LABEL,
  DELETED_STATUS_COLOR,
  BoardStatusSchema,
  CreateBoardStatusInputSchema,
  UpdateBoardStatusInputSchema,
  type BoardStatus,
  type CreateBoardStatusInput,
  type UpdateBoardStatusInput,
} from "./board-status-schemas.js";

export {
  BOARD_KINDS,
  BOARD_TEMPLATES,
  DEFAULT_BOARD_KIND,
  RECRUITMENT_DECISION_OPTIONS,
  getBoardTemplate,
  isBoardKind,
  type BoardKind,
  type BoardTemplate,
  type TemplateColumn,
  type TemplateColumnType,
  type TemplateColumnConfig,
  type TemplateGroup,
  type TemplateViews,
} from "./board-templates.js";

export {
  boardCapabilities,
  type BoardCapabilities,
} from "./board-capabilities.js";

export {
  GitHubMilestoneSchema,
  GitHubIssueSchema,
  GitHubInstanceSchema,
  CreateGitHubInstanceInputSchema,
  UpdateGitHubInstanceInputSchema,
  GitHubSyncConfigSchema,
  CreateGitHubSyncConfigInputSchema,
  UpdateGitHubSyncConfigInputSchema,
  type GitHubMilestone,
  type GitHubIssue,
  type GitHubInstance,
  type CreateGitHubInstanceInput,
  type UpdateGitHubInstanceInput,
  type GitHubSyncConfig,
  type CreateGitHubSyncConfigInput,
  type UpdateGitHubSyncConfigInput,
  GitHubStatusMappingSchema,
  DEFAULT_GITHUB_STATUS_MAPPING,
  type GitHubStatusMapping,
  normalizeRepoFullName,
  GitHubProjectSchema,
  GitHubProjectStatusOptionSchema,
  type GitHubProject,
  type GitHubProjectStatusOption,
} from "./github-schemas.js";

export type { GitHubPort } from "./github-port.js";
export type { GitHubProjectsPort, GitHubProjectItem } from "./github-projects-port.js";

export { GitHubRestAdapter, GitHubAuthError } from "./github-rest-adapter.js";

export { FakeGitHubAdapter } from "./fake-github-adapter.js";

export { FakeGitHubProjectsAdapter } from "./fake-github-projects-adapter.js";
export type { FakeProjectsSeed } from "./fake-github-projects-adapter.js";

export { GitHubProjectsGraphQLAdapter, GitHubProjectsAuthError } from "./github-projects-graphql-adapter.js";

export { extractPlainText } from './adf-to-plain-text.js';

export {
  AzureDevOpsAuthMethodSchema,
  AzureDevOpsWorkItemSchema,
  AzureDevOpsInstanceSchema,
  CreateAzureDevOpsInstanceInputSchema,
  UpdateAzureDevOpsInstanceInputSchema,
  AzureDevOpsSyncConfigSchema,
  CreateAzureDevOpsSyncConfigInputSchema,
  UpdateAzureDevOpsSyncConfigInputSchema,
  ADO_DEFAULT_STATUS_MAPPING,
  type AzureDevOpsAuthMethod,
  type AzureDevOpsWorkItem,
  type AzureDevOpsInstance,
  type CreateAzureDevOpsInstanceInput,
  type UpdateAzureDevOpsInstanceInput,
  type AzureDevOpsSyncConfig,
  type CreateAzureDevOpsSyncConfigInput,
  type UpdateAzureDevOpsSyncConfigInput,
  type AzureDevOpsProjectSync,
  type UpsertAzureDevOpsProjectSyncInput,
  type UpdateAzureDevOpsProjectSyncInput,
  type AzureDevOpsRepository,
} from './azure-devops-schemas.js';

export type { AzureDevOpsPort } from './azure-devops-port.js';
export type { AdoWorkItemRevision } from './ado-work-item-revision.js';
export { buildAdoTransitions } from './ado-transition-builder.js';
export type { AdoTransitionRow, AdoPriorState } from './ado-transition-builder.js';
export { RequestThrottle } from './request-throttle.js';
export type { Throttle, RequestThrottleOpts, ThrottleClock } from './request-throttle.js';

export {
  AzureDevOpsRestAdapter,
  AzureDevOpsAuthError,
  AzureDevOpsCircuitOpenError,
} from './azure-devops-rest-adapter.js';

export { FakeAzureDevOpsAdapter } from './fake-azure-devops-adapter.js';

// Phase 3 (EI-009) — AI-assistance detection for commits/PRs.
export { detectAiAssistance } from './ai-detection.js';
export type { AiSignalInput, AiDetectionResult } from './ai-detection.js';

// Phase 3 (EI-010) — Ticket-key extraction from commit messages, PR text, branch names.
export { extractTicketKeys } from './ticket-link-extractor.js';
export type { TicketLinkInput } from './ticket-link-extractor.js';

// Phase 3 (EI-003) — GitHub pull request adapter (all PRs incl. drafts, plus reviews).
export { GitHubPrAdapter, FakeGitHubPrAdapter, transformGitHubPr } from './github-pr-adapter.js';
export type {
  GitHubPrPort,
  GitHubPrFetchOpts,
  GitHubPullRequestRow,
  GitHubReviewRow,
  RawPr as GitHubRawPr,
  RawReview as GitHubRawReview,
  RawReviewComment as GitHubRawReviewComment,
} from './github-pr-adapter.js';

// Phase 3 (EI-004) — GitHub commit adapter with incremental watermark + AI detection.
export { GitHubCommitAdapter, FakeGitHubCommitAdapter } from './github-commit-adapter.js';
export type {
  GitHubCommitPort,
  GitHubCommitFetchOpts,
  GitHubCommitRow,
} from './github-commit-adapter.js';

// Phase 3 — GitLab base URL normalization (web URL → /api/v4 REST root).
export { gitlabApiBase } from './gitlab-api-base.js';

// Phase 3 (EI-005) — GitLab MR adapter (all states + approvals + first-review proxy).
export { GitLabPrAdapter, FakeGitLabPrAdapter } from './gitlab-pr-adapter.js';
export type {
  GitLabPrPort,
  GitLabPrFetchOpts,
  GitLabMergeRequestRow,
  GitLabMergeRequestPage,
} from './gitlab-pr-adapter.js';

// Phase 3 (EI-006) — GitLab commit adapter with diff stats + merge detection.
export { GitLabCommitAdapter, FakeGitLabCommitAdapter } from './gitlab-commit-adapter.js';
export type {
  GitLabCommitPort,
  GitLabCommitFetchOpts,
  GitLabCommitRow,
} from './gitlab-commit-adapter.js';

// Phase 3 — GitLab MR review row shape (parity with GitHub reviews).
export { buildGitLabReviews } from './gitlab-review-adapter.js';
export type { GitLabReviewRow } from './gitlab-review-adapter.js';

// Phase 3 — GitLab issues adapter (streaming, parity with GitHubIssueRow).
export { GitLabIssueAdapter, FakeGitLabIssueAdapter } from './gitlab-issue-adapter.js';
export type { GitLabIssuePort, GitLabIssueFetchOpts, GitLabIssueRow } from './gitlab-issue-adapter.js';

// Phase 3 (EI-007) — ADO Repos PR adapter (lists repos, fetches PRs + threads).
export { AdoPrAdapter, FakeAdoPrAdapter } from './ado-pr-adapter.js';
export type {
  AdoPrPort,
  AdoPrFetchOpts,
  AdoPrFetchResult,
  AdoPullRequestRow,
  AdoReviewRow,
} from './ado-pr-adapter.js';

// Phase 3 (EI-007b) — ADO commit adapter (all branches, per-repo, dedupe by SHA).
export { AdoCommitAdapter, FakeAdoCommitAdapter } from './ado-commit-adapter.js';
export type {
  AdoCommitPort,
  AdoCommitFetchOpts,
  AdoCommitRow,
} from './ado-commit-adapter.js';

// Real ADO deployment records (classic Release pipelines) — the source DORA's
// deploy frequency prefers over the merged-PR proxy.
export {
  AdoDeploymentAdapter,
  FakeAdoDeploymentAdapter,
  releaseHost,
} from './ado-deployment-adapter.js';
export type {
  AdoDeploymentPort,
  AdoDeploymentFetchOpts,
  AdoDeploymentRow,
} from './ado-deployment-adapter.js';

// Resilient JSON fetch (per-attempt timeout covering the body read + bounded
// retry) for long upstream-API sync loops.
export { resilientFetchJson } from './resilient-fetch.js';
export type { ResilientFetchOpts, ResilientJsonResult } from './resilient-fetch.js';

// Phase 3 (EI-008) — Jira intelligence adapter (changelog + worklogs + full fields).
export {
  JiraIntelligenceAdapter,
  FakeJiraIntelligenceAdapter,
} from './jira-intelligence-adapter.js';
export type {
  JiraIntelligencePort,
  JiraIntelligenceFetchOpts,
  JiraIssueRow,
  JiraTransitionRow,
  JiraWorklogRow,
} from './jira-intelligence-adapter.js';

// Phase 3 (EI-002) — Zod intelligence DTO schemas, shared by api routes + web fetches.
export {
  TeamOverviewSchema,
  DeveloperWeeklyPointSchema,
  DeveloperAnomalySchema,
  AiBreakdownRowSchema,
  TicketCoverageSchema,
  TicketTimelineEventSchema,
  SyncTriggerSourceSchema,
} from './intelligence-schemas.js';
export type {
  TeamOverview,
  DeveloperWeeklyPoint,
  DeveloperAnomaly,
  AiBreakdownRow,
  TicketCoverage,
  TicketTimelineEvent,
  SyncTriggerSource,
} from './intelligence-schemas.js';

export {
  DeveloperProviderSchema,
  DeveloperProfileSchema,
  DeveloperProfileLinkSchema,
  type DeveloperProvider,
  type DeveloperProfileDto,
} from './developer-profile-schemas.js';
export { BENCHMARKS_V1, tierFor, type BenchmarkConfig, type Tier } from './benchmarks.js';

export {
  NEW_WIDGET_TYPES,
  COMPARISON_WIDGET_TYPES,
  WIDGET_SUBJECTS,
  WIDGET_CATEGORIES,
  CHART_KINDS,
  WIDGET_SOURCE_KINDS,
  WIDGET_SCOPE_REQUIREMENTS,
  widgetIsSupportedByScope,
} from './widget-types.js';
export type {
  NewWidgetType,
  ComparisonWidgetType,
  WidgetSubject,
  WidgetCategory,
  ChartKind,
  WidgetSourceKind,
  WidgetScopeFlags,
} from './widget-types.js';

export {
  ENGINEERING_INTELLIGENCE_PRESET_V1,
  TEAM_FOCUS_PRESET_V1,
  ALL_PRESETS,
} from './widgets/presets.js';
export type { Preset, PresetWidget } from './widgets/presets.js';

export {
  JiraProjectSyncSchema,
  JiraProjectSyncListSchema,
  JiraProjectSyncCreateSchema,
  BoardJiraSourceSchema,
  BoardJiraSourceCreateSchema,
  BoardJiraSourcePatchSchema,
  GitHubRepoSyncSchema,
  BoardGitHubSourceCreateSchema,
  BoardGitHubSourcePatchSchema,
  AdoProjectSyncSchema,
  BoardAdoSourceCreateSchema,
  BoardAdoSourcePatchSchema,
  AdoSourceRepositorySchema,
  AdoSourceRepositoriesResponseSchema,
  AdoAreaPathSchema,
  AdoAreaPathsResponseSchema,
  GitLabProjectSyncSchema,
  BoardGitLabSourceCreateSchema,
  BoardGitLabSourcePatchSchema,
  type JiraProjectSyncDto,
  type AdoSourceRepositoryDto,
  type AdoSourceRepositoriesResponseDto,
  type AdoAreaPathDto,
  type AdoAreaPathsResponseDto,
} from './connections-schemas.js';

export {
  BoardSyncEnqueueResponseSchema,
  BoardSyncStatusResponseSchema,
  SourceHealthStateSchema,
  BoardSourceHealthSchema,
  BoardSourceHealthResponseSchema,
  SyncExclusionSourceSchema,
  BoardSyncExclusionSchema,
  BoardSyncExclusionPageSchema,
  ListBoardSyncExclusionsQuerySchema,
  RestoreBoardSyncExclusionsByIdsSchema,
  RestoreAllBoardSyncExclusionsSchema,
  RestoreBoardSyncExclusionsInputSchema,
  RestoreBoardSyncExclusionsResponseSchema,
  type BoardSyncEnqueueResponse,
  type BoardSyncStatusResponse,
  type SourceHealthState,
  type BoardSourceHealth,
  type BoardSourceHealthResponse,
  type SyncExclusionSource,
  type BoardSyncExclusion,
  type BoardSyncExclusionPage,
  type ListBoardSyncExclusionsQuery,
  type RestoreBoardSyncExclusionsByIds,
  type RestoreAllBoardSyncExclusions,
  type RestoreBoardSyncExclusionsInput,
  type RestoreBoardSyncExclusionsResponse,
} from './board-sync.js';

export {
  periodPresetSchema,
  boardPeriodSchema,
  presetToDays,
  intelligenceSchemaSchema,
  intelligenceSqlResponseSchema,
  type PeriodPreset,
  type BoardPeriod,
  type IntelligenceSchema,
  type IntelligenceSqlResponse,
} from './intelligence-query.js';


export {
  SIZE_LABELS,
  DEFAULT_SIZE_DURATIONS,
  DEFAULT_SIZE_WEEKS,
  sizeWeeksFromLabel,
  addCalendarDays,
  computeSchedule,
  resolveWidthDays,
  compareOrder,
} from './roadmap-schedule.js';
export type {
  SizeLabel,
  SizeDurations,
  ScheduleConfig,
  ScheduleProject,
  ScheduleGroup,
  ScheduledBar,
} from './roadmap-schedule.js';
export {
  SizeDurationsSchema,
  RoadmapConfigPayloadSchema,
  UpdateRoadmapConfigInputSchema,
} from './roadmap-config.js';
export type { RoadmapConfigPayload, UpdateRoadmapConfigInput } from './roadmap-config.js';

export {
  PickerQuerySchema,
  PickerRepoSchema,
  PickerResponseSchema,
  GitHubPickerErrorSchema,
  BulkBindRequestSchema,
  BulkBindResponseSchema,
  type PickerQuery,
  type PickerRepo,
  type PickerResponse,
  type GitHubPickerError,
  type BulkBindRequest,
  type BulkBindResponse,
} from './github/picker.schema.js';

export { computeTier, type Tier as GitHubRepoTier } from './github/tier.js';
export { estimateBackfillCost, type RepoCostInput } from './github/backfill-estimator.js';

export {
  GITHUB_SYNC_TIER_INTERVAL_MS,
  GITHUB_SYNC_QUEUE_NAMES,
  makeGitHubQueueClient,
  type GitHubQueueClient,
  type BullMqQueueLike,
} from './github/queue-client.js';

export { SIZE_COLUMN_NAME, SIZE_COLUMN_CONFIG } from './roadmap-size-column.js';

export {
  DURATION_RE,
  parseDuration,
  durationToDays,
  formatDuration,
} from './duration.js';
export type { DurationUnit } from './duration.js';

export {
  SetScheduleInputSchema,
  HiddenSystemFieldsSchema,
  SYSTEM_FIELD_KEYS,
  type SetScheduleInput,
  type HiddenSystemFields,
  type SystemFieldKey,
} from './roadmap-schedule-input.js';

export {
  reconcileRoadmapGroups,
  type ExistingRow,
  type ReconcileInput,
  type ReconcileResult,
} from './reconcile-roadmap-groups.js';

export {
  normalizeName,
  nameFromEmail,
  flKey,
  buildMatchIndex,
  matchIdentity,
} from './org-employee-matcher.js';
export type { MatchIndex } from './org-employee-matcher.js';

export {
  OrgProviderSchema, OrgAliasKindSchema, BoardStatSchema, EmployeeStatsSchema,
  RankingCountsSchema, RankingMetricDetailSchema, RankingTierSchema, EmployeeRankingDtoSchema,
  OrgEmployeeAliasDtoSchema, OrgEmployeeDtoSchema, OrgTreeDtoSchema,
  CreateOrgTreeSchema, RenameOrgTreeSchema, OrgEmployeeAliasInputSchema, ImportResultSchema, SyncStatusSchema,
  CreateEmployeeSchema, UpdateEmployeeSchema, UpdateEmployeeProfileSchema, MoveEmployeeSchema,
} from './org-tree-schemas.js';
export type {
  EmployeeStats, RankingCounts, RankingMetricDetail, RankingTier, EmployeeRankingDto,
  OrgEmployeeAliasDto, OrgEmployeeDto, OrgTreeDto, ImportResult, SyncStatus,
  CreateEmployeeInput, UpdateEmployeeInput, UpdateEmployeeProfileInput, MoveEmployeeInput,
} from './org-tree-schemas.js';

export {
  ACTIVE_WINDOW_DAYS, UNMAPPED, isWithinActiveWindow, reduceEmployeeSnapshot, toUtcIso,
} from './org-employee-stats.js';
export type { MatchedActivityRow } from './org-employee-stats.js';

export { computeRanking, rankTier, RANKING_WEIGHTS } from './org-ranking.js';
export type { RankingInput, RankingMetricKey } from './org-ranking.js';

export {
  INVESTMENT_CATEGORIES,
  classifyInvestmentType,
  aggregateInvestmentAllocation,
} from './investment-allocation.js';
export type {
  InvestmentCategory,
  InvestmentTypeCount,
  InvestmentSlice,
  InvestmentAllocation,
} from './investment-allocation.js';

export { DORA_BENCHMARKS, DORA_METRIC_LABELS, classifyDora, buildDoraScorecard } from './dora.js';
export type { DoraMetricKey, DoraMetric, DoraInputs } from './dora.js';

export {
  computeDelta,
  buildPeriodComparison,
  type PeriodMetricKey,
  type MetricDirection,
  type DeltaVerdict,
  type PeriodDelta,
  type PeriodComparisonMetric,
  type PeriodComparisonInputs,
} from './period-comparison.js';

export { costFromSeconds, DEFAULT_BLENDED_HOURLY_RATE } from './timesheet-cost.js';

export { gradeTrajectory, type TrajectoryGrade, type TrajectoryVerdict } from './trajectory.js';

export { HEAT_WEEKS, emptyHeat, mondayOf, weekSlotIndex } from './commit-heat.js';

export {
  isVacancyRow,
  normalizeOrgRows,
  resolveHierarchy,
} from './org-chart-rows.js';
export type { RawOrgRow, ParsedEmployee } from './org-chart-rows.js';

export { collectSubtree, wouldCreateCycle } from './org-tree-edit.js';

// Timesheet compute engine (Phase 2a) — capex/opex allocation.
// NOTE: explicit named re-exports (not `export *`). The api/worker load this
// CJS package as ESM via tsx; Node's cjs-module-lexer surfaces explicit named
// re-exports but NOT `export *`, so star re-exports here are invisible to ESM
// importers and crash the api on boot. Keep this list in sync with ./timesheet/index.
export {
  reconstructIntervals,
  clipToWindow,
  clipRetiredSpans,
  jiraProjectKeyOf,
  resolveInProgressStatuses,
  spanIsInProgress,
  splitIntoBuckets,
  normalizeConcurrent,
  resolveClassification,
  computeTimesheet,
  resolveDailyCapSeconds,
  DEFAULT_DAILY_CAP_HOURS,
  DONE_STATUS_NAMES,
  resolveEpicKey,
  buildEpicBreakdown,
  buildIssueTimeline,
  summarizeByStatus,
  NON_IN_PROGRESS_STATUSES,
} from './timesheet/index.js';
export type {
  Provider,
  RawTransition,
  StatusSpan,
  StatusRule,
  ResolvedStatusConfig,
  Granularity,
  BucketSlice,
  WeightedSpan,
  Classification,
  EmployeeInput,
  ComputeInput,
  GridCell,
  ReportCell,
  ComputeResult,
  EpicBreakdownRow,
  EpicBreakdownInput,
  EpicEmployeeSeconds,
  RetiredProjectMap,
  TimelineSegment,
  StatusDuration,
  BuildIssueTimelineInput,
} from './timesheet/index.js';

// Timesheet API schemas (Phase 2b-ii) — request/response validation.
export {
  GranularitySchema,
  TimesheetModeSchema,
  ClassificationDtoSchema,
  TimesheetGridQuerySchema,
  CapexReportQuerySchema,
  EpicBreakdownQuerySchema,
  IntervalsQuerySchema,
  TimesheetTaskDtoSchema,
  TimesheetCellDtoSchema,
  TimesheetEmployeeRowSchema,
  UnmatchedRowSchema,
  TimesheetGridResponseSchema,
  ReportBucketSchema,
  ReportGroupSchema,
  CapexReportResponseSchema,
  EpicRowSchema,
  EpicEmployeeRowSchema,
  EpicBreakdownResponseSchema,
  IntervalDtoSchema,
  TimelineSegmentDtoSchema,
  StatusDurationDtoSchema,
  IssueEpicDtoSchema,
  IntervalsResponseSchema,
  StatusRuleDtoSchema,
  PutStatusRulesSchema,
  OrgTreeTimesheetConfigDtoSchema,
  PutOrgTreeTimesheetConfigSchema,
} from './timesheet-api-schemas.js';
export type {
  TimesheetGridQuery,
  CapexReportQuery,
  EpicBreakdownQuery,
  IntervalsQuery,
  TimesheetTaskDto,
  TimesheetCellDto,
  TimesheetEmployeeRow,
  TimesheetGridResponse,
  CapexReportResponse,
  EpicRow,
  EpicEmployeeRow,
  EpicBreakdownResponse,
  IntervalsResponse,
  TimelineSegmentDto,
  StatusDurationDto,
  IssueEpicDto,
  StatusRuleDto,
  PutStatusRules,
  OrgTreeTimesheetConfigDto,
  PutOrgTreeTimesheetConfig,
} from './timesheet-api-schemas.js';

export {
  SYSTEM_COLUMN_KEYS,
  RoadmapAccessRoleEnum,
  CreateRoadmapInputSchema,
  UpdateRoadmapInputSchema,
  AddGroupsInputSchema,
  AddSubscriptionInputSchema,
  ReorderRoadmapGroupsInputSchema,
  type SystemColumnKey,
  type RoadmapAccessRoleValue,
  type CreateRoadmapInput,
  type UpdateRoadmapInput,
  type AddGroupsInput,
  type AddSubscriptionInput,
  type ReorderRoadmapGroupsInput,
  type RoadmapItem,
  type RoadmapGroupResolved,
  type RoadmapSummary,
  type RoadmapDetail,
} from './roadmap-entity-schemas.js';

export { lengthOfService } from './org-board-groups.js';

export {
  resolveEmployeeIdentities,
  isEmptyIdentities,
  type EmployeeIdentities,
} from './employee-identities.js';

export { collectSubtreeEmployeeIds } from './employee-board-subtree.js';

export {
  EMPLOYEE_BOARD_COLUMN_KEYS, EmployeeBoardColumnKeySchema, DEFAULT_COLUMN_ORDER,
  EmployeeBoardColumnConfigSchema, resolveColumns, EmployeeColumnTypeSchema,
} from './employee-board-columns.js';
export type { EmployeeBoardColumnKey, EmployeeBoardColumnConfig, EmployeeColumnType } from './employee-board-columns.js';
export { buildBoardGridTemplate } from './board-grid-template.js';
export type { GridColumnSpec, BoardGridOptions } from './board-grid-template.js';

export {
  EmployeeBoardSummaryDtoSchema, EmployeeBoardMemberDtoSchema, EmployeeGroupDtoSchema,
  EmployeeBoardDetailDtoSchema, CreateEmployeeBoardSchema, RenameEmployeeBoardSchema,
  SetEmployeeBoardPersonalSchema,
  CreateEmployeeGroupSchema, UpdateEmployeeGroupSchema, ReorderEmployeeGroupsSchema,
  AddExistingMembersSchema, AddNewEmployeeSchema, MoveMemberSchema, SetManagerSchema,
  EmployeeColumnDtoSchema, CreateEmployeeColumnSchema, UpdateEmployeeColumnSchema,
  SetEmployeeFieldValueSchema,
} from './employee-board-schemas.js';
export type {
  EmployeeBoardSummaryDto, EmployeeBoardMemberDto, EmployeeGroupDto, EmployeeBoardDetailDto,
  CreateEmployeeBoardInput, RenameEmployeeBoardInput, SetEmployeeBoardPersonalInput,
  CreateEmployeeGroupInput,
  UpdateEmployeeGroupInput, ReorderEmployeeGroupsInput, AddExistingMembersInput,
  AddNewEmployeeInput, MoveMemberInput, SetManagerInput,
  EmployeeColumnDto, CreateEmployeeColumnInput, UpdateEmployeeColumnInput,
  SetEmployeeFieldValueInput,
} from './employee-board-schemas.js';

export {
  valueForColumn, sortEmployeeRows, filterEmployeeRows, searchEmployeeRows,
} from './employee-row-query.js';
export type { EmployeeSortConfig, EmployeeFilterRule } from './employee-row-query.js';

export {
  EmployeeCommentSchema,
  CreateEmployeeCommentInputSchema,
  UpdateEmployeeCommentInputSchema,
} from './employee-comment-schemas.js';
export type {
  EmployeeComment,
  CreateEmployeeCommentInput,
  UpdateEmployeeCommentInput,
} from './employee-comment-schemas.js';

export {
  SaveOrgSourceInputSchema,
  OrgSourceSyncSummarySchema,
  OrgSourceConfigSchema,
  SaveOrgSourceConnectionSchema,
  type SaveOrgSourceInput,
  type OrgSourceSyncSummaryT,
  type OrgSourceConfig,
  type SaveOrgSourceConnectionInput,
} from './org-source-schemas.js';

export {
  BoardCalendarSourceConfigSchema,
  SaveCalendarSourceConnectionSchema,
  type BoardCalendarSourceConfig,
  type SaveCalendarSourceConnectionInput,
} from './calendar-source-schemas.js';

export {
  mapGraphUserToEmployee,
  type GraphUser,
  type MappedGraphEmployee,
} from './graph-user-map.js';

export {
  reconcileScope,
  type ScopeNode,
  type OrgSourceExistingRow,
  type ReconcileUpsert,
  type ReconcilePlan,
} from './org-source-reconcile.js';

export {
  LocationSuggestionSchema,
  LocationSearchResponseSchema,
} from './location-schemas.js';
export type { LocationSuggestion, LocationSearchResponse } from './location-schemas.js';

export {
  advisorAskRequestSchema,
  advisorConfigSchema,
  advisorSourceLookupSchema,
  advisorAppendMessageSchema,
  advisorHistoryMessageSchema,
  advisorMessageRoleSchema,
  advisorPageContextSchema,
  advisorHelpAskRequestSchema,
  buildHistoryForAsk,
  deriveSessionTitle,
  ADVISOR_HISTORY_MAX_MESSAGES,
  ADVISOR_HISTORY_MAX_CHARS,
  ADVISOR_MESSAGE_MAX_CHARS,
  ADVISOR_QUESTION_MAX_CHARS,
  ADVISOR_TITLE_MAX_CHARS,
  type AdvisorAskRequest,
  type AdvisorConfigInput,
  type AdvisorSourceLookupInput,
  type AdvisorAppendMessageInput,
  type AdvisorHistoryMessage,
  type AdvisorMessageRole,
  type AdvisorPageContextDto,
  type AdvisorHelpAskRequest,
  type AdvisorSessionSummaryDto,
  type AdvisorSessionMessageDto,
  type AdvisorSessionTranscriptDto,
} from './advisor.js';

export {
  listBoardRowsInputSchema,
  DESCRIPTION_PREVIEW_MAX,
  LIST_BOARD_ROWS_MAX_LIMIT,
} from './advisor-board-reads.js';
export type {
  ListBoardRowsInput,
  AdvisorBoardRowDto,
  AdvisorBoardRowsDto,
  AdvisorBoardStructureDto,
  AdvisorExcludedRowDto,
} from './advisor-board-reads.js';

export {
  resolveJiraBrowseUrl,
  hasAnyJiraLink,
  type JiraSourceLinks,
} from './jira-source-links.js';


// Organization tenancy contracts (spec §4). Named re-exports only — this barrel
// must never use `export *`.
export {
  ORG_ROLES,
  OrgRoleSchema,
  ORG_ROLE_RANK,
  ORG_MEMBERSHIP_STATUSES,
  OrgMembershipStatusSchema,
  BootstrapOrganizationSchema,
  InviteMemberSchema,
  UpdateMemberRoleSchema,
  SwitchOrganizationSchema,
  UpdateMemberStatusSchema,
  type OrgMembershipOptionDto,
  type SwitchOrganizationInput,
} from './org.js';
export type {
  OrgRoleValue,
  OrgMembershipStatusValue,
  BootstrapOrganizationInput,
  InviteMemberInput,
  OrganizationDto,
  OrgMemberDto,
  OrgBoardDto,
  UpdateMemberRoleInput,
  UpdateMemberStatusInput,
} from './org.js';

export { slugify } from './slugify.js';

// Sharing contracts — one vocabulary for all five shareable entities
// (2026-08-18-monday-style-board-sharing-design.md §5).
export {
  ACCESS_ROLES,
  AccessRoleSchema,
  ACCESS_ROLE_RANK,
  ACCESS_ENTITY_KINDS,
  ACCESS_ROLE_LABELS,
  ACCESS_ENTITY_NOUNS,
  ACCESS_ROLE_HINTS,
  OrgPersonSchema,
  AccessEntrySchema,
  GrantAccessSchema,
  UpdateAccessRoleSchema,
  MyRoleSchema,
  canEditEntity,
  canManageEntity,
} from './access.js';
export type {
  AccessRoleValue,
  AccessEntityKind,
  OrgPerson,
  AccessEntry,
  GrantAccessInput,
  UpdateAccessRoleInput,
  MyRole,
} from './access.js';

export {
  EditionNoticeSchema,
  EditionNoticeActionSchema,
  EditionNoticeSeverity,
  MAX_NOTICES,
  MAX_ACTIONS,
  sanitiseEditionNotices,
} from './edition-notice.js';
export type { EditionNotice, EditionNoticeAction } from './edition-notice.js';

export {
  SYNC_FIELDS,
  CUSTOM_COLUMN_KEY_PREFIX,
  syncFieldSpec,
  syncFieldsForSource,
  customColumnKey,
  isCustomColumnKey,
  columnIdFromKey,
  shouldSync,
  readOverrideState,
  markOverridden,
  clearOverride,
} from "./sync-field-registry.js";
export type { SyncSource, SyncFieldSpec, OverrideState } from "./sync-field-registry.js";

export {
  effectiveBoardRole,
  personalBoardRole,
  meetsBoardRole,
  meetsOrgRole,
  canCreateBoard,
  canManageOrg,
  type EffectiveBoardRole,
} from "./board-role-rules.js";

export { ACCESS_ENTITIES, type AccessEntityDescriptor } from "./access-entities.js";

export { verbFor, isSubjectFirst } from "./notification-verbs.js";

export {
  manualSyncJobPayload,
  type ManualSyncJobPayload,
  type SweepSyncJobPayload,
  type SweepingSyncTrigger,
  type SyncJobPayload,
} from "./sync-job-payload.js";

export {
  boardOpSchema,
  proposeBoardChangesInputSchema,
  parseOpRef,
  OP_REF_PATTERN,
  MAX_OPS_PER_CHANGE_SET,
  MAX_ROWS_PER_OP,
  MAX_TOTAL_ROWS_PER_CHANGE_SET,
} from "./advisor-change-set.js";
export type {
  BoardOp,
  ProposeBoardChangesInput,
  AdvisorChangeSetPreviewRowDto,
  AdvisorChangeSetPreviewDto,
  AdvisorChangeSetStatusDto,
  AdvisorChangeSetDto,
  BoardOpErrorDto,
  ProposeBoardChangesResultDto,
} from "./advisor-change-set.js";

export {
  JiraFieldSchemaShapeSchema,
  JiraFieldMetaSchema,
  MappableColumnTypeSchema,
  DiscoveredJiraFieldSchema,
  DiscoveredJiraFieldListSchema,
  AttachJiraFieldInputSchema,
} from "./jira-field-schemas.js";
export type {
  JiraFieldSchemaShape,
  JiraFieldMeta,
  MappableColumnType,
  DiscoveredJiraField,
  AttachJiraFieldInput,
} from "./jira-field-schemas.js";

export {
  MULTI_VALUE_DELIMITER,
  joinMultiValue,
  splitMultiValue,
  columnTypeForJiraField,
  unsupportedReasonFor,
  extractJiraFieldValue,
} from "./jira-field-extract.js";

// Focus view. Re-exports ./focus/index.js, which deliberately EXCLUDES
// ./focus/fingerprint.js — that module imports node:crypto, and apps/web pulls
// this barrel into client components. Server code imports the fingerprint
// helper from the "@deckgauge/shared/focus/fingerprint.js" subpath instead.
// (`normalise-title.js` IS on the barrel and is safe: it is pure, which is
// exactly why the fingerprint was split out of it.)
export * from "./focus/index.js";

// The five status buckets, shared by the timesheet's Time rules panel and the
// Focus stage map. Pure — no node builtins — so apps/web can import it.
export * from "./status-buckets/index.js";

import { z } from 'zod';

// ── Jira ────────────────────────────────────────────────────────────────────
export const JiraProjectSyncSchema = z.object({
  id: z.string().uuid(),
  jiraInstanceId: z.string().uuid(),
  jiraProjectKey: z.string().min(1),
  syncChangelog: z.boolean(),
  syncWorklogs: z.boolean(),
  lastSyncedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  boardCount: z.number().int().min(0),
});
export type JiraProjectSyncDto = z.infer<typeof JiraProjectSyncSchema>;
export const JiraProjectSyncListSchema = z.array(JiraProjectSyncSchema);

export const JiraProjectSyncCreateSchema = z.object({
  jiraInstanceId: z.string().uuid(),
  jiraProjectKey: z.string().min(1),
  syncChangelog: z.boolean().default(true),
  syncWorklogs: z.boolean().default(false),
});

export const BoardJiraSourceSchema = z.object({
  id: z.string().uuid(),
  boardId: z.string().uuid(),
  jiraProjectSyncId: z.string().uuid(),
  targetGroupId: z.string().uuid().nullable(),
  allowedIssueTypes: z.array(z.string()),
  statusMapping: z.record(z.string(), z.string()),
  defaultSyncedFields: z.array(z.string()),
  lastPromotedAt: z.string().datetime().nullable(),
});
export const BoardJiraSourceCreateSchema = z.object({
  boardId: z.string().uuid(),
  jiraProjectSyncId: z.string().uuid(),
  targetGroupId: z.string().uuid().nullable().optional(),
  allowedIssueTypes: z.array(z.string()).default([]),
  jqlFilter: z.string().nullable().optional(),
  statusMapping: z.record(z.string(), z.string()).default({}),
  defaultSyncedFields: z.array(z.string()).default(['name', 'status', 'owner']),
});

export const BoardJiraSourcePatchSchema = z.object({
  targetGroupId: z.string().uuid().nullable().optional(),
  allowedIssueTypes: z.array(z.string()).optional(),
  jqlFilter: z.string().nullable().optional(),
  statusMapping: z.record(z.string(), z.string()).optional(),
  defaultSyncedFields: z.array(z.string()).optional(),
});

// ── GitHub ──────────────────────────────────────────────────────────────────
// GitHubRepoSync.id is `@default(cuid())` (not uuid like the rest of the
// schema), and legacy rows may still carry a uuid — so accept any non-empty id.
export const GitHubRepoSyncSchema = z.object({
  id: z.string().min(1),
  githubInstanceId: z.string().uuid(),
  repoFullName: z.string().regex(/^[^/]+\/[^/]+$/),
  syncPrs: z.boolean(),
  syncCommits: z.boolean(),
  lastSyncedAt: z.string().datetime().nullable(),
  lastCommitSyncAt: z.string().datetime().nullable(),
  boardCount: z.number().int().min(0),
});
export const BoardGitHubSourceCreateSchema = z.object({
  boardId: z.string().uuid(),
  gitHubRepoSyncId: z.string().min(1),
  targetGroupId: z.string().uuid().nullable().optional(),
  allowedLabels: z.array(z.string()).default([]),
  allowedTypes: z.array(z.string()).default([]),
  includeClosedIssues: z.boolean().default(false),
  statusMapping: z.record(z.string(), z.string()).default({}),
  defaultSyncedFields: z.array(z.string()).default(['name', 'description', 'status', 'owner']),
  syncIssuesToBoard: z.boolean().default(true),
  useForIntelligence: z.boolean().default(true),
});

export const BoardGitHubSourcePatchSchema = z.object({
  targetGroupId: z.string().uuid().nullable().optional(),
  allowedLabels: z.array(z.string()).optional(),
  allowedTypes: z.array(z.string()).optional(),
  includeClosedIssues: z.boolean().optional(),
  statusMapping: z.record(z.string(), z.string()).optional(),
  defaultSyncedFields: z.array(z.string()).optional(),
  syncIssuesToBoard: z.boolean().optional(),
  useForIntelligence: z.boolean().optional(),
});

// ── ADO ─────────────────────────────────────────────────────────────────────
export const AdoProjectSyncSchema = z.object({
  id: z.string().uuid(),
  azureDevOpsInstanceId: z.string().uuid(),
  adoProject: z.string().min(1),
  syncPrs: z.boolean(),
  syncCommits: z.boolean(),
  syncRepos: z.array(z.string()),
  lastSyncedAt: z.string().datetime().nullable(),
  boardCount: z.number().int().min(0),
});
export const BoardAdoSourceCreateSchema = z.object({
  boardId: z.string().uuid(),
  azureDevOpsProjectSyncId: z.string().uuid(),
  targetGroupId: z.string().uuid().nullable().optional(),
  allowedWorkItemTypes: z.array(z.string()).default([]),
  wiqlFilter: z.string().nullable().optional(),
  statusMapping: z.record(z.string(), z.string()).default({}),
  defaultSyncedFields: z.array(z.string()).default(['name', 'status', 'owner']),
  syncWorkItemsToBoard: z.boolean().default(true),
  useForIntelligence: z.boolean().default(true),
  // Repository names to include in engineering-intelligence analytics for
  // this board's ADO source. An empty array means ALL repositories.
  intelligenceRepos: z.array(z.string()).default([]),
  // Area paths to include in engineering-intelligence analytics for this
  // board's ADO source, matched by PREFIX. An empty array means ALL area paths.
  // `intelligenceRepos` cannot narrow work items: ado_work_items has no
  // repository column.
  areaPaths: z.array(z.string()).default([]),
});

export const BoardAdoSourcePatchSchema = z.object({
  targetGroupId: z.string().uuid().nullable().optional(),
  allowedWorkItemTypes: z.array(z.string()).optional(),
  wiqlFilter: z.string().nullable().optional(),
  statusMapping: z.record(z.string(), z.string()).optional(),
  defaultSyncedFields: z.array(z.string()).optional(),
  syncWorkItemsToBoard: z.boolean().optional(),
  useForIntelligence: z.boolean().optional(),
  // Optional so that a patch omitting this field leaves the board's existing
  // repository scope untouched — omission must never silently clear it.
  intelligenceRepos: z.array(z.string()).optional(),
  // Optional so a patch omitting this field leaves the board's existing area
  // scope untouched — omission must never silently clear it.
  areaPaths: z.array(z.string()).optional(),
});

export const AdoSourceRepositorySchema = z.object({
  repoName: z.string(),
  prCount: z.number().int().min(0),
  // True when the project sync currently ingests this repo (sync_all_repos,
  // or repoName in sync_repos). False means the repo has sync-state history
  // (it was synced at some point) but is not part of the CURRENT sync scope —
  // selecting it in the picker analyses frozen historical data.
  syncing: z.boolean(),
});
export type AdoSourceRepositoryDto = z.infer<typeof AdoSourceRepositorySchema>;

// Response for GET .../repositories. `otherBoardNames` names every OTHER board
// that shares this same project sync (the sync is project-level, shared by
// every board attached to it) — used to warn that editing the shared sync's
// scope affects those boards too. Empty when this board is the only one
// attached to the project sync.
export const AdoSourceRepositoriesResponseSchema = z.object({
  repos: z.array(AdoSourceRepositorySchema),
  otherBoardNames: z.array(z.string()),
});
export type AdoSourceRepositoriesResponseDto = z.infer<typeof AdoSourceRepositoriesResponseSchema>;

// The `areaPaths` (Task 3/9) counterpart to the repository picker
// above. `workItemCount` lets the picker sort/label by how populated an area
// path actually is.
export const AdoAreaPathSchema = z.object({
  areaPath: z.string(),
  workItemCount: z.number().int().min(0),
});
export type AdoAreaPathDto = z.infer<typeof AdoAreaPathSchema>;

// Response for GET .../area-paths. Unlike the repositories response above,
// there is no `otherBoardNames`: area paths are read straight from ClickHouse
// by (orgUrl, project), not filtered through a per-board sync-state table
// another board's edit could affect.
export const AdoAreaPathsResponseSchema = z.object({
  areaPaths: z.array(AdoAreaPathSchema),
});
export type AdoAreaPathsResponseDto = z.infer<typeof AdoAreaPathsResponseSchema>;

// ── GitLab ──────────────────────────────────────────────────────────────────
export const GitLabProjectSyncSchema = z.object({
  id: z.string().uuid(),
  gitlabInstanceId: z.string().uuid(),
  projectPath: z.string().min(1),
  syncPrs: z.boolean(),
  syncCommits: z.boolean(),
  lastSyncedAt: z.string().datetime().nullable(),
  boardCount: z.number().int().min(0),
});
export const BoardGitLabSourceCreateSchema = z.object({
  boardId: z.string().uuid(),
  gitlabProjectSyncId: z.string().uuid(),
  targetGroupId: z.string().uuid().nullable().optional(),
  syncIssuesToBoard: z.boolean().default(false),
  syncMrsToBoard: z.boolean().default(false),
});

export const BoardGitLabSourcePatchSchema = z.object({
  targetGroupId: z.string().uuid().nullable().optional(),
  syncIssuesToBoard: z.boolean().optional(),
  syncMrsToBoard: z.boolean().optional(),
});

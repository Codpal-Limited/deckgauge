import { z } from 'zod/v4';

/**
 * Normalizes a GitHub repo identifier to `owner/repo` format.
 * Handles full URLs like `https://github.com/owner/repo/issues/`
 * and trailing slashes like `owner/repo/`.
 */
export function normalizeRepoFullName(raw: string): string {
  let s = raw.trim();
  // Strip full GitHub URL prefix (https://github.com/ or github.com/)
  s = s.replace(/^https?:\/\/(www\.)?github\.com\//, '');
  // Remove any path segments after owner/repo (e.g. /issues, /pulls, /tree/main)
  const parts = s.split('/').filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0]}/${parts[1]}`;
  }
  return s;
}

export const GitHubMilestoneSchema = z.object({
  id: z.string(),
  repoFullName: z.string(),
  number: z.int(),
  title: z.string(),
  state: z.enum(['open', 'closed']),
  dueOn: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  closedAt: z.coerce.date().nullable(),
});

export type GitHubMilestone = z.infer<typeof GitHubMilestoneSchema>;

export const GitHubIssueSchema = z.object({
  id: z.string(),
  repoFullName: z.string(),
  number: z.int(),
  milestoneId: z.string().nullable(),
  title: z.string(),
  body: z.string().nullable(),
  state: z.enum(['open', 'closed']),
  assigneeLogin: z.string().nullable(),
  labels: z.array(z.string()),
  type: z.string().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  closedAt: z.coerce.date().nullable(),
});

export type GitHubIssue = z.infer<typeof GitHubIssueSchema>;

export const GitHubInstanceSchema = z.object({
  id: z.string().uuid(),
  baseUrl: z.string().url(),
  accessToken: z.string().min(1),
  repos: z.array(z.string()),
  // The org this connection reads. Nullable because instances created before
  // org scoping existed have none — health probing falls back to `/user` there.
  org: z.string().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export type GitHubInstance = z.infer<typeof GitHubInstanceSchema>;

export const CreateGitHubInstanceInputSchema = z.object({
  baseUrl: z.string().url().default('https://api.github.com'),
  accessToken: z.string().min(1),
  repos: z.array(z.string()).default([]),
});

export type CreateGitHubInstanceInput = z.infer<typeof CreateGitHubInstanceInputSchema>;

export const GitHubStatusMappingSchema = z.record(z.string(), z.string());
export type GitHubStatusMapping = z.infer<typeof GitHubStatusMappingSchema>;

export const DEFAULT_GITHUB_STATUS_MAPPING: GitHubStatusMapping = {
  open: 'In Progress',
  closed: 'Done',
};

export const GitHubSyncConfigSchema = z.object({
  id: z.string().uuid(),
  githubInstanceId: z.string().uuid(),
  repoFullName: z.string(),
  boardId: z.string().uuid(),
  targetGroupId: z.string().uuid().nullable(),
  allowedLabels: z.array(z.string()),
  allowedTypes: z.array(z.string()),
  includeClosedIssues: z.boolean(),
  defaultSyncedFields: z.array(z.string()),
  statusMapping: z.record(z.string(), z.string()).default({}),
  projectOwner: z.string().nullable(),
  projectNumber: z.int().nullable(),
  projectNodeId: z.string().nullable(),
  noStatusBoardStatusId: z.string().uuid().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export type GitHubSyncConfig = z.infer<typeof GitHubSyncConfigSchema>;

export const CreateGitHubSyncConfigInputSchema = z.object({
  githubInstanceId: z.string().uuid(),
  repoFullName: z.string().min(1),
  boardId: z.string().uuid(),
  targetGroupId: z.string().uuid().nullable().optional(),
  allowedLabels: z.array(z.string()).default([]),
  allowedTypes: z.array(z.string()).default([]),
  includeClosedIssues: z.boolean().default(false),
  defaultSyncedFields: z.array(z.string()).default(['name', 'description', 'status', 'owner']),
  statusMapping: GitHubStatusMappingSchema.default(DEFAULT_GITHUB_STATUS_MAPPING),
  projectOwner: z.string().nullable().optional(),
  projectNumber: z.int().nullable().optional(),
  projectNodeId: z.string().nullable().optional(),
  noStatusBoardStatusId: z.string().uuid().nullable().optional(),
});

export type CreateGitHubSyncConfigInput = z.infer<typeof CreateGitHubSyncConfigInputSchema>;

export const UpdateGitHubInstanceInputSchema = z.object({
  baseUrl: z.string().url().optional(),
  accessToken: z.string().min(1).optional(),
  repos: z.array(z.string()).optional(),
});

export type UpdateGitHubInstanceInput = z.infer<typeof UpdateGitHubInstanceInputSchema>;

export const UpdateGitHubSyncConfigInputSchema = z
  .object({
    allowedLabels: z.array(z.string()).optional(),
    allowedTypes: z.array(z.string()).optional(),
    includeClosedIssues: z.boolean().optional(),
    defaultSyncedFields: z.array(z.string()).optional(),
    statusMapping: GitHubStatusMappingSchema.optional(),
    projectOwner: z.string().nullable().optional(),
    projectNumber: z.int().nullable().optional(),
    projectNodeId: z.string().nullable().optional(),
    noStatusBoardStatusId: z.string().uuid().nullable().optional(),
  })
  .refine((data) => Object.values(data).some((v) => v !== undefined), {
    message: 'At least one field must be provided',
  });

export type UpdateGitHubSyncConfigInput = z.infer<typeof UpdateGitHubSyncConfigInputSchema>;

export const GitHubProjectSchema = z.object({
  nodeId: z.string(),
  owner: z.string(),
  number: z.int(),
  title: z.string(),
  ownerType: z.enum(['org', 'user']),
});
export type GitHubProject = z.infer<typeof GitHubProjectSchema>;

export const GitHubProjectStatusOptionSchema = z.object({
  optionId: z.string(),
  name: z.string(),
});
export type GitHubProjectStatusOption = z.infer<typeof GitHubProjectStatusOptionSchema>;

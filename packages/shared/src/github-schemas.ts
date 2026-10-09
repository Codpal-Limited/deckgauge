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
  // The org this connection reads. `''` — the column's default — means "none":
  // the picker then lists the token's own repositories and the health probe
  // falls back to `/user`. A non-null string because the column is one
  // (`org String @default("")`); this used to say `.nullable()`, which described
  // a value the database can never return.
  org: z.string(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export type GitHubInstance = z.infer<typeof GitHubInstanceSchema>;

/**
 * A GitHub organization login, as a connection stores it. Trimmed, and empty
 * means "no org". Deliberately permissive about the characters a login may hold
 * (GitHub Enterprise Server is not bound by github.com's rules); it refuses only
 * what can never be a login — whitespace and `/` — because the commonest
 * mistake is pasting `github.com/acme`, which would otherwise be stored and
 * surface later as a picker 404.
 */
const GitHubOrgLoginSchema = z
  .string()
  .trim()
  .max(100)
  .regex(/^[^\s/]*$/, 'Organization must be a GitHub organization login, e.g. "acme" — not a URL or path.');

export const CreateGitHubInstanceInputSchema = z.object({
  baseUrl: z.string().url().default('https://api.github.com'),
  accessToken: z.string().min(1),
  repos: z.array(z.string()).default([]),
  org: GitHubOrgLoginSchema.optional(),
});

export type CreateGitHubInstanceInput = z.infer<typeof CreateGitHubInstanceInputSchema>;

export const UpdateGitHubInstanceInputSchema = z.object({
  baseUrl: z.string().url().optional(),
  accessToken: z.string().min(1).optional(),
  repos: z.array(z.string()).optional(),
  /** `''` clears the org, returning the connection to token-wide listing. */
  org: GitHubOrgLoginSchema.optional(),
});

export type UpdateGitHubInstanceInput = z.infer<typeof UpdateGitHubInstanceInputSchema>;

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

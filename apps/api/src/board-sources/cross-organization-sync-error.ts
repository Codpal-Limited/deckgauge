/**
 * A board may only attach a provider sync from its own organization.
 *
 * `attach()` takes a caller-supplied sync id, so without this guard a member of
 * one organization could name another tenant's `JiraProjectSync` /
 * `GitHubRepoSync` / `AzureDevOpsProjectSync` / `GitLabProjectSync` and have
 * their issues, PRs and commits promoted onto a board they control — fetched,
 * before the Task 5 adapter guards, with that organization's stored credential.
 *
 * Thrown rather than returned so no caller can defeat it by forgetting to check
 * a boolean.
 *
 * Routes map it to **404, not 403**: a 403 would confirm the id exists somewhere,
 * turning the guard itself into an enumeration oracle. A refused foreign id must
 * be indistinguishable from an id that does not exist at all — which is also the
 * answer the caller is entitled to, since within their own tenant it truly does
 * not exist. Matches `SourceConnectionNotFoundError`'s 404 in source-adapters.ts.
 */
export class CrossOrganizationSyncError extends Error {
  constructor(provider: string, syncId: string) {
    super(`${provider} sync ${syncId} not found`);
    this.name = 'CrossOrganizationSyncError';
  }
}

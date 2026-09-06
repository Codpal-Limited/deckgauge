/**
 * The predicate every sync enumeration in `apps/worker` merges into its `where`.
 *
 * One exported constant rather than an inline `isDemo: false` at each site, so
 * `apps/worker/src/__isolation__/demo-instance-exclusion.test.ts` has a single
 * token to scan for — and so renaming the column is one edit rather than six.
 */
export const EXCLUDE_DEMO_INSTANCE = { isDemo: false } as const;

/**
 * The same exclusion reached through the parent. `GitHubRepoSync` carries no
 * `isDemo` of its own; the flag lives on the instance that owns it, exactly as
 * `organizationId` does.
 */
export const EXCLUDE_DEMO_REPO_SYNC = { githubInstance: { isDemo: false } } as const;

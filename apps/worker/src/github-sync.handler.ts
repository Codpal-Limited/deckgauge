import type { PrismaClient } from '@deckgauge/db';
import { EXCLUDE_DEMO_INSTANCE, EXCLUDE_DEMO_REPO_SYNC } from '@deckgauge/db';
import type { GitHubPort, GitHubProjectsPort } from '@deckgauge/shared';
import { normalizeRepoFullName } from '@deckgauge/shared';
import type { ChClientFactory } from './jira-dual-writer.js';
import { githubSyncProcessor } from './github-sync.processor.js';
import { resolveSyncJobScope } from './sync-job-scope.js';
import {
  createSyncPermission,
  filterSyncableInstances,
  type SyncPermission,
} from './sync-permission.js';

export interface GitHubSyncJobData {
  trigger?: string;
  /** When set, only sync this specific GitHub instance. */
  instanceId?: string;
  /** When set, sync only these repos instead of all repos on the instance. */
  repos?: string[];
  /**
   * The organization whose member asked for this sync.
   *
   * Set by the manual trigger routes from the caller's membership. Absence NEVER
   * means "every tenant" for a manual job — see `resolveSyncJobScope`, which refuses
   * a manual job naming no scope rather than sweeping. Scheduled and startup sweeps
   * legitimately omit it.
   */
  organizationId?: string;
}

export interface GitHubSyncJobResult {
  instance: string;
  status?: string;
  trigger?: string;
  milestoneCount?: number;
  issueCount?: number;
  finishedAt?: Date | null;
  errorMessage?: string | null;
  error?: string;
  skipped?: boolean;
}

export type GitHubAdapterFactory = (config: {
  baseUrl: string;
  accessToken: string;
}) => GitHubPort;

export type GitHubProjectsAdapterFactory = (config: {
  baseUrl: string;
  accessToken: string;
}) => GitHubProjectsPort;

export async function handleGitHubSyncJob(
  jobData: GitHubSyncJobData,
  db: PrismaClient,
  adapterFactory: GitHubAdapterFactory,
  projectsAdapterFactory?: GitHubProjectsAdapterFactory,
  /**
   * Builds a ClickHouse client bound to one organization. Called once per
   * instance below, with THAT instance's organizationId — the GitHub connections
   * this job iterates can belong to different tenants.
   */
  chClientFor?: ChClientFactory,
  /**
   * Whether each instance's organization may sync at all. Optional, and absent
   * means allow — the Community behaviour.
   */
  syncPermission: SyncPermission = createSyncPermission(null),
): Promise<GitHubSyncJobResult[]> {
  const trigger = jobData.trigger || 'scheduled';
  const scopedInstanceId = jobData.instanceId;
  const scopedRepos = jobData.repos;

  // The tenant boundary of this handler. `resolveSyncJobScope` is fail-closed: a
  // manual job that names no scope is refused here rather than sweeping every
  // organization's connections. See sync-trigger-tenancy.test.ts.
  const scope = resolveSyncJobScope(jobData);
  if (!scope.allowed) {
    console.error(`[GitHub sync] ${scope.reason}`);
    return [{ instance: 'none', skipped: true, error: scope.reason }];
  }

  // BOTH predicates, on the query. The instance narrowing used to happen only in the
  // loop below (`continue`), which meant an instance-scoped job still SELECTed every
  // tenant's row — and these rows carry the plaintext access token. Discarding a
  // credential after reading it is not scoping it.
  const instanceWhere = {
    ...EXCLUDE_DEMO_INSTANCE,
    ...(scope.organizationId ? { organizationId: scope.organizationId } : {}),
    ...(scopedInstanceId ? { id: scopedInstanceId } : {}),
  };
  const instances = await db.gitHubInstance.findMany({ where: instanceWhere });
  if (instances.length === 0) {
    console.log('No GitHub instances configured — skipping sync');
    return [{ instance: 'none', skipped: true }];
  }

  // BEFORE the loop — see the note in jira-sync.handler.ts. Deciding inside the
  // loop would mean the customer's GitHub token had already been used.
  const { syncable, skipped } = await filterSyncableInstances(instances, syncPermission);
  const results: GitHubSyncJobResult[] = skipped.map((instance) => {
    console.log(
      `[GitHub sync] skipping instance ${instance.id}: organization ${instance.organizationId} may not sync`,
    );
    return { instance: instance.id, skipped: true, trigger, status: 'billing_paused' };
  });

  for (const instance of syncable) {
    // If scoped to a specific instance, skip all others
    if (scopedInstanceId && instance.id !== scopedInstanceId) continue;

    // Determine which repos to sync (normalize in case of stored full URLs).
    //
    // New (P5) model: GitHubRepoSync rows are the source of truth — one row per
    // (instance, repoFullName). Fall back to instance.repos only when no repo-sync
    // rows exist at all (e.g. freshly bootstrapped before any sync row is created).
    let repos: string[];
    if (scopedRepos) {
      repos = scopedRepos.map(normalizeRepoFullName);
    } else {
      const repoSyncs = await db.gitHubRepoSync.findMany({
        where: { githubInstanceId: instance.id, ...EXCLUDE_DEMO_REPO_SYNC },
        select: { repoFullName: true },
      });
      const syncRepoNames = repoSyncs.map((rs) => rs.repoFullName);
      const sourceRepos =
        syncRepoNames.length > 0 ? syncRepoNames : (instance.repos as string[]);
      repos = sourceRepos.map(normalizeRepoFullName);
    }

    try {
      // Bind ClickHouse to the organization that owns THIS connection. Inside
      // the loop, never outside it: two instances here can belong to two
      // different tenants.
      const ch = chClientFor?.(instance.organizationId);

      const adapter = adapterFactory({
        baseUrl: instance.baseUrl,
        accessToken: instance.accessToken,
      });
      const projectsAdapter = projectsAdapterFactory?.({
        baseUrl: instance.baseUrl,
        accessToken: instance.accessToken,
      });

      // `organizationId` is the tenant of THIS connection, read inside the loop
      // for the same reason `ch` is — the instances iterated here can belong to
      // different organizations. It is stamped on the SyncRun the processor writes.
      const result = await githubSyncProcessor({
        adapter,
        projectsAdapter,
        repos,
        trigger,
        db,
        ch,
        instanceId: instance.id,
        organizationId: instance.organizationId,
      });
      results.push({
        instance: instance.id,
        status: result.status,
        trigger: result.trigger,
        milestoneCount: result.milestoneCount,
        issueCount: result.issueCount,
        finishedAt: result.finishedAt,
        errorMessage: result.errorMessage,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`GitHub sync failed for instance "${instance.id}": ${errorMessage}`);
      results.push({ instance: instance.id, status: 'FAILED', error: errorMessage });
    }
  }

  return results;
}

import type { PrismaClient } from '@deckgauge/db';
import type { GitHubPort, GitHubProjectsPort } from '@deckgauge/shared';
import { normalizeRepoFullName } from '@deckgauge/shared';
import type { ChClientFactory } from './jira-dual-writer.js';
import { githubSyncProcessor } from './github-sync.processor.js';

export interface GitHubSyncJobData {
  trigger?: string;
  /** When set, only sync this specific GitHub instance. */
  instanceId?: string;
  /** When set, sync only these repos instead of all repos on the instance. */
  repos?: string[];
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
): Promise<GitHubSyncJobResult[]> {
  const trigger = jobData.trigger || 'scheduled';
  const scopedInstanceId = jobData.instanceId;
  const scopedRepos = jobData.repos;

  const instances = await db.gitHubInstance.findMany();
  if (instances.length === 0) {
    console.log('No GitHub instances configured — skipping sync');
    return [{ instance: 'none', skipped: true }];
  }

  const results: GitHubSyncJobResult[] = [];

  for (const instance of instances) {
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
        where: { githubInstanceId: instance.id },
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

      const result = await githubSyncProcessor({ adapter, projectsAdapter, repos, trigger, db, ch });
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

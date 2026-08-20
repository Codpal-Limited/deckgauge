// EI-014 — gitlab-sync BullMQ job handler.
import { PrismaClient } from '@deckgauge/db';
import type {
  GitLabPrPort,
  GitLabCommitPort,
  GitLabIssuePort,
  GitLabMergeRequestRow,
  GitLabReviewRow,
  GitLabCommitRow,
  GitLabIssueRow,
} from '@deckgauge/shared';
import { processGitLabSync } from './gitlab-sync.processor.js';

export interface GitLabSyncJobData {
  trigger: 'manual' | 'scheduled' | 'startup';
  instanceId?: string;
  projectPaths?: string[];
}

export type GitLabPrAdapterFactory = (cfg: {
  accessToken: string;
  baseUrl?: string;
  instanceId: string;
}) => GitLabPrPort;

export type GitLabCommitAdapterFactory = (cfg: {
  accessToken: string;
  baseUrl?: string;
  instanceId: string;
}) => GitLabCommitPort;

export type GitLabIssueAdapterFactory = (cfg: {
  accessToken: string;
  baseUrl?: string;
  instanceId: string;
}) => GitLabIssuePort;

export interface GitLabSyncResult {
  instancesProcessed: number;
  projectsProcessed: number;
  mergeRequestsWritten: number;
  reviewsWritten: number;
  commitsWritten: number;
  issuesWritten: number;
  errors: Array<{ instanceId: string; projectPath: string; message: string }>;
}

export interface ChClient {
  insertRows(table: string, rows: ReadonlyArray<Record<string, unknown>>): Promise<void>;
}

/**
 * Builds a ClickHouse client bound to one organization. See jira-dual-writer.ts
 * for why handlers take the factory rather than a client: the instances this
 * handler loops over can belong to different tenants, and `organization_id` is a
 * sort-key column ClickHouse cannot correct afterwards.
 */
export type ChClientFactory = (organizationId: string) => ChClient;

export async function handleGitLabSyncJob(
  job: GitLabSyncJobData,
  db: PrismaClient,
  prAdapterFactory: GitLabPrAdapterFactory,
  commitAdapterFactory: GitLabCommitAdapterFactory,
  issueAdapterFactory: GitLabIssueAdapterFactory,
  /**
   * Builds a ClickHouse client bound to one organization. Called once per
   * instance below, with THAT instance's organizationId — the GitLab connections
   * this job iterates can belong to different tenants.
   */
  chClientFor: ChClientFactory,
): Promise<GitLabSyncResult> {
  const result: GitLabSyncResult = {
    instancesProcessed: 0,
    projectsProcessed: 0,
    mergeRequestsWritten: 0,
    reviewsWritten: 0,
    commitsWritten: 0,
    issuesWritten: 0,
    errors: [],
  };

  const where: Record<string, unknown> = {};
  if (job.instanceId) where.gitlabInstanceId = job.instanceId;

  const projectSyncs = await db.gitLabProjectSync.findMany({
    where,
    include: { gitlabInstance: true },
  });

  const filtered = job.projectPaths
    ? projectSyncs.filter((ps) => job.projectPaths!.includes(ps.projectPath))
    : projectSyncs;

  const byInstance = new Map<string, typeof filtered>();
  for (const ps of filtered) {
    const list = byInstance.get(ps.gitlabInstanceId) ?? [];
    list.push(ps);
    byInstance.set(ps.gitlabInstanceId, list);
  }

  for (const [instanceId, syncs] of byInstance.entries()) {
    result.instancesProcessed++;
    const instance = syncs[0]!.gitlabInstance;
    // Bind ClickHouse to the organization that owns THIS connection. Inside the
    // loop, never outside it: merge requests, reviews, commits and issues from a
    // second instance on another tenant must be written under that tenant.
    const ch = chClientFor(instance.organizationId);
    const prAdapter = prAdapterFactory({
      accessToken: instance.accessToken,
      baseUrl: instance.baseUrl,
      instanceId,
    });
    const commitAdapter = commitAdapterFactory({
      accessToken: instance.accessToken,
      baseUrl: instance.baseUrl,
      instanceId,
    });
    const issueAdapter = issueAdapterFactory({
      accessToken: instance.accessToken,
      baseUrl: instance.baseUrl,
      instanceId,
    });

    for (const ps of syncs) {
      try {
        const sinceMrs = ps.lastSyncedAt ?? undefined;
        const { mergeRequestsWritten, reviewsWritten, commitsWritten, issuesWritten } =
          await processGitLabSync({
            projectPath: ps.projectPath,
            since: sinceMrs,
            syncCommits: ps.syncCommits,
            prAdapter,
            commitAdapter,
            issueAdapter,
            onMergeRequests: (rows) =>
              ch.insertRows(
                'gitlab_merge_requests',
                rows as unknown as Array<Record<string, unknown>>,
              ),
            onReviews: (rows) =>
              ch.insertRows('gitlab_reviews', rows as unknown as Array<Record<string, unknown>>),
            onCommits: (rows) =>
              ch.insertRows('gitlab_commits', rows as unknown as Array<Record<string, unknown>>),
            onIssues: (rows) =>
              ch.insertRows('gitlab_issues', rows as unknown as Array<Record<string, unknown>>),
          });
        result.mergeRequestsWritten += mergeRequestsWritten;
        result.reviewsWritten += reviewsWritten;
        result.commitsWritten += commitsWritten;
        result.issuesWritten += issuesWritten;

        await db.gitLabProjectSync.update({
          where: { id: ps.id },
          data: { lastSyncedAt: new Date() },
        });
        result.projectsProcessed++;
      } catch (err) {
        result.errors.push({
          instanceId,
          projectPath: ps.projectPath,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return result;
}

export type { GitLabMergeRequestRow, GitLabReviewRow, GitLabCommitRow, GitLabIssueRow };

// Fan-out consumer for the `github-intelligence-sync` queue.
//
// The api enqueues onto this queue from the manual "Sync" button
// (board-sync.service + POST /intelligence/sync) with job data
// `{ trigger, instanceId?, repos? }`. Without a worker consumer those jobs
// pile up in `wait` forever and github_commits/github_pull_requests never
// refresh on demand — the scheduled three-tier queues are the only writers.
// This mirrors the Jira/ADO intelligence-sync consumers: resolve the target
// GitHubRepoSync rows and run the per-repo `runIntelligenceSync` for each,
// isolating a failing repo so the rest still sync.
import { PrismaClient } from '@deckgauge/db';
import { RateLimiter } from './github-rate-limiter.js';
import {
  runIntelligenceSync,
  type ChClientFactory,
  type OctokitLike,
  type RunIntelligenceSyncDeps,
} from './github-intelligence-sync.handler.js';

export interface GithubIntelligenceJobData {
  trigger: 'manual' | 'scheduled' | 'startup';
  instanceId?: string;
  repos?: string[];
}

export interface GithubIntelligenceResult {
  reposProcessed: number;
  errors: Array<{ repoFullName: string; message: string }>;
}

// Builds a per-instance Octokit-like client. Real Octokit is constructed in the
// worker entrypoint; injected here so the fan-out stays free of @octokit/rest.
export type GithubOctokitFactory = (instance: {
  accessToken: string;
  baseUrl: string | null;
}) => OctokitLike;

// The per-repo runner. Defaults to the real `runIntelligenceSync`; injectable so
// the fan-out can be unit-tested without a full Octokit/ClickHouse fake per repo.
export type PerRepoRunner = (deps: RunIntelligenceSyncDeps, repoSyncId: string) => Promise<void>;

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function handleGithubIntelligenceSync(
  job: GithubIntelligenceJobData,
  db: PrismaClient,
  octokitFactory: GithubOctokitFactory,
  rateLimiter: RateLimiter,
  /**
   * Forwarded to the per-repo runner untouched. The repos this fans out over can
   * belong to different tenants, so the runner binds the factory to the
   * organization owning each repo's GitHub instance rather than the fan-out
   * choosing one here.
   */
  chClientFor: ChClientFactory,
  runOne: PerRepoRunner = runIntelligenceSync,
): Promise<GithubIntelligenceResult> {
  const result: GithubIntelligenceResult = { reposProcessed: 0, errors: [] };

  const where: Record<string, unknown> = { disabledAt: null };
  if (job.instanceId) where.githubInstanceId = job.instanceId;
  if (job.repos && job.repos.length > 0) where.repoFullName = { in: job.repos };

  const syncs = await db.gitHubRepoSync.findMany({ where, include: { githubInstance: true } });

  // A manual sync may overlap a scheduled tier job for the same repo (the
  // unscoped POST /intelligence/sync path fans out over every active repo).
  // That's safe: the ClickHouse tables are ReplacingMergeTrees keyed by row id,
  // so duplicate inserts dedup on merge, and runIntelligenceSync only advances
  // a watermark after its batch succeeds, so a lost race just re-fetches a small
  // window next run.
  for (const sync of syncs) {
    try {
      const octokit = octokitFactory(sync.githubInstance);
      await runOne({ prisma: db, octokit, rateLimiter, chClientFor }, sync.id);
      result.reposProcessed += 1;
    } catch (e) {
      result.errors.push({ repoFullName: sync.repoFullName, message: errMsg(e) });
    }
  }

  return result;
}

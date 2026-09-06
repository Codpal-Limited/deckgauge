import { EXCLUDE_DEMO_REPO_SYNC } from '@deckgauge/db';

// Startup reconciliation for GitHub per-repo intelligence backfills.
//
// Per-repo backfill jobs are normally enqueued by the api's bulkBind when a
// repo is attached to a board. If that enqueue ever fails to reach the
// three-tier queues — e.g. the api booted without REDIS_URL and fell back to
// the no-op queue client, or a repo's earlier backfill never completed
// because inserts were erroring — the repo is left with backfillCompleteAt
// NULL and no scheduled job, so its commits/PRs are never pulled.
//
// This reconciler re-enqueues an initial backfill for every active repo that
// has not completed one. enqueueInitialBackfill is idempotent — BullMQ keys
// the repeatable on its repeat options + jobId, so a duplicate add updates the
// existing schedule instead of creating a second one — making it safe to run
// on every worker boot. backfillCompleteAt is only set on a fully clean run
// (see github-intelligence-sync.handler), so a healthy repo drops out of this
// set after its first success; a repo that keeps failing is retried each boot,
// which is bounded by the shared GitHub rate limiter.

type Tier = 'hot' | 'warm' | 'cold';

const VALID_TIERS: ReadonlySet<string> = new Set<Tier>(['hot', 'warm', 'cold']);

export interface BackfillQueueClient {
  enqueueInitialBackfill(repoSyncId: string, tier: Tier): Promise<void>;
}

// Minimal structural view of the Prisma client — just the one query we need.
// Keeps the reconciler trivially testable without a full PrismaClient.
export interface RepoSyncFinder {
  gitHubRepoSync: {
    findMany(args: {
      where: { disabledAt: null; backfillCompleteAt: null; githubInstance?: { isDemo: boolean } };
      select: { id: true; tier: true };
    }): Promise<Array<{ id: string; tier: string }>>;
  };
}

export async function reconcileGitHubBackfills(deps: {
  prisma: RepoSyncFinder;
  queueClient: BackfillQueueClient;
  log?: (message: string) => void;
}): Promise<{ enqueued: number }> {
  const pending = await deps.prisma.gitHubRepoSync.findMany({
    where: { disabledAt: null, backfillCompleteAt: null, ...EXCLUDE_DEMO_REPO_SYNC },
    select: { id: true, tier: true },
  });

  let enqueued = 0;
  for (const repo of pending) {
    const tier: Tier = VALID_TIERS.has(repo.tier) ? (repo.tier as Tier) : 'cold';
    await deps.queueClient.enqueueInitialBackfill(repo.id, tier);
    enqueued += 1;
  }

  if (enqueued > 0) {
    deps.log?.(`[GitHub backfill reconciler] enqueued ${enqueued} pending repo sync(s)`);
  }
  return { enqueued };
}

// Startup reconciliation for GitHub per-repo SCHEDULES (distinct from backfills).
//
// The three-tier repeatable schedules live only in Redis and are created by the
// api's bulkBind when a repo is attached. Redis here is RDB-only and is
// recreated on deploys, so a deploy can wipe every repeatable. The backfill
// reconciler above only re-creates schedules for repos with backfillCompleteAt
// NULL, so an already-backfilled repo whose schedule was wiped is never healed
// and its scheduled sync dies silently (observed: all tiers empty after a
// mid-July deploy). This ensures a repeatable for EVERY active repo on boot.
// ensureScheduled is idempotent and fires no immediate run, so it is safe to
// call for all repos on every boot.
export interface ScheduleQueueClient {
  ensureScheduled(repoSyncId: string, tier: Tier): Promise<void>;
}

export interface ActiveRepoFinder {
  gitHubRepoSync: {
    findMany(args: {
      where: { disabledAt: null; githubInstance?: { isDemo: boolean } };
      select: { id: true; tier: true };
    }): Promise<Array<{ id: string; tier: string }>>;
  };
}

export async function reconcileGitHubSchedules(deps: {
  prisma: ActiveRepoFinder;
  queueClient: ScheduleQueueClient;
  log?: (message: string) => void;
}): Promise<{ ensured: number }> {
  const active = await deps.prisma.gitHubRepoSync.findMany({
    where: { disabledAt: null, ...EXCLUDE_DEMO_REPO_SYNC },
    select: { id: true, tier: true },
  });

  let ensured = 0;
  for (const repo of active) {
    const tier: Tier = VALID_TIERS.has(repo.tier) ? (repo.tier as Tier) : 'cold';
    await deps.queueClient.ensureScheduled(repo.id, tier);
    ensured += 1;
  }

  if (ensured > 0) {
    deps.log?.(`[GitHub schedule reconciler] ensured ${ensured} repeatable schedule(s)`);
  }
  return { ensured };
}

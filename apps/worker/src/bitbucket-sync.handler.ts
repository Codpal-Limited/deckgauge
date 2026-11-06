// Bitbucket Cloud — bitbucket-sync BullMQ job handler. Mirrors gitlab-sync.handler.ts:
// fail-closed tenancy, per-organization sync permission and ClickHouse client,
// per-repository error capture, watermarks stamped only on success.
import type { PrismaClient } from '@deckgauge/db';
import type {
  BitbucketPrPort,
  BitbucketCommitPort,
  BitbucketDeploymentPort,
} from '@deckgauge/shared';
import { processBitbucketSync, processBitbucketDeployments } from './bitbucket-sync.processor.js';
import { resolveSyncJobScope } from './sync-job-scope.js';
import { createSyncPermission, type SyncPermission } from './sync-permission.js';

/** First-sync window for PRs and commits (spec § Decisions, "Backfill"). */
export const BITBUCKET_PR_BACKFILL_DAYS = 180;
/** First-sync window for deployments (spec § Decisions, "Backfill"). */
export const BITBUCKET_DEPLOYMENT_BACKFILL_DAYS = 90;
/**
 * How far BEFORE `lastDeploymentSyncAt` an incremental run re-reads.
 *
 * The deployment adapter windows on `state.started_on`. A deployment that was
 * IN_PROGRESS at the previous run started before that run's watermark, so a
 * window starting exactly at the watermark would never see it complete — and an
 * in-progress production deploy never becoming SUCCESSFUL is precisely a missing
 * DORA deployment. The table is a ReplacingMergeTree keyed on deployment_uuid, so
 * re-reading a day is idempotent.
 */
export const BITBUCKET_DEPLOYMENT_OVERLAP_MS = 24 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface BitbucketSyncJobData {
  trigger: 'manual' | 'scheduled' | 'startup';
  /** Narrows to one connection. Set by the per-board path. */
  instanceId?: string;
  /** Narrows to these `{workspace}/{repo_slug}` names within the scope. */
  repoFullNames?: string[];
  /** The organization whose member asked for this sync (manual routes). */
  organizationId?: string;
}

export interface BitbucketFactoryConfig {
  instanceId: string;
  email: string;
  apiToken: string;
  workspace: string;
}

/**
 * Everything one instance needs, built ONCE per instance per job from ONE client:
 * the spec requires sequential requests per instance, and the main-branch cache
 * belongs to exactly this lifetime.
 */
export interface BitbucketAdapters {
  pr: BitbucketPrPort;
  commit: BitbucketCommitPort;
  deployment: BitbucketDeploymentPort;
  /** The repository's main branch, or null for an empty repository. */
  mainBranch(repoFullName: string): Promise<string | null>;
}

export type BitbucketAdapterFactory = (cfg: BitbucketFactoryConfig) => BitbucketAdapters;

export interface ChClient {
  insertRows(table: string, rows: ReadonlyArray<Record<string, unknown>>): Promise<void>;
}

/** See gitlab-sync.handler.ts: bound per instance, to that instance's organization. */
export type ChClientFactory = (organizationId: string) => ChClient;

export type BitbucketSyncPhase = 'scope' | 'prs-commits' | 'deployments';

export interface BitbucketSyncError {
  instanceId: string;
  repoFullName: string;
  phase: BitbucketSyncPhase;
  message: string;
}

export interface BitbucketSyncResult {
  instancesProcessed: number;
  reposProcessed: number;
  pullRequestsWritten: number;
  reviewsWritten: number;
  commitsWritten: number;
  deploymentsWritten: number;
  errors: BitbucketSyncError[];
  /** Instances whose organization may not sync. A refusal, not a failure. */
  skippedInstances: string[];
}

export interface BitbucketSyncOptions {
  now?: () => Date;
}

function redact(message: string, secret: string): string {
  return secret ? message.split(secret).join('[redacted]') : message;
}

function errorMessage(err: unknown, secret: string): string {
  return redact(err instanceof Error ? err.message : String(err), secret);
}

export async function handleBitbucketSyncJob(
  job: BitbucketSyncJobData,
  db: PrismaClient,
  adapterFactory: BitbucketAdapterFactory,
  chClientFor: ChClientFactory,
  /** Absent means allow — the Community behaviour. */
  syncPermission: SyncPermission = createSyncPermission(null),
  options: BitbucketSyncOptions = {},
): Promise<BitbucketSyncResult> {
  const now = options.now ?? (() => new Date());
  const result: BitbucketSyncResult = {
    instancesProcessed: 0,
    reposProcessed: 0,
    pullRequestsWritten: 0,
    reviewsWritten: 0,
    commitsWritten: 0,
    deploymentsWritten: 0,
    errors: [],
    skippedInstances: [],
  };

  // The tenant boundary, fail-closed: a manual job naming no scope is refused
  // rather than loading every organization's repo syncs (and their tokens).
  const scope = resolveSyncJobScope(job);
  if (!scope.allowed) {
    console.error(`[Bitbucket sync] ${scope.reason}`);
    result.errors.push({ instanceId: 'none', repoFullName: '-', phase: 'scope', message: scope.reason });
    return result;
  }

  // `BitbucketRepoSync` inherits its organization through the parent instance, so
  // the tenant predicate is a relation filter — the GitLab shape.
  const where: Record<string, unknown> = {};
  if (job.instanceId) where.bitbucketInstanceId = job.instanceId;
  if (scope.organizationId) where.bitbucketInstance = { organizationId: scope.organizationId };

  const repoSyncs = await db.bitbucketRepoSync.findMany({
    where,
    include: { bitbucketInstance: true },
  });

  const filtered = job.repoFullNames
    ? repoSyncs.filter((rs) => job.repoFullNames!.includes(rs.repoFullName))
    : repoSyncs;

  // BEFORE grouping, so a paused organization's token never reaches a factory.
  const syncable: typeof filtered = [];
  const skippedIds = new Set<string>();
  for (const rs of filtered) {
    if (await syncPermission.allowed(rs.bitbucketInstance.organizationId)) {
      syncable.push(rs);
    } else if (!skippedIds.has(rs.bitbucketInstanceId)) {
      skippedIds.add(rs.bitbucketInstanceId);
      console.log(
        `[Bitbucket sync] skipping instance ${rs.bitbucketInstanceId}: organization ${rs.bitbucketInstance.organizationId} may not sync`,
      );
    }
  }
  result.skippedInstances = [...skippedIds];

  const byInstance = new Map<string, typeof syncable>();
  for (const rs of syncable) {
    const list = byInstance.get(rs.bitbucketInstanceId) ?? [];
    list.push(rs);
    byInstance.set(rs.bitbucketInstanceId, list);
  }

  for (const [instanceId, syncs] of byInstance.entries()) {
    result.instancesProcessed++;
    const instance = syncs[0]!.bitbucketInstance;
    const secret = instance.apiToken;
    // Inside the loop: rows from a second instance on another tenant are written
    // under THAT tenant.
    const ch = chClientFor(instance.organizationId);
    const adapters = adapterFactory({
      instanceId,
      email: instance.email,
      apiToken: instance.apiToken,
      workspace: instance.workspace,
    });

    // Ticket prefixes: the union, over every board consuming each repo sync, of the
    // board's `ticketKeyPrefixes` AND the keys of the Jira projects attached to it
    // (precedent for the first: ado-intelligence-sync.handler.ts). The Jira keys
    // are what make linking work with no setup — a team that attached project RND
    // has said its tickets are RND-…, and the extractor matches ONLY configured
    // prefixes, so `[]` links nothing at all.
    const prefixesByRepoSync = new Map<string, Set<string>>();
    try {
      const sources = await db.boardBitbucketSource.findMany({
        where: { bitbucketRepoSyncId: { in: syncs.map((s) => s.id) } },
        select: {
          bitbucketRepoSyncId: true,
          board: {
            select: {
              ticketKeyPrefixes: true,
              boardJiraSources: { select: { jiraProjectSync: { select: { jiraProjectKey: true } } } },
            },
          },
        },
      });
      for (const src of sources) {
        const set = prefixesByRepoSync.get(src.bitbucketRepoSyncId) ?? new Set<string>();
        for (const p of src.board.ticketKeyPrefixes) set.add(p);
        for (const j of src.board.boardJiraSources ?? []) set.add(j.jiraProjectSync.jiraProjectKey);
        prefixesByRepoSync.set(src.bitbucketRepoSyncId, set);
      }
    } catch (err) {
      // Not fatal: syncing without prefixes loses this run's Jira links (the
      // extractor matches only configured prefixes) but keeps every PR, commit and
      // deployment — failing every repo of the instance over a lookup is worse.
      console.warn(
        `[Bitbucket sync] board prefix lookup failed for instance ${instanceId}: ${errorMessage(err, secret)}`,
      );
    }

    for (const rs of syncs) {
      const startedAt = now();
      const ticketPrefixes = [...(prefixesByRepoSync.get(rs.id) ?? [])];
      let failed = false;

      if (rs.syncPrs || rs.syncCommits) {
        try {
          const since =
            rs.lastSyncedAt ?? new Date(startedAt.getTime() - BITBUCKET_PR_BACKFILL_DAYS * DAY_MS);
          const written = await processBitbucketSync({
            repoFullName: rs.repoFullName,
            since,
            syncPrs: rs.syncPrs,
            syncCommits: rs.syncCommits,
            resolveMainBranch: () => adapters.mainBranch(rs.repoFullName),
            ticketPrefixes,
            prAdapter: adapters.pr,
            commitAdapter: adapters.commit,
            onPullRequests: (rows) =>
              ch.insertRows('bitbucket_pull_requests', rows as unknown as Array<Record<string, unknown>>),
            onReviews: (rows) =>
              ch.insertRows('bitbucket_reviews', rows as unknown as Array<Record<string, unknown>>),
            onCommits: (rows) =>
              ch.insertRows('bitbucket_commits', rows as unknown as Array<Record<string, unknown>>),
          });
          result.pullRequestsWritten += written.pullRequestsWritten;
          result.reviewsWritten += written.reviewsWritten;
          result.commitsWritten += written.commitsWritten;
          // The START of the run, not its end: a PR updated while we were paging
          // must still be inside the next window.
          await db.bitbucketRepoSync.update({
            where: { id: rs.id },
            data: { lastSyncedAt: startedAt },
          });
        } catch (err) {
          failed = true;
          result.errors.push({
            instanceId,
            repoFullName: rs.repoFullName,
            phase: 'prs-commits',
            message: errorMessage(err, secret),
          });
        }
      }

      if (rs.syncDeployments) {
        try {
          const since = rs.lastDeploymentSyncAt
            ? new Date(rs.lastDeploymentSyncAt.getTime() - BITBUCKET_DEPLOYMENT_OVERLAP_MS)
            : new Date(startedAt.getTime() - BITBUCKET_DEPLOYMENT_BACKFILL_DAYS * DAY_MS);
          const { deploymentsWritten } = await processBitbucketDeployments({
            repoFullName: rs.repoFullName,
            since,
            deploymentAdapter: adapters.deployment,
            onDeployments: (rows) =>
              ch.insertRows('bitbucket_deployments', rows as unknown as Array<Record<string, unknown>>),
          });
          result.deploymentsWritten += deploymentsWritten;
          await db.bitbucketRepoSync.update({
            where: { id: rs.id },
            data: { lastDeploymentSyncAt: startedAt },
          });
        } catch (err) {
          failed = true;
          result.errors.push({
            instanceId,
            repoFullName: rs.repoFullName,
            phase: 'deployments',
            message: errorMessage(err, secret),
          });
        }
      }

      if (!failed) result.reposProcessed++;
    }
  }

  return result;
}

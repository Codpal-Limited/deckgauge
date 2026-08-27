// EI-015 — ADO intelligence sync (additive dual-write, Phase 3).
// Iterates azure_devops_project_syncs rows; for each picked sync_repos[] entry
// fetches PRs+reviews (when syncPrs=true) and commits (when syncCommits=true).
// Strict opt-in: nothing syncs unless syncAllRepos is true (pick every repo the
// project returns, incl. future repos) OR sync_repos[] lists explicit repo names.
//
// Each repo is fetched and persisted INDEPENDENTLY, with its own watermark
// (ado_repo_sync_states). A large project (50+ repos, tens of thousands of
// PRs) used to fetch all repos under one try/catch and only
// advanced a single project-level watermark at the very end — so any transient
// `fetch failed` aborted the whole project, wrote nothing, and never advanced
// the watermark, leaving it re-fetching from scratch and never completing. Now a
// failing repo is isolated and retried in place next run while healthy repos
// make monotonic progress. Upstream fetches go through resilientFetchJson
// (per-attempt timeout covering the body read + bounded retry) so transient
// blips self-heal and a stalled response body can't hang the worker.
import { PrismaClient } from '@deckgauge/db';
import {
  resilientFetchJson,
  type AdoPrPort,
  type AdoCommitPort,
  type AdoDeploymentPort,
  type Throttle,
} from '@deckgauge/shared';
import { resolveSyncJobScope } from './sync-job-scope.js';

export interface AdoIntelligenceJobData {
  trigger: 'manual' | 'scheduled' | 'startup';
  instanceId?: string;
  projects?: string[];
  /**
   * The organization whose admin asked for this sync — REQUIRED for a `manual` job.
   * Reached by `POST /intelligence/sync`, whose `ADMIN` policy admits an ORGANIZATION
   * admin, so this is what stops one tenant spending every other tenant's ADO PATs.
   * Built by `manualSyncJobPayload` in @deckgauge/shared.
   */
  organizationId?: string;
}

export interface AdoFactoryConfig {
  orgUrl: string;
  authMethod: 'PAT' | 'BASIC';
  accessToken: string;
  username?: string;
  instanceId: string;
}

export type AdoPrFactory = (cfg: AdoFactoryConfig) => AdoPrPort;
export type AdoCommitFactory = (cfg: AdoFactoryConfig) => AdoCommitPort;
export type AdoDeploymentFactory = (cfg: AdoFactoryConfig) => AdoDeploymentPort;

export interface ChClient {
  insertRows(table: string, rows: ReadonlyArray<Record<string, unknown>>): Promise<void>;
}

/**
 * Builds a ClickHouse client bound to one organization. See jira-dual-writer.ts
 * for why handlers take the factory rather than a client: the instances this
 * handler loops over can belong to different tenants, and `organization_id` is
 * a sort-key column ClickHouse cannot correct afterwards.
 */
export type ChClientFactory = (organizationId: string) => ChClient;

export interface AdoIntelligenceResult {
  instancesProcessed: number;
  projectsProcessed: number;
  reposProcessed: number;
  pullRequestsWritten: number;
  reviewsWritten: number;
  commitsWritten: number;
  /** Repos that got a backward backfill chunk this run (see backfillConfig). */
  backfillReposProcessed: number;
  backfillPullRequestsWritten: number;
  backfillCommitsWritten: number;
  /** Real deployment records written (classic Release pipeline deployments). */
  deploymentsWritten: number;
  errors: Array<{ instanceId: string; project: string; repo?: string; message: string }>;
}

interface RepoSummary { id: string; name: string; defaultBranch?: string }
interface RepoInfo { id: string; defaultBranch?: string }

const DAY_MS = 24 * 60 * 60 * 1000;

// Backward-walking history backfill.
//
// lastPrSyncAt / lastCommitSyncAt only ever move forward, so once they have
// advanced past a hole in history nothing re-reads it — which is exactly the
// state the ADO tables were left in (ClickHouse held only the current month for
// ado_pull_requests / ado_commits while ADO itself still had a year of PRs).
// Each run pulls ONE bounded chunk older than the repo's backfill cursor and
// moves the cursor back, so a long history fills in over many runs without any
// single fetch risking the per-repo timeout.
//
// OFF by default: it multiplies ADO request volume (this org has ~180 opted-in
// repos, and the PR path costs 3 calls per PR), and ADO has throttled this
// account before. Enable deliberately, per the same strict-opt-in stance the
// rest of ADO intel takes. Read at call time so it is tunable without a rebuild.
interface BackfillConfig {
  enabled: boolean;
  chunkDays: number;
  floorDays: number;
  reposPerRun: number;
}

// Treat an EMPTY value as unset. docker-compose passes these through as
// `${VAR:-}`, so an unconfigured knob arrives as '' rather than undefined — and
// Number('') is 0, which for reposPerRun is a legitimate value meaning "no repos
// this run". That collision silently disabled the whole backfill after it had
// been switched on and verified as visible to the container.
function envInt(name: string): number | null {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function backfillConfig(): BackfillConfig {
  const reposPerRun = envInt('ADO_BACKFILL_REPOS_PER_RUN');
  return {
    enabled: process.env.ADO_BACKFILL_ENABLED === '1',
    chunkDays: envInt('ADO_BACKFILL_CHUNK_DAYS') ?? 30,
    floorDays: envInt('ADO_BACKFILL_FLOOR_DAYS') ?? 365,
    // 0 is honoured when explicitly set (a kill switch that keeps the flag on).
    reposPerRun: reposPerRun !== null && reposPerRun >= 0 ? reposPerRun : 5,
  };
}

interface BackfillCandidate {
  repoId: string;
  /** How far back history has already been filled; null = not started. */
  cursor: Date | null;
}

/**
 * Pick which repos get a backfill chunk this run.
 *
 * Ordered so every repo gets its FIRST chunk before any repo gets its second
 * (nulls first, then newest cursor first — a newer cursor means less history
 * covered). That keeps the fill breadth-first: all boards gain recent history
 * together instead of one repo being walked back a year while others sit empty.
 * Repos already filled to the floor are skipped.
 */
export function selectBackfillRepos(
  candidates: BackfillCandidate[],
  floor: Date,
  limit: number,
): Set<string> {
  const eligible = candidates.filter((c) => c.cursor === null || c.cursor.getTime() > floor.getTime());
  eligible.sort((a, b) => {
    if (a.cursor === null && b.cursor === null) return 0;
    if (a.cursor === null) return -1;
    if (b.cursor === null) return 1;
    return b.cursor.getTime() - a.cursor.getTime();
  });
  return new Set(eligible.slice(0, limit).map((c) => c.repoId));
}

// Commit sync only pulls branches with activity in this window (the default
// branch is always included). Keeps a 2,000+ branch repo from fetching every
// dead feature branch — and, on a first run with no watermark, bounds the
// commit backfill to a recent window instead of every branch's full history
// (which is unbounded and never completes inside the job lock on a large repo).
const ACTIVE_BRANCH_DAYS = 90;

// How far back a repo's FIRST PR sweep reaches. Mirrors ACTIVE_BRANCH_DAYS above,
// for the same reason and now on the same schedule.
//
// A repo with no watermark used to be fetched with no time filter at all — every
// PR ever, each costing ~3 requests (list page, threads, work-item links). On a
// large repo that never finishes inside the per-repo timeout, and the throw is
// caught ABOVE the watermark upsert, so no sync-state row is written. The next
// pass then has no watermark either: unbounded sweep, timeout, no row, forever.
// A repo with 1,000+ PRs sat in that loop and had never been ingested once,
// burning ~4 minutes of ADO budget every pass for zero rows.
//
// It could not even reach its own remedy: the backfill only considers repos that
// already HAVE a state row, so the bounded-chunk walk built for exactly this was
// locked behind the row the repo could never create.
//
// Bounding the first sweep guarantees it terminates, so the watermark is written
// and the repo starts making monotonic progress. History older than the window
// is then the backfill's job — the same split the rest of this file already
// assumes: forward owns [since, now), backfill owns [floor, since).
const FIRST_PR_SYNC_DAYS = 90;

// Hard ceiling on how long a SINGLE repo's PR/commit fetch may run before it is
// abandoned and isolated (caught by the per-repo try/catch below). Without this,
// one pathological repo — e.g. a huge repo whose first run has no watermark and
// backfills every PR ever — can hang the fetch indefinitely, wedging the whole
// sequential run so no later repo/project completes and lastSyncedAt is never
// stamped, jamming the BullMQ intel queue behind it. Overridable via env for ops
// tuning; default 4 min is generous for a large-but-terminating repo. Read at
// call time (not module load) so ADO_REPO_INTEL_TIMEOUT_MS can be tuned without
// a rebuild and tests can inject a tiny value.
const DEFAULT_REPO_INTEL_TIMEOUT_MS = 4 * 60 * 1000;
function repoIntelTimeoutMs(): number {
  return Number(process.env.ADO_REPO_INTEL_TIMEOUT_MS) || DEFAULT_REPO_INTEL_TIMEOUT_MS;
}

// Reject if `p` has not settled within `ms`. Note: this does not cancel the
// underlying fetch (the ports take no AbortSignal today) — it unblocks the loop
// so the run makes progress; the abandoned fetch is retried from the same
// untouched watermark next run. Threading an AbortSignal is a future refinement.
function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

async function listReposByName(
  cfg: AdoFactoryConfig,
  project: string,
  throttle?: Throttle,
): Promise<Map<string, RepoInfo>> {
  const orgUrl = cfg.orgUrl.replace(/\/+$/, '');
  const projectEnc = encodeURIComponent(project);
  const raw = cfg.authMethod === 'BASIC' ? `${cfg.username ?? ''}:${cfg.accessToken}` : `:${cfg.accessToken}`;
  const auth = `Basic ${Buffer.from(raw).toString('base64')}`;
  // Paced like every other ADO call — this one runs once per project per pass
  // and would otherwise be the single request that ignores the shared budget.
  await throttle?.acquire();
  const r = await resilientFetchJson<{ value: RepoSummary[] }>(
    fetch,
    `${orgUrl}/${projectEnc}/_apis/git/repositories?api-version=7.1`,
    { headers: { Authorization: auth, Accept: 'application/json' } },
    { onThrottled: ({ waitMs }) => throttle?.backOff(waitMs) },
  );
  if (!r.ok || !r.data) throw new Error(`ADO ${r.status} listing repositories for ${project}`);
  return new Map(r.data.value.map((repo) => [repo.name, { id: repo.id, defaultBranch: repo.defaultBranch }]));
}

interface BackfillChunkArgs {
  db: PrismaClient;
  ch: ChClient;
  prAdapter: AdoPrPort;
  commitAdapter: AdoCommitPort;
  sync: { id: string; syncPrs: boolean; syncCommits: boolean };
  project: string;
  repo: { id: string; name: string; defaultBranch?: string };
  state?: {
    prBackfilledUntil: Date | null;
    commitBackfilledUntil: Date | null;
    /** When this repo first synced — the point from which forward coverage runs. */
    createdAt?: Date | null;
  };
  ticketPrefixes: string[];
  floor: Date;
  chunkDays: number;
  now: Date;
  result: AdoIntelligenceResult;
}

/**
 * Fetch and persist ONE bounded window of history older than the repo's
 * backfill cursor, then move the cursor to the start of that window.
 *
 * The cursor starts at "now" (nothing older has been deliberately filled yet)
 * and walks backwards one chunk per run until it reaches `floor`. Each stream's
 * cursor advances only if that stream actually ran, mirroring how the forward
 * watermarks are handled — so flipping syncCommits on later still backfills
 * commits from scratch.
 */
async function backfillRepoChunk(args: BackfillChunkArgs): Promise<void> {
  const { db, ch, prAdapter, commitAdapter, sync, project, repo, state, result } = args;

  // Where the backward walk begins when nothing has been backfilled yet.
  //
  // NOT `now`. The forward `created` sweep has already covered everything from
  // the moment this repo first synced (the state row's createdAt), so a first
  // chunk ending at `now` re-fetches a window we demonstrably already hold —
  // and each PR in it costs two further requests (threads, work-item links)
  // against an account Azure DevOps has throttled before. Anchoring at
  // createdAt makes the two passes meet exactly: forward owns
  // [createdAt, now), the backfill owns [floor, createdAt).
  const coverageStart = state?.createdAt ?? args.now;
  const prCursor = state?.prBackfilledUntil ?? coverageStart;
  const commitCursor = state?.commitBackfilledUntil ?? coverageStart;
  // Both streams walk together when both are enabled; use the newer cursor so
  // neither stream skips a window.
  const chunkEnd = sync.syncPrs && sync.syncCommits
    ? new Date(Math.max(prCursor.getTime(), commitCursor.getTime()))
    : sync.syncPrs
      ? prCursor
      : commitCursor;
  const chunkStart = new Date(
    Math.max(args.floor.getTime(), chunkEnd.getTime() - args.chunkDays * DAY_MS),
  );
  if (chunkStart.getTime() >= chunkEnd.getTime()) return; // already at the floor

  console.log(
    `[ADO intel backfill] ${project}/${repo.name}: ${chunkStart.toISOString()} → ${chunkEnd.toISOString()}`,
  );

  if (sync.syncPrs) {
    const { pullRequests, reviews, warnings } = await withTimeout(
      prAdapter.fetchPullRequests({
        project,
        repoIds: [repo.id],
        since: chunkStart,
        until: chunkEnd,
        ticketPrefixes: args.ticketPrefixes,
      }),
      repoIntelTimeoutMs(),
      `Backfill PR fetch timed out after ${repoIntelTimeoutMs()}ms for ${project}/${repo.name}`,
    );
    if (pullRequests.length > 0) {
      await ch.insertRows('ado_pull_requests', pullRequests as unknown as Array<Record<string, unknown>>);
      result.backfillPullRequestsWritten += pullRequests.length;
    }
    if (reviews.length > 0) {
      await ch.insertRows('ado_reviews', reviews as unknown as Array<Record<string, unknown>>);
      result.reviewsWritten += reviews.length;
    }
    for (const warning of warnings ?? []) {
      console.warn(`[ADO intel backfill] ${project}/${repo.name}: ${warning}`);
    }
  }

  if (sync.syncCommits) {
    // activeSince = chunkStart so branches whose last commit falls inside the
    // historical window still qualify for selection. Without it, branch
    // selection would filter on a recent cutoff and a backfill of older history
    // would only ever see the default branch.
    const commitRows = await withTimeout(
      commitAdapter.fetchCommits({
        project,
        repoId: repo.id,
        repoName: repo.name,
        since: chunkStart,
        until: chunkEnd,
        ticketPrefixes: args.ticketPrefixes,
        defaultBranch: repo.defaultBranch,
        activeSince: chunkStart,
      }),
      repoIntelTimeoutMs(),
      `Backfill commit fetch timed out after ${repoIntelTimeoutMs()}ms for ${project}/${repo.name}`,
    );
    if (commitRows.length > 0) {
      await ch.insertRows('ado_commits', commitRows as unknown as Array<Record<string, unknown>>);
      result.backfillCommitsWritten += commitRows.length;
    }
  }

  await db.adoRepoSyncState.update({
    where: {
      azureDevOpsProjectSyncId_repoId: {
        azureDevOpsProjectSyncId: sync.id,
        repoId: repo.id,
      },
    },
    data: {
      ...(sync.syncPrs ? { prBackfilledUntil: chunkStart } : {}),
      ...(sync.syncCommits ? { commitBackfilledUntil: chunkStart } : {}),
    },
  });
  result.backfillReposProcessed++;
}

export async function handleAdoIntelligenceSync(
  job: AdoIntelligenceJobData,
  db: PrismaClient,
  prFactory: AdoPrFactory,
  commitFactory: AdoCommitFactory,
  /**
   * Builds a ClickHouse client bound to one organization. Called once per
   * instance below, with THAT instance's organizationId — the ADO connections
   * this job iterates can belong to different tenants.
   */
  chClientFor: ChClientFactory,
  throttle?: Throttle,
  // Optional so existing 5-arg callers keep working; when omitted, deployment
  // ingestion is simply skipped and DORA keeps using the merged-PR proxy.
  deploymentFactory?: AdoDeploymentFactory,
): Promise<AdoIntelligenceResult> {
  const result: AdoIntelligenceResult = {
    instancesProcessed: 0, projectsProcessed: 0, reposProcessed: 0,
    pullRequestsWritten: 0, reviewsWritten: 0, commitsWritten: 0,
    backfillReposProcessed: 0, backfillPullRequestsWritten: 0, backfillCommitsWritten: 0,
    deploymentsWritten: 0,
    errors: [],
  };
  const backfill = backfillConfig();
  // The tenant boundary. Fail-closed — see sync-trigger-tenancy.test.ts.
  const scope = resolveSyncJobScope(job);
  if (!scope.allowed) {
    console.error(`[ADO intel] ${scope.reason}`);
    result.errors.push({ instanceId: 'none', project: '-', message: scope.reason });
    return result;
  }

  const where: Record<string, unknown> = {};
  if (job.instanceId) where.id = job.instanceId;
  if (scope.organizationId) where.organizationId = scope.organizationId;
  const instances = await db.azureDevOpsInstance.findMany({ where, include: { projectSyncs: true } });

  for (const instance of instances) {
    result.instancesProcessed++;
    // Bind ClickHouse to the organization that owns THIS instance — inside the
    // loop, so PRs, reviews, commits and deployments from a second instance on
    // another tenant are written under that tenant, not this one.
    const ch = chClientFor(instance.organizationId);
    const factoryCfg: AdoFactoryConfig = {
      orgUrl: instance.orgUrl,
      authMethod: instance.authMethod === 'BASIC' ? 'BASIC' : 'PAT',
      accessToken: instance.accessToken,
      username: instance.username ?? undefined,
      instanceId: instance.id,
    };
    const prAdapter = prFactory(factoryCfg);
    const commitAdapter = commitFactory(factoryCfg);
    const deploymentAdapter = deploymentFactory?.(factoryCfg);
    const projects = job.projects ?? instance.projectSyncs.map((ps) => ps.adoProject);

    // Build a per-project prefix union from all boards that consume this
    // project with useForIntelligence=true. See github-intelligence-sync.handler
    // for the rationale — same shape, scoped on adoProject instead of repo.
    const boardSources = await db.boardAdoSource.findMany({
      where: {
        useForIntelligence: true,
        azureDevOpsProjectSync: { azureDevOpsInstanceId: instance.id, adoProject: { in: projects } },
      },
      select: {
        board: { select: { ticketKeyPrefixes: true } },
        azureDevOpsProjectSync: { select: { adoProject: true } },
      },
    });
    const projectToPrefixes = new Map<string, string[]>();
    for (const src of boardSources) {
      const proj = src.azureDevOpsProjectSync.adoProject;
      const existing = projectToPrefixes.get(proj) ?? [];
      projectToPrefixes.set(proj, Array.from(new Set([...existing, ...src.board.ticketKeyPrefixes])));
    }

    for (const project of projects) {
      try {
        const sync = instance.projectSyncs.find((ps) => ps.adoProject === project);
        if (!sync) continue;
        // strict opt-in: nothing syncs unless all-repos mode is on OR an explicit list is set
        if (!sync.syncAllRepos && (!sync.syncRepos || sync.syncRepos.length === 0)) {
          result.projectsProcessed++; continue;
        }
        if (!sync.syncPrs && !sync.syncCommits) { result.projectsProcessed++; continue; }

        const reposByName = await listReposByName(factoryCfg, project, throttle);
        const pickedRepos = sync.syncAllRepos
          ? Array.from(reposByName.entries()).map(([name, info]) => ({
              name,
              id: info.id,
              defaultBranch: info.defaultBranch,
            }))
          : sync.syncRepos
              .map((name) => ({ name, info: reposByName.get(name) }))
              .filter((r): r is { name: string; info: RepoInfo } => Boolean(r.info))
              .map((r) => ({ name: r.name, id: r.info.id, defaultBranch: r.info.defaultBranch }));

        if (pickedRepos.length === 0) {
          result.errors.push({
            instanceId: instance.id,
            project,
            message: sync.syncAllRepos
              ? `syncAllRepos set but project has no repositories: ${project}`
              : `None of sync_repos matched repos in project: ${sync.syncRepos.join(', ')}`,
          });
          continue;
        }

        const ticketPrefixes = projectToPrefixes.get(project) ?? [];
        // Active-branch cutoff for commit sync — bounds dead-branch and
        // first-run (no watermark) backfill. See ACTIVE_BRANCH_DAYS.
        const activeSince = new Date(Date.now() - ACTIVE_BRANCH_DAYS * 24 * 60 * 60 * 1000);

        // Per-repo watermark: each repo advances its own PR/commit cursor so the
        // whole project never re-fetches from scratch and a failed repo doesn't
        // hold back the rest.
        const states = await db.adoRepoSyncState.findMany({
          where: { azureDevOpsProjectSyncId: sync.id },
        });
        const stateByRepoId = new Map(states.map((s) => [s.repoId, s]));

        // Backfill targets are chosen up front so the per-run budget is spread
        // breadth-first across repos rather than always landing on whichever
        // repos happen to come first in ADO's listing order.
        const backfillFloor = new Date(Date.now() - backfill.floorDays * DAY_MS);
        const backfillRepoIds =
          backfill.enabled && backfill.reposPerRun > 0
            ? selectBackfillRepos(
                // Only repos that have synced before need a backward walk: a
                // repo with no state row gets full history from the untimed
                // first-run sweep above.
                pickedRepos
                  .filter((r) => stateByRepoId.has(r.id))
                  .map((r) => ({
                    repoId: r.id,
                    cursor:
                      (sync.syncPrs
                        ? stateByRepoId.get(r.id)?.prBackfilledUntil
                        : stateByRepoId.get(r.id)?.commitBackfilledUntil) ?? null,
                  })),
                backfillFloor,
                backfill.reposPerRun,
              )
            : new Set<string>();

        for (const repo of pickedRepos) {
          try {
            const st = stateByRepoId.get(repo.id);
            // Stamp the watermark from BEFORE the fetch so items created mid-fetch
            // are caught next run rather than skipped.
            const repoStart = new Date();
            let repoPrs = 0;
            let repoReviews = 0;
            let repoCommits = 0;
            console.log(`[ADO intel] ${project}/${repo.name}: fetching (prs=${sync.syncPrs} commits=${sync.syncCommits})`);

            // First run for this repo: bound the sweep (see FIRST_PR_SYNC_DAYS)
            // so it terminates and a watermark can be persisted. Computed per
            // repo, from repoStart, so the value handed to the backfill cursor
            // below is exactly the one the fetch used.
            const firstPrSweepSince = new Date(
              repoStart.getTime() - FIRST_PR_SYNC_DAYS * DAY_MS,
            );
            const isFirstPrRun = !st?.lastPrSyncAt;

            if (sync.syncPrs) {
              const prSince = st?.lastPrSyncAt ?? firstPrSweepSince;
              const { pullRequests, reviews, warnings } = await withTimeout(
                prAdapter.fetchPullRequests({
                  project,
                  repoIds: [repo.id],
                  since: prSince,
                  ticketPrefixes,
                }),
                repoIntelTimeoutMs(),
                `PR fetch timed out after ${repoIntelTimeoutMs()}ms for ${project}/${repo.name}`,
              );
              if (pullRequests.length > 0) {
                await ch.insertRows('ado_pull_requests', pullRequests as unknown as Array<Record<string, unknown>>);
                result.pullRequestsWritten += pullRequests.length;
                repoPrs = pullRequests.length;
              }
              if (reviews.length > 0) {
                await ch.insertRows('ado_reviews', reviews as unknown as Array<Record<string, unknown>>);
                result.reviewsWritten += reviews.length;
                repoReviews = reviews.length;
              }
              // Non-fatal degradations (e.g. work-item links unreadable) —
              // logged and surfaced in the run result so a permanently
              // mis-scoped PAT is visible rather than showing up as an
              // unexplained 0% ticket coverage.
              for (const warning of warnings ?? []) {
                console.warn(`[ADO intel] ${project}/${repo.name}: ${warning}`);
                result.errors.push({
                  instanceId: instance.id,
                  project,
                  repo: repo.name,
                  message: warning,
                });
              }
            }

            if (sync.syncCommits) {
              const commitSince = st?.lastCommitSyncAt ?? undefined;
              const commitRows = await withTimeout(
                commitAdapter.fetchCommits({
                  project,
                  repoId: repo.id,
                  repoName: repo.name,
                  since: commitSince,
                  ticketPrefixes,
                  defaultBranch: repo.defaultBranch,
                  activeSince,
                }),
                repoIntelTimeoutMs(),
                `Commit fetch timed out after ${repoIntelTimeoutMs()}ms for ${project}/${repo.name}`,
              );
              if (commitRows.length > 0) {
                await ch.insertRows('ado_commits', commitRows as unknown as Array<Record<string, unknown>>);
                result.commitsWritten += commitRows.length;
                repoCommits = commitRows.length;
              }
            }

            // Advance only the cursors this run actually covered; leave the other
            // null so a later flag flip backfills it from the beginning.
            await db.adoRepoSyncState.upsert({
              where: {
                azureDevOpsProjectSyncId_repoId: {
                  azureDevOpsProjectSyncId: sync.id,
                  repoId: repo.id,
                },
              },
              create: {
                azureDevOpsProjectSyncId: sync.id,
                repoId: repo.id,
                repoName: repo.name,
                lastPrSyncAt: sync.syncPrs ? repoStart : null,
                lastCommitSyncAt: sync.syncCommits ? repoStart : null,
                // Hand the backward walk the exact point the bounded forward
                // sweep started from, so the two meet without gap or overlap:
                // forward owns [firstPrSweepSince, now), backfill owns
                // [floor, firstPrSweepSince). Leaving this null would let the
                // cursor default to the row's createdAt (~now) and re-fetch the
                // window just ingested — the redundant re-walk fixed in
                // 424f9d97, reintroduced through a new door.
                ...(sync.syncPrs && isFirstPrRun
                  ? { prBackfilledUntil: firstPrSweepSince }
                  : {}),
              },
              update: {
                repoName: repo.name,
                ...(sync.syncPrs ? { lastPrSyncAt: repoStart } : {}),
                ...(sync.syncCommits ? { lastCommitSyncAt: repoStart } : {}),
              },
            });
            result.reposProcessed++;
            console.log(
              `[ADO intel] ${project}/${repo.name}: done (prs=${repoPrs} reviews=${repoReviews} commits=${repoCommits})`,
            );

            // One bounded chunk of older history. Deliberately AFTER the forward
            // watermark upsert and in its own try/catch: a backfill failure must
            // not roll back the incremental progress just persisted, and its
            // cursor must not advance past a window it failed to fetch.
            if (backfillRepoIds.has(repo.id)) {
              try {
                await backfillRepoChunk({
                  db, ch, prAdapter, commitAdapter, sync, project, repo,
                  state: stateByRepoId.get(repo.id),
                  ticketPrefixes,
                  floor: backfillFloor,
                  chunkDays: backfill.chunkDays,
                  now: repoStart,
                  result,
                });
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                console.error(`[ADO intel backfill] ${project}/${repo.name}: FAILED — ${message}`);
                result.errors.push({
                  instanceId: instance.id,
                  project,
                  repo: repo.name,
                  message: `backfill: ${message}`,
                });
              }
            }
          } catch (err) {
            // Isolate the failure to this repo; its watermark is untouched so it
            // retries from the same position next run.
            const message = err instanceof Error ? err.message : String(err);
            console.error(`[ADO intel] ${project}/${repo.name}: FAILED — ${message}`);
            result.errors.push({
              instanceId: instance.id,
              project,
              repo: repo.name,
              message,
            });
          }
        }

        // Real deployment records — project-level (release pipelines belong to a
        // project, not a repo) and served from a different host, so this runs
        // once per project with its own watermark, in its own try/catch: a PAT
        // without Release read scope must not fail the whole project's intel.
        if (deploymentAdapter) {
          try {
            const deployStart = new Date();
            const deployments = await withTimeout(
              deploymentAdapter.fetchDeployments({
                project,
                since: sync.lastDeploymentSyncAt ?? undefined,
              }),
              repoIntelTimeoutMs(),
              `Deployment fetch timed out after ${repoIntelTimeoutMs()}ms for ${project}`,
            );
            if (deployments.length > 0) {
              await ch.insertRows(
                'ado_deployments',
                deployments as unknown as Array<Record<string, unknown>>,
              );
              result.deploymentsWritten += deployments.length;
            }
            await db.azureDevOpsProjectSync.update({
              where: { id: sync.id },
              data: { lastDeploymentSyncAt: deployStart },
            });
            console.log(`[ADO deploy] ${project}: ${deployments.length} deployment(s)`);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`[ADO deploy] ${project}: FAILED — ${message}`);
            result.errors.push({
              instanceId: instance.id,
              project,
              message: `deployments: ${message}`,
            });
          }
        }

        await db.azureDevOpsProjectSync.update({ where: { id: sync.id }, data: { lastSyncedAt: new Date() } });
        result.projectsProcessed++;
      } catch (err) {
        result.errors.push({ instanceId: instance.id, project, message: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  return result;
}

import path from 'path'
import { fileURLToPath } from 'url'
import { config } from 'dotenv'
import { Queue, Worker } from 'bullmq'
import { clickhouse, chInsertMany } from '@deckgauge/db'
import { loadEdition, type WorkerEditionModule } from './edition-loader.js'
import { createIngestPermission } from './ingest-permission.js'
import { buildWorkerChReadIdentity } from './ch-read-identity.js'
import { startPeriodicWork } from './periodic-work.js'
import { runNotificationMaintenance } from './notification-maintenance.handler.js'
import {
  FakeJiraAdapter,
  JiraCloudAdapter,
  GitHubRestAdapter,
  FakeGitHubAdapter,
  FakeGitHubProjectsAdapter,
  GitHubProjectsGraphQLAdapter,
  FakeAzureDevOpsAdapter,
  AzureDevOpsRestAdapter,
  GitLabPrAdapter,
  GitLabCommitAdapter,
  GitLabIssueAdapter,
  FakeGitLabPrAdapter,
  FakeGitLabCommitAdapter,
  FakeGitLabIssueAdapter,
  JiraIntelligenceAdapter,
  FakeJiraIntelligenceAdapter,
  AdoPrAdapter,
  FakeAdoPrAdapter,
  AdoCommitAdapter,
  FakeAdoCommitAdapter,
  AdoDeploymentAdapter,
  FakeAdoDeploymentAdapter,
  RequestThrottle,
} from '@deckgauge/shared'
import { loadAzureDevOpsConfig } from '@deckgauge/shared/azure-devops-config'
import { handleSyncJob } from './jira-sync.handler.js'
import { purgeJiraIssueKeys as purgeJiraKeysFromCh } from './jira-deleted-purge.js'
import { handleGitHubSyncJob, GitHubProjectsAdapterFactory } from './github-sync.handler.js'
import { handleAzureDevOpsSyncJob } from './azure-devops-sync.handler.js'
import { handleGitLabSyncJob } from './gitlab-sync.handler.js'
import { handleJiraIntelligenceSync } from './jira-intelligence-sync.handler.js'
import { runIntelligenceSync } from './github-intelligence-sync.handler.js'
import {
  handleGithubIntelligenceSync,
  type GithubIntelligenceJobData,
} from './github-intelligence-fanout.handler.js'
import { handleAdoIntelligenceSync } from './ado-intelligence-sync.handler.js'
import { Octokit } from '@octokit/rest'
import { GITHUB_SYNC_QUEUE_NAMES, makeGitHubQueueClient } from '@deckgauge/shared'
import { RateLimiter } from './github-rate-limiter.js'
import { OrgConcurrencyGate, resolveMaxJobsPerOrg } from './org-concurrency-gate.js'
import { makeOrgGatedProcessor } from './org-gated-processor.js'
import {
  reconcileGitHubBackfills,
  reconcileGitHubSchedules,
} from './github-backfill-reconciler.js'
import { handleOrgTreeSyncJob } from './org-tree-sync/org-tree-sync.processor.js'
import { handleOrgSourceSyncJob } from './org-source-sync/org-source-sync.processor.js'
import { reconcileOrgSourceSync } from './org-source-sync/reconcile-org-source-sync.js'
import { handleCalendarSourceSyncJob } from './calendar-source-sync/calendar-source-sync.handler.js'
import {
  FakeCalendarClient,
  GraphCalendarClient,
  type CalendarClient,
} from './calendar-source-sync/graph-calendar-client.js'
import {
  FakeGraphDirectoryClient,
  DelegatedGraphDirectoryClient,
  StaticTokenGraphDirectoryClient,
  type GraphDirectoryClient,
} from './org-source-sync/graph-directory-client.js'
import { createPrismaClient } from "@deckgauge/db";

// Load .env from the repository root
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const rootDir = path.resolve(__dirname, '../../..')
const envPath = path.join(rootDir, '.env')

config({ path: envPath })

const REDIS_URL = process.env.REDIS_URL

if (!REDIS_URL) {
  console.error('Error: REDIS_URL environment variable is not set')
  process.exit(1)
}

// Initialize Prisma client
const db = createPrismaClient()

const jiraAdapterFactory = (cfg: {
  atlassianUrl: string
  email: string
  apiToken: string
  projectKeys: string[]
}) => {
  if (process.env.USE_FAKE_JIRA === 'true') {
    return new FakeJiraAdapter()
  }
  return new JiraCloudAdapter(cfg)
}

async function bootstrapAdoFromYaml() {
  const instanceCount = await db.azureDevOpsInstance.count();
  if (instanceCount > 0) return;

  // Connections are organization property now, and the worker has no request to
  // take an organization from. Under the enforced single-organization cap there
  // is at most one, so resolving it here is unambiguous.
  //
  // No organization yet means a fresh install nobody has logged into: there is
  // no tenant to own these rows, so skip rather than invent one. The next worker
  // start after bootstrap picks the YAML up, because the `instanceCount > 0`
  // guard above is still unsatisfied.
  const organization = await db.organization.findFirst({ select: { id: true } });
  if (!organization) {
    console.log(
      'No organization exists yet — skipping ADO YAML bootstrap until one is created',
    );
    return;
  }

  try {
    const configPath = process.env.ADO_CONFIG_PATH
      ? path.join(rootDir, process.env.ADO_CONFIG_PATH)
      : path.join(rootDir, 'config', 'azure-devops.yaml');
    const yamlConfig = loadAzureDevOpsConfig(configPath);
    for (const inst of yamlConfig.instances) {
      await db.azureDevOpsInstance.create({
        data: {
          organizationId: organization.id,
          name: inst.name,
          orgUrl: inst.orgUrl,
          authMethod: inst.authMethod as 'PAT' | 'BASIC',
          accessToken: inst.accessToken,
          username: inst.username ?? null,
          projects: inst.projects,
        },
      });
    }
    console.log('Bootstrapped AzureDevOpsInstance(s) from config/azure-devops.yaml');
  } catch {
    console.log('No azure-devops.yaml found or parse error — skipping ADO YAML bootstrap');
  }
}

await bootstrapAdoFromYaml();

const connection = { url: REDIS_URL }

// The ONLY way this worker gets a ClickHouse client. There is deliberately no
// unbound variant any more: every ingest path takes this factory and calls it
// with the organizationId of the instance (or repo) it is syncing, so a write
// without a tenant is not something a future handler can express.
//
// The organization is bound at construction, not passed per call: insertRows
// keeps its two-argument (table, rows) signature, so the ~40 handler call
// sites and the duplicated ChClient interface declarations across the handler
// files stay untouched. Binding here — rather than threading a third argument
// through every call site — makes writing to the wrong tenant inexpressible
// instead of merely avoidable.
// Open-core seam, resolved BEFORE any Worker below is constructed — those start
// consuming as soon as they exist, and a job that ran against a not-yet-loaded
// module would read as "no restrictions", which is the wrong default for ingest.
//
// Null in Community, which is the free product's only behaviour: there is no
// disabled feature here, there is no feature.
const edition: WorkerEditionModule | null = await loadEdition()

// WHICH ClickHouse login serves the worker's READS, resolved once here rather
// than per job — see ch-read-identity.ts for why, and for why an unconfigured
// read identity falls back to the ingest client (reading, scoped by the
// organization_id predicate) instead of refusing or reading zero rows.
//
// Boot-time, and before any Worker is constructed, for the same reason `edition`
// is: a Worker starts consuming the moment it exists.
const chReadIdentity = buildWorkerChReadIdentity({
  ingestClient: clickhouse,
  log: { warn: (m) => console.warn(m), info: (m) => console.log(m) },
})

function chClientFor(organizationId: string) {
  // The edition seam for ingest sits HERE rather than in each handler, because this
  // is already the one place every ClickHouse write passes through with a tenant
  // bound (see the note above). One call site covers all ~40 handler writes; eight
  // per-handler edits would be eight chances to miss one.
  //
  // In Community `edition` is null and the permission always allows, so the free
  // product is unchanged. Memoised, so this costs at most one check per job rather
  // than one per batch insert.
  const permission = createIngestPermission(organizationId, edition)
  // The READ half, bound to the same organization as the write half. It asserts
  // the `organization_id` predicate on every query and activates this
  // organization's ClickHouse role.
  const read = chReadIdentity.readerFor(organizationId)
  return {
    // Readable so a read site can build its own tenant predicate; not writable,
    // so it cannot choose a different tenant. Same property insertRows has.
    organizationId,
    async insertRows(table: string, rows: ReadonlyArray<Record<string, unknown>>): Promise<void> {
      if (rows.length === 0) return
      if (!(await permission.allowed())) {
        console.log(
          `[edition] ingest not permitted for organization ${organizationId} — skipping ${rows.length} row(s) for ${table}`,
        )
        return
      }
      await chInsertMany(table, organizationId, rows as Array<Record<string, unknown>>)
    },
    // The read-back path, now SCOPED. It used to ignore `organizationId` entirely
    // and run through the ingest singleton with no role and no predicate, so the
    // incremental ADO revisions sweep recovered whichever TENANT's revision was
    // newest and wrote it back as this tenant's `from_state` and dwell time. That
    // persisted; it was not merely a read leak.
    //
    // The sweep still uses it for what it was built for: recovering the state each
    // work item was already in before its window, so a status change at the window
    // boundary keeps its true from_state and dwell time instead of re-reading
    // history from Azure DevOps.
    queryRows<T>(sql: string): Promise<T[]> {
      return read.queryRows<T>(sql)
    },
    // Jira deletion purge. Org-scoped here, in one place, for the same reason
    // insertRows is: the caller never sees an organizationId and so cannot pick
    // the wrong one.
    async purgeJiraIssueKeys(issueKeys: string[]): Promise<void> {
      await purgeJiraKeysFromCh(clickhouse, organizationId, issueKeys)
    },
  }
}

const queue = new Queue('jira-sync', { connection })
const worker = new Worker(
  'jira-sync',
  async (job) => {
    const trigger = job.data?.trigger || 'scheduled'
    console.log(`Processing jira-sync job (trigger: ${trigger})`)
    // The FACTORY goes down, not a client: handleSyncJob binds it per Jira
    // instance, to the organization that owns that instance.
    return handleSyncJob(job.data, db, jiraAdapterFactory, chClientFor)
  },
  { connection }
)

worker.on('completed', (job) => {
  console.log(`Job ${job.id} completed`)
})

worker.on('failed', (job, err) => {
  console.error(`Job ${job?.id} failed: ${err.message}`)
})

// Enqueue startup job
await queue.add('jira-sync', { trigger: 'startup' }, { jobId: 'startup-job' })

// Schedule repeating job every 15 minutes with dedup
const repeatInterval = process.env.CRON_INTERVAL ? parseInt(process.env.CRON_INTERVAL) : 15 * 60 * 1000

// Azure DevOps gets its own, slower cadence. A full ADO pass across two real
// orgs (23 projects, 363 repos) took ~33 minutes
// against a 15-minute schedule, so passes ran back-to-back around the clock and
// at times overlapped — which is how the account's request throughput budget got
// exhausted. Separate from CRON_INTERVAL so throttling ADO does not also stale
// out Jira/GitHub/GitLab, which are nowhere near their limits.
const adoRepeatInterval = process.env.ADO_CRON_INTERVAL
  ? parseInt(process.env.ADO_CRON_INTERVAL)
  : 60 * 60 * 1000

// Ensure exactly ONE repeatable schedule per queue. BullMQ keys repeatable jobs
// by interval, so a prior run with a different CRON_INTERVAL (e.g. a test using
// every=100ms against the shared Redis) leaves orphaned schedules that persist
// forever — a 100ms jira-sync orphan once fired ~10x/s, flooding the worker and
// OOM-looping it. Removing all existing repeatables before re-adding the single
// intended one keeps exactly one schedule regardless of past intervals.
async function scheduleRepeatable(
  q: Queue,
  jobName: string,
  data: Record<string, unknown>,
  everyMs: number,
  jobId: string
) {
  for (const r of await q.getRepeatableJobs()) {
    await q.removeRepeatableByKey(r.key)
  }
  await q.add(jobName, data, { repeat: { every: everyMs }, jobId })
}

await scheduleRepeatable(queue, 'jira-sync', { trigger: 'scheduled' }, repeatInterval, 'jira-sync-scheduled')

// ── EI-014: GitLab sync queue ──────────────────────────────────────────────
const gitlabPrAdapterFactory = (cfg: {
  accessToken: string
  baseUrl?: string
  instanceId: string
}) => {
  if (process.env.USE_FAKE_GITLAB === 'true') {
    return new FakeGitLabPrAdapter([])
  }
  return new GitLabPrAdapter(cfg)
}

const gitlabCommitAdapterFactory = (cfg: {
  accessToken: string
  baseUrl?: string
  instanceId: string
}) => {
  if (process.env.USE_FAKE_GITLAB === 'true') {
    return new FakeGitLabCommitAdapter([])
  }
  return new GitLabCommitAdapter(cfg)
}

const gitlabIssueAdapterFactory = (cfg: {
  accessToken: string
  baseUrl?: string
  instanceId: string
}) => {
  if (process.env.USE_FAKE_GITLAB === 'true') {
    return new FakeGitLabIssueAdapter([])
  }
  return new GitLabIssueAdapter(cfg)
}

const gitlabQueue = new Queue('gitlab-sync', { connection })
const gitlabWorker = new Worker(
  'gitlab-sync',
  async (job) => {
    const trigger = job.data?.trigger || 'scheduled'
    console.log(`Processing gitlab-sync job (trigger: ${trigger})`)
    return handleGitLabSyncJob(
      job.data,
      db,
      gitlabPrAdapterFactory,
      gitlabCommitAdapterFactory,
      gitlabIssueAdapterFactory,
      // The FACTORY goes down, not a client: handleGitLabSyncJob binds it per
      // GitLab instance, to the organization that owns that instance.
      chClientFor,
    )
  },
  { connection },
)

gitlabWorker.on('completed', (job) => {
  console.log(`GitLab job ${job.id} completed`)
})
gitlabWorker.on('failed', (job, err) => {
  console.error(`GitLab job ${job?.id} failed: ${err.message}`)
})

await scheduleRepeatable(gitlabQueue, 'gitlab-sync', { trigger: 'scheduled' }, repeatInterval, 'gitlab-sync-scheduled')

// ── EI-012/013/015: Phase 3 intelligence sync queues ───────────────────────
const jiraIntelFactory = (cfg: { atlassianUrl: string; email: string; apiToken: string }) => {
  if (process.env.USE_FAKE_JIRA === 'true') {
    return new FakeJiraIntelligenceAdapter({ issues: [], transitions: [] })
  }
  return new JiraIntelligenceAdapter(cfg)
}

// ── Azure DevOps client-side pacing ────────────────────────────────────────
// ONE throttle for every ADO adapter: the work-item sync, the PR sync and the
// commit sync all authenticate as the same PAT, so Azure DevOps bills them
// against a single account throughput budget. Sharing the instance means a 429
// seen by any of them slows all of them (see RequestThrottle.backOff).
//
// Sizing: ADO meters a caller in throughput units over a 5-minute sliding
// window and starts delaying requests past its share. There is no reliable
// remaining-quota header to steer by, so we pace conservatively — ~3 req/s with
// a 600-per-5-min ceiling — and let Retry-After correct us when we are wrong.
// Both knobs are env-tunable for ops without a rebuild.
const adoThrottle = new RequestThrottle({
  minIntervalMs: Number(process.env.ADO_MIN_REQUEST_INTERVAL_MS) || 300,
  maxPerWindow: Number(process.env.ADO_MAX_REQUESTS_PER_WINDOW) || 600,
  windowMs: 5 * 60 * 1000,
})

const adoPrFactory = (cfg: { orgUrl: string; authMethod: 'PAT' | 'BASIC'; accessToken: string; username?: string; instanceId: string }) => {
  if (process.env.USE_FAKE_ADO === 'true') {
    return new FakeAdoPrAdapter([])
  }
  return new AdoPrAdapter({ ...cfg, throttle: adoThrottle })
}

const adoCommitFactory = (cfg: { orgUrl: string; authMethod: 'PAT' | 'BASIC'; accessToken: string; username?: string; instanceId: string }) => {
  if (process.env.USE_FAKE_ADO === 'true') {
    return new FakeAdoCommitAdapter([])
  }
  return new AdoCommitAdapter({ ...cfg, throttle: adoThrottle })
}

// Real deployment records (classic Release pipelines) → cockpit.ado_deployments,
// which DORA's deploy frequency prefers over the merged-PR proxy.
const adoDeploymentFactory = (cfg: { orgUrl: string; authMethod: 'PAT' | 'BASIC'; accessToken: string; username?: string; instanceId: string }) => {
  if (process.env.USE_FAKE_ADO === 'true') {
    return new FakeAdoDeploymentAdapter([])
  }
  return new AdoDeploymentAdapter({ ...cfg, throttle: adoThrottle })
}

function makeIntelligenceQueue(name: string, handler: (jobData: { trigger?: string }) => Promise<unknown>) {
  const q = new Queue(name, { connection })
  const w = new Worker(
    name,
    async (job) => {
      console.log(`Processing ${name} job (trigger: ${job.data?.trigger || 'scheduled'})`)
      return handler(job.data)
    },
    {
      connection,
      lockDuration: 10 * 60 * 1000,
      lockRenewTime: 4 * 60 * 1000,
      concurrency: 1,
    },
  )
  w.on('completed', (job) => {
    // Surface the handler result (rows written + per-repo errors). These syncs
    // catch per-repo failures into result.errors and still "complete", so
    // without this a broken commit/PR sync is silently invisible.
    const rv = job.returnvalue as { errors?: unknown[] } | undefined
    const summary = rv ? ` ${JSON.stringify(rv)}` : ''
    console.log(`${name} job ${job.id} completed:${summary}`)
    if (rv?.errors && rv.errors.length > 0) {
      console.error(`${name} job ${job.id} had ${rv.errors.length} error(s)`)
    }
  })
  w.on('failed', (job, err) => console.error(`${name} job ${job?.id} failed: ${err.message}`))
  return q
}

const jiraIntelQueue = makeIntelligenceQueue('jira-intelligence-sync', (data) =>
  handleJiraIntelligenceSync(data as never, db, jiraIntelFactory, chClientFor),
)
const adoIntelQueue = makeIntelligenceQueue('ado-intelligence-sync', (data) =>
  handleAdoIntelligenceSync(
    data as never,
    db,
    adoPrFactory,
    adoCommitFactory,
    chClientFor,
    adoThrottle,
    adoDeploymentFactory,
  ),
)

await scheduleRepeatable(jiraIntelQueue, jiraIntelQueue.name, { trigger: 'scheduled' }, repeatInterval, `${jiraIntelQueue.name}-scheduled`)
await scheduleRepeatable(adoIntelQueue, adoIntelQueue.name, { trigger: 'scheduled' }, adoRepeatInterval, `${adoIntelQueue.name}-scheduled`)

// ── GitHub bulk-repo ingestion: three-tier sync queues ────────────────────
// Each tier has its own queue + worker. Repeatables are added per-repo by
// the api (bulkBind) — not at boot — so worker startup stays cheap.
const githubSyncHotQueue = new Queue(GITHUB_SYNC_QUEUE_NAMES.hot, { connection })
const githubSyncWarmQueue = new Queue(GITHUB_SYNC_QUEUE_NAMES.warm, { connection })
const githubSyncColdQueue = new Queue(GITHUB_SYNC_QUEUE_NAMES.cold, { connection })

const githubBulkRateLimiter = new RateLimiter({ budget: 4_000, refillMs: 3_600_000 })

function makeOctokitForInstance(instance: { accessToken: string; baseUrl: string | null }) {
  return new Octokit({ auth: instance.accessToken, baseUrl: instance.baseUrl ?? undefined })
}

// Per-organization concurrency cap for the tier queues. These are the only
// workers in this process with concurrency > 1, so they are the only place where
// one tenant can actually crowd another out of a slot — everything else here runs
// one job at a time (see the note above `makeTierWorker`'s callers, and STATE.md
// for why a per-org cap on the sweep queues would bind on nothing).
//
// Default 0 = disabled, so a single-organization deployment is unchanged.
const maxJobsPerOrg = resolveMaxJobsPerOrg(process.env.WORKER_MAX_CONCURRENT_JOBS_PER_ORG)
const tierOrgGate = new OrgConcurrencyGate(maxJobsPerOrg)
if (tierOrgGate.isEnabled()) {
  console.log(`[tier-queues] per-organization concurrency cap: ${maxJobsPerOrg} job(s)`)
}

/** Payload the api's `bulkBind` enqueues onto the three tier queues. */
type TierJobData = { repoSyncId: string }

/** The repo row the tier processor needs, loaded once per job. */
type TierRow = Awaited<ReturnType<typeof loadTierRow>>

function loadTierRow(repoSyncId: string) {
  return db.gitHubRepoSync.findUniqueOrThrow({
    where: { id: repoSyncId },
    include: { githubInstance: true },
  })
}

/**
 * @param gated Whether to wrap this tier in the per-org cap. False for `cold`,
 *   whose concurrency is 1: a cap can never REFUSE anything there (one job in
 *   flight is at most one per organization), so gating it would only add the
 *   bookkeeping and never change an outcome.
 */
function makeTierWorker(name: string, concurrency: number, gated: boolean) {
  const runSync = async (row: TierRow) => {
    const octokit = makeOctokitForInstance(row.githubInstance)
    // The FACTORY goes down, not a client: runIntelligenceSync binds it to the
    // organization owning this repo's GitHub instance.
    await runIntelligenceSync(
      { prisma: db, octokit, rateLimiter: githubBulkRateLimiter, chClientFor },
      row.id,
    )
  }

  const processor =
    gated && tierOrgGate.isEnabled()
      ? makeOrgGatedProcessor<TierJobData, TierRow>({
          gate: tierOrgGate,
          // Loads the SAME row `process` needs and reports its owner, so the row
          // is fetched exactly ONCE whether the cap is on or off. An earlier
          // version fetched it twice and claimed in a comment that it did not.
          resolve: async (job) => {
            const row = await loadTierRow(job.data.repoSyncId)
            return { organizationId: row.githubInstance.organizationId, context: row }
          },
          onDeferred: ({ job, organizationId, deferrals, warn, fromCache }) => {
            // `warn` is true only on the deferral that CROSSES the threshold, so
            // this is one line per stuck job — not one per job per retry
            // interval, which is the log amplification this gate exists to avoid.
            if (warn) {
              console.warn(
                `[${name}] job ${job.id} deferred ${deferrals}x — organization ${organizationId} has been at its cap for a long time; a slot may be held by a stuck job`,
              )
              return
            }
            // Only the decisions that cost a lookup are logged, for the same reason.
            if (!fromCache) {
              console.log(
                `[${name}] job ${job.id} deferred: organization ${organizationId} at its concurrency cap`,
              )
            }
          },
          process: async (job, row) => runSync(row ?? (await loadTierRow(job.data.repoSyncId))),
        })
      : async (job: { data: TierJobData }) => runSync(await loadTierRow(job.data.repoSyncId))

  // The cast is needed because the two branches above have different signatures
  // — the gated one takes (job, token) so it can call moveToDelayed, the plain
  // one takes (job) — and BullMQ's Processor type is invariant in the job's data
  // parameter, so neither narrows to it without help. Both are structurally
  // valid processors; only the union defeats inference.
  const w = new Worker(name, processor as ConstructorParameters<typeof Worker>[1], {
    connection,
    concurrency,
  })
  w.on('failed', (job, err) => console.error(`[${name}] job ${job?.id} failed: ${err.message}`))
  return w
}

makeTierWorker(GITHUB_SYNC_QUEUE_NAMES.hot, 4, true)
makeTierWorker(GITHUB_SYNC_QUEUE_NAMES.warm, 2, true)
makeTierWorker(GITHUB_SYNC_QUEUE_NAMES.cold, 1, false)

// Consumer for the `github-intelligence-sync` queue. The api enqueues here from
// the manual "Sync" button (board-sync.service + POST /intelligence/sync) with
// { trigger, instanceId, repos }. Without this consumer those jobs pile up in
// `wait` forever and github_commits / github_pull_requests never refresh on
// demand. Fans out to the per-repo `runIntelligenceSync`, sharing the tier
// workers' rate limiter so budget stays coordinated. No scheduled repeatable is
// registered — the three-tier queues already own periodic per-repo syncs.
makeIntelligenceQueue('github-intelligence-sync', (data) =>
  handleGithubIntelligenceSync(
    data as GithubIntelligenceJobData,
    db,
    makeOctokitForInstance,
    githubBulkRateLimiter,
    // Forwarded to the per-repo runner, which binds it per repo — the fan-out
    // spans every active repo, across instances in different organizations.
    chClientFor,
  ),
)

// Self-heal: re-enqueue an initial backfill for any active repo that never
// completed one (e.g. attached while the api's enqueue was a no-op, or whose
// earlier backfill kept erroring). Idempotent — re-adding the same repeatable
// updates its existing schedule rather than duplicating it, so this is safe to
// run on every boot. Without it, such repos stay stuck with no scheduled job
// and never surface commits/PRs in the intelligence board.
const githubBackfillQueueClient = makeGitHubQueueClient({
  hot: githubSyncHotQueue,
  warm: githubSyncWarmQueue,
  cold: githubSyncColdQueue,
})
try {
  await reconcileGitHubBackfills({
    prisma: db,
    queueClient: githubBackfillQueueClient,
    log: (message) => console.log(message),
  })
} catch (err) {
  console.error(
    `[GitHub backfill reconciler] failed: ${err instanceof Error ? err.message : String(err)}`,
  )
}

// Self-heal: re-establish the tier repeatable for EVERY active repo (not just
// un-backfilled ones). The repeatables live only in Redis (RDB-only, recreated
// on deploy); a wipe drops the schedule for already-backfilled repos and the
// backfill reconciler above skips them, so their scheduled sync stays dead
// forever. This restores it on the next boot. Idempotent, no immediate run.
try {
  await reconcileGitHubSchedules({
    prisma: db,
    queueClient: githubBackfillQueueClient,
    log: (message) => console.log(message),
  })
} catch (err) {
  console.error(
    `[GitHub schedule reconciler] failed: ${err instanceof Error ? err.message : String(err)}`,
  )
}

// Reference the queues so they aren't tree-shaken / treated as unused.
// (Queues are kept alive by being constructed; this satisfies the linter.)
void githubSyncHotQueue
void githubSyncWarmQueue
void githubSyncColdQueue

// ── Azure DevOps sync ───────────────────────────────────────────────────────

const adoQueue = new Queue('azure-devops-sync', { connection });
const adoAdapterFactory = (cfg: {
  orgUrl: string;
  authMethod: 'PAT' | 'BASIC';
  accessToken: string;
  username?: string;
}) => {
  if (process.env.USE_FAKE_AZURE_DEVOPS === 'true') {
    return new FakeAzureDevOpsAdapter();
  }
  return new AzureDevOpsRestAdapter({ ...cfg, throttle: adoThrottle });
};

const adoWorker = new Worker(
  'azure-devops-sync',
  async (job) => {
    const trigger = job.data?.trigger || 'scheduled';
    console.log(`Processing azure-devops-sync job (trigger: ${trigger})`);
    return handleAzureDevOpsSyncJob(job.data, db, adoAdapterFactory, chClientFor);
  },
  { connection },
);

adoWorker.on('completed', (job) => {
  console.log(`ADO job ${job.id} completed`);
});

adoWorker.on('failed', (job, err) => {
  console.error(`ADO job ${job?.id} failed: ${err.message}`);
});

// Enqueue ADO startup job
await adoQueue.add('azure-devops-sync', { trigger: 'startup' }, { jobId: 'ado-startup-job' });

// Schedule ADO repeating sync — on the slower ADO cadence, see adoRepeatInterval
await scheduleRepeatable(adoQueue, 'azure-devops-sync', { trigger: 'scheduled' }, adoRepeatInterval, 'ado-sync-scheduled');

// ── GitHub sync ─────────────────────────────────────────────────────────────

const ghQueue = new Queue('github-sync', { connection });
const ghAdapterFactory = (cfg: { baseUrl: string; accessToken: string }) => {
  if (process.env.USE_FAKE_GITHUB === 'true') {
    return new FakeGitHubAdapter();
  }
  return new GitHubRestAdapter({ baseUrl: cfg.baseUrl, accessToken: cfg.accessToken });
};

const ghProjectsAdapterFactory: GitHubProjectsAdapterFactory = (cfg: {
  baseUrl: string;
  accessToken: string;
}) => {
  if (process.env.USE_FAKE_GITHUB === 'true') {
    return new FakeGitHubProjectsAdapter();
  }
  return new GitHubProjectsGraphQLAdapter({ baseUrl: cfg.baseUrl, accessToken: cfg.accessToken });
};

const ghWorker = new Worker(
  'github-sync',
  async (job) => {
    const trigger = job.data?.trigger || 'scheduled';
    console.log(`Processing github-sync job (trigger: ${trigger})`);
    // The FACTORY goes down, not a client: handleGitHubSyncJob binds it per
    // GitHub instance, to the organization that owns that instance.
    return handleGitHubSyncJob(job.data, db, ghAdapterFactory, ghProjectsAdapterFactory, chClientFor);
  },
  { connection },
);

ghWorker.on('completed', (job) => {
  console.log(`GitHub job ${job.id} completed`);
});

ghWorker.on('failed', (job, err) => {
  console.error(`GitHub job ${job?.id} failed: ${err.message}`);
});

// Enqueue GitHub startup job
await ghQueue.add('github-sync', { trigger: 'startup' }, { jobId: 'gh-startup-job' });

// Schedule GitHub repeating sync
await scheduleRepeatable(ghQueue, 'github-sync', { trigger: 'scheduled' }, repeatInterval, 'gh-sync-scheduled');

// Each org-source sync builds a directory client from the tree's OWN stored token.
// Primary path: a user-pasted Graph access token (no app registration at all).
// Fallback: a delegated refresh token from the device-code flow (needs
// MICROSOFT_TENANT_ID + MICROSOFT_CLIENT_ID; secret optional). USE_FAKE_GRAPH swaps
// in a fake for local dev. If no usable token/config the factory throws, which the
// processor records as an actionable sync error (never a silent empty roster).
const microsoftOAuthConfigured = Boolean(
  process.env.MICROSOFT_TENANT_ID && process.env.MICROSOFT_CLIENT_ID,
)
const makeGraphClient = (tokens: {
  accessToken?: string | null
  refreshToken?: string | null
}): GraphDirectoryClient => {
  if (process.env.USE_FAKE_GRAPH === 'true') return new FakeGraphDirectoryClient([], {})
  // Pasted access token — used directly, no app registration required.
  if (tokens.accessToken) return new StaticTokenGraphDirectoryClient(tokens.accessToken)
  // Delegated refresh token (device-code) — needs the app-registration ids.
  if (tokens.refreshToken) {
    if (!microsoftOAuthConfigured) {
      throw new Error(
        'Microsoft Graph is not configured on the server (set MICROSOFT_TENANT_ID / MICROSOFT_CLIENT_ID)',
      )
    }
    return new DelegatedGraphDirectoryClient({
      tenantId: process.env.MICROSOFT_TENANT_ID as string,
      clientId: process.env.MICROSOFT_CLIENT_ID as string,
      clientSecret: process.env.MICROSOFT_CLIENT_SECRET || undefined,
      refreshToken: tokens.refreshToken,
    })
  }
  throw new Error('No Microsoft token available for this tree')
}

// ── Org-tree sync ──────────────────────────────────────────────────────────
const orgTreeSyncWorker = new Worker(
  'org-tree-sync',
  async (job) => {
    const treeId = job.data?.treeId as string
    console.log(`Processing org-tree-sync job for tree ${treeId}`)
    return handleOrgTreeSyncJob({ treeId }, db, chClientFor)
  },
  { connection },
)
orgTreeSyncWorker.on('failed', (job, err) =>
  console.error(`org-tree-sync ${job?.id} failed: ${err.message}`),
)

// ── Org-source sync (Microsoft Graph) ─────────────────────────────────────
const orgSourceSyncWorker = new Worker(
  'org-source-sync',
  async (job) => {
    const treeId = job.data?.treeId as string
    console.log(`Processing org-source-sync job for tree ${treeId}`)
    return handleOrgSourceSyncJob({ treeId }, db, makeGraphClient)
  },
  { connection },
)
orgSourceSyncWorker.on('failed', (job, err) =>
  console.error(`org-source-sync ${job?.id} failed: ${err.message}`),
)

// ── Calendar-source sync (recruitment board interviews via Microsoft Graph) ──
// A pasted Graph token is stored per board and passed into getCalendarView per call,
// so (unlike org-source) the client needs no per-tree token at construction.
const makeCalendarClient = (): CalendarClient =>
  process.env.USE_FAKE_GRAPH === 'true'
    ? new FakeCalendarClient([])
    : new GraphCalendarClient()

const calendarSourceSyncWorker = new Worker(
  'calendar-source-sync',
  async (job) => {
    const boardId = job.data?.boardId as string
    console.log(`Processing calendar-source-sync job for board ${boardId}`)
    return handleCalendarSourceSyncJob({ boardId }, db, makeCalendarClient())
  },
  { connection },
)
calendarSourceSyncWorker.on('failed', (job, err) =>
  console.error(`calendar-source-sync ${job?.id} failed: ${err.message}`),
)

// Self-heal: a sync killed mid-run (container restart / OOM / deploy) leaves its
// OrgTreeSource stuck at status 'syncing', which permanently disables the "Sync
// now" button in the Source tab. Reset any such orphaned row to 'error' with an
// actionable summary on boot. Only matches 'syncing' rows, so it's safe every boot.
try {
  await reconcileOrgSourceSync({ prisma: db, log: (message) => console.log(message) })
} catch (err) {
  console.error(
    `[org-source reconciler] failed: ${err instanceof Error ? err.message : String(err)}`,
  )
}

// ── Sync runs pruning ──────────────────────────────────────────────────────
// Delete sync_runs older than 7 days to prevent unbounded table growth.
async function pruneSyncRuns() {
  const threshold = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const result = await db.syncRun.deleteMany({
    where: { startedAt: { lt: threshold } },
  });
  if (result.count > 0) {
    console.log(`[Pruning] Deleted ${result.count} sync_runs older than 7 days`);
  }
}

// Prune on startup
await pruneSyncRuns();

// Schedule daily pruning
const pruneQueue = new Queue('sync-run-prune', { connection });
const pruneWorker = new Worker(
  'sync-run-prune',
  async () => { await pruneSyncRuns(); },
  { connection },
);
pruneWorker.on('failed', (_job, err) => {
  console.error(`Prune job failed: ${err.message}`);
});
await scheduleRepeatable(pruneQueue, 'sync-run-prune', {}, 24 * 60 * 60 * 1000, 'daily-prune');

// ── Notification maintenance: digest release + due-date evaluation ─────────
const notificationQueue = new Queue('notification-maintenance', { connection })
const notificationWorker = new Worker(
  'notification-maintenance',
  async () => {
    const result = await runNotificationMaintenance(db, new Date())
    if (result.digestsReleased > 0 || result.dueNotified > 0) {
      console.log(
        `[Notifications] released ${result.digestsReleased} digest(s), ${result.dueNotified} due reminder(s)`,
      )
    }
  },
  { connection },
)
notificationWorker.on('failed', (job, err) => {
  console.error(`Notification maintenance job ${job?.id} failed: ${err.message}`)
})
// Hourly: the digest window is measured PER USER from their oldest pending row,
// so the job only has to run often enough to notice one has matured.
await scheduleRepeatable(
  notificationQueue,
  'notification-maintenance',
  { trigger: 'scheduled' },
  60 * 60 * 1000,
  'notification-maintenance-scheduled',
)

const stopPeriodicWork = startPeriodicWork(edition)

console.log('Worker ready')

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('Received SIGTERM, closing worker...')
  stopPeriodicWork?.()
  await worker.close()
  await queue.close()
  await adoWorker.close()
  await adoQueue.close()
  await ghWorker.close()
  await ghQueue.close()
  await pruneWorker.close()
  await pruneQueue.close()
  await orgSourceSyncWorker.close()
  await calendarSourceSyncWorker.close()
  await db.$disconnect()
  process.exit(0)
})
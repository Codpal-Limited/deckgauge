import { DelayedError } from 'bullmq';
import {
  OrgConcurrencyGate,
  ORG_GATE_RETRY_DELAY_MS,
  ORG_GATE_JITTER_RATIO,
  ORG_GATE_DEFERRAL_WARN_THRESHOLD,
} from './org-concurrency-gate.js';

/**
 * The slice of the BullMQ `Job` surface this wrapper touches. Kept structural so
 * the gate is unit-testable without a Redis connection.
 */
export interface GatedJob<D = unknown> {
  id?: string;
  data: D;
  moveToDelayed(timestamp: number, token?: string): Promise<void>;
}

/** What `resolve` learned about a job: who owns it, and the row it loaded to find out. */
export interface ResolvedJob<C> {
  organizationId: string;
  /** Handed to `process` so the row is loaded ONCE, not once per phase. */
  context: C;
}

export interface DeferralInfo<D> {
  job: GatedJob<D>;
  organizationId: string;
  /** How many times this job id has been deferred by the gate. */
  deferrals: number;
  /**
   * True on the deferral that CROSSES the warn threshold, and only that one — so
   * a permanently stuck slot-holder produces one warning per job, not one per
   * job per retry interval.
   */
  warn: boolean;
  /** True when the deferral needed no database lookup (org was already known capped). */
  fromCache: boolean;
}

export interface OrgGatedProcessorOptions<D, C> {
  gate: OrgConcurrencyGate;
  /**
   * Load whatever the job needs and report the owning organization.
   *
   * Called ONLY when the gate is enabled — job payloads do not carry
   * `organizationId` (see STATE.md), so the owner has to be read off the row the
   * job points at, and a single-organization deployment must not pay for that.
   * The loaded row comes back as `context` and is handed to `process`, so
   * enabling the gate costs no EXTRA query: one load either way.
   */
  resolve: (job: GatedJob<D>) => Promise<ResolvedJob<C>>;
  /**
   * The real work. `context` is present exactly when the gate preloaded it (gate
   * enabled); when the gate is disabled it is undefined and `process` must load
   * what it needs itself, which is the pre-existing code path unchanged.
   */
  process: (job: GatedJob<D>, context?: C) => Promise<void>;
  now?: () => number;
  retryDelayMs?: number;
  jitterRatio?: number;
  random?: () => number;
  /** Bound on tracked ORGANIZATIONS in the memo (see JobMemo). */
  maxMemoOrganizations?: number;
  /** Backstop bound on total memoised jobs; eviction is still org-wise. */
  maxMemoJobs?: number;
  onDeferred?: (info: DeferralInfo<D>) => void;
}

interface MemoEntry {
  organizationId: string;
  deferrals: number;
}

/**
 * Remembers which organization each deferred job belongs to, and how many times
 * it has been deferred.
 *
 * KEYED OFF THE ORGANIZATION, and that is the whole point. The obvious
 * implementation — one LRU bounded by job count — has a cliff: a tenant with
 * more queued tier jobs than the bound cycles its own entries out before any job
 * returns, so every deferral misses the memo, the per-job Postgres lookup comes
 * back at N queries per retry interval, and the deferral counters reset so the
 * hung-slot warning never fires. That is this slice's own failure mode
 * reappearing exactly when the backlog is worst.
 *
 * So eviction drops a whole organization at a time, least-recently-seen first. A
 * capped organization's backlog is therefore memoised in full or not at all —
 * never half, which is the state that silently degrades. Shedding one whole
 * organization degrades gracefully (it pays lookups again); shedding scattered
 * entries across every organization degrades everywhere at once.
 *
 * Both facts live in ONE entry per job so they cannot expire on different
 * schedules.
 */
class JobMemo {
  private readonly byJobId = new Map<string, MemoEntry>();
  /** organizationId -> its job ids. Insertion order = organization recency. */
  private readonly jobIdsByOrg = new Map<string, Set<string>>();

  constructor(
    private readonly maxOrganizations: number,
    private readonly maxJobs: number,
  ) {}

  get(jobId: string): MemoEntry | undefined {
    return this.byJobId.get(jobId);
  }

  /** Record (or bump) this job's deferral, returning the new count. */
  recordDeferral(jobId: string, organizationId: string): number {
    const existing = this.byJobId.get(jobId);
    const deferrals = (existing?.deferrals ?? 0) + 1;
    this.byJobId.set(jobId, { organizationId, deferrals });

    const ids = this.jobIdsByOrg.get(organizationId);
    if (ids) {
      // Re-insert so this organization becomes most-recently-seen.
      this.jobIdsByOrg.delete(organizationId);
      this.jobIdsByOrg.set(organizationId, ids);
      ids.add(jobId);
    } else {
      this.jobIdsByOrg.set(organizationId, new Set([jobId]));
    }

    this.evict();
    return deferrals;
  }

  /** A job actually ran: it is no longer waiting, so drop its entry. */
  forgetJob(jobId: string): void {
    const entry = this.byJobId.get(jobId);
    if (!entry) return;
    this.byJobId.delete(jobId);
    const ids = this.jobIdsByOrg.get(entry.organizationId);
    if (!ids) return;
    ids.delete(jobId);
    if (ids.size === 0) this.jobIdsByOrg.delete(entry.organizationId);
  }

  forgetOrganization(organizationId: string): void {
    const ids = this.jobIdsByOrg.get(organizationId);
    if (!ids) return;
    for (const id of ids) this.byJobId.delete(id);
    this.jobIdsByOrg.delete(organizationId);
  }

  private evict(): void {
    while (this.jobIdsByOrg.size > this.maxOrganizations || this.byJobId.size > this.maxJobs) {
      const oldest = this.jobIdsByOrg.keys().next().value;
      if (oldest === undefined) break;
      this.forgetOrganization(oldest);
    }
  }

  get trackedJobs(): number {
    return this.byJobId.size;
  }

  get trackedOrganizations(): number {
    return this.jobIdsByOrg.size;
  }
}

/** Exported for its own tests — the bound is a behavioural claim, so it is asserted. */
export const __testables = { JobMemo };

/**
 * Wrap a BullMQ processor so at most `gate.maxPerOrg` of its jobs run
 * concurrently for any one organization.
 *
 * A job over the cap is moved to the delayed set and abandoned with
 * `DelayedError` — the BullMQ-sanctioned way to hand the worker slot back
 * WITHOUT counting a failed attempt against the job. Throwing an ordinary error
 * instead would burn the job's retry budget and eventually dead-letter a job
 * whose only sin was arriving while its tenant was busy.
 */
export function makeOrgGatedProcessor<D, C>(
  opts: OrgGatedProcessorOptions<D, C>,
): (job: GatedJob<D>, token?: string) => Promise<void> {
  const now = opts.now ?? Date.now;
  const random = opts.random ?? Math.random;
  const retryDelayMs = opts.retryDelayMs ?? ORG_GATE_RETRY_DELAY_MS;
  const jitterRatio = opts.jitterRatio ?? ORG_GATE_JITTER_RATIO;

  // Repo-to-organization ownership is effectively immutable, so memoising it is
  // safe — and it is what lets an already-capped organization's jobs be deferred
  // with NO database query at all.
  const memo = new JobMemo(opts.maxMemoOrganizations ?? 512, opts.maxMemoJobs ?? 200_000);

  async function defer(
    job: GatedJob<D>,
    organizationId: string,
    token: string | undefined,
    fromCache: boolean,
  ): Promise<never> {
    const deferrals = memo.recordDeferral(job.id ?? '', organizationId);

    opts.onDeferred?.({
      job,
      organizationId,
      deferrals,
      // Strictly the crossing, so the caller can log once rather than forever.
      warn: deferrals === ORG_GATE_DEFERRAL_WARN_THRESHOLD,
      fromCache,
    });

    const jittered = retryDelayMs * (1 + random() * jitterRatio);
    await job.moveToDelayed(now() + Math.round(jittered), token);
    throw new DelayedError();
  }

  return async function gatedProcessor(job: GatedJob<D>, token?: string): Promise<void> {
    // Disabled cap = the pre-existing code path, byte for byte: no organization
    // lookup, no counter, no possibility of deferral.
    if (!opts.gate.isEnabled()) {
      await opts.process(job);
      return;
    }

    const jobKey = job.id ?? '';

    // Cheap path first: if this job's organization is already known to be at its
    // cap, defer without loading anything.
    const remembered = memo.get(jobKey);
    if (remembered && opts.gate.isCappedUntil(remembered.organizationId, now())) {
      return defer(job, remembered.organizationId, token, true);
    }

    const { organizationId, context } = await opts.resolve(job);

    if (!opts.gate.tryAcquire(organizationId)) {
      // Remember the refusal so the org's other queued jobs skip the lookup.
      opts.gate.markCapped(organizationId, now() + retryDelayMs);
      return defer(job, organizationId, token, false);
    }

    try {
      memo.forgetJob(jobKey);
      await opts.process(job, context);
    } finally {
      // `finally`, not the happy path: a throwing sync must not strand the slot,
      // or one crashing tenant would ratchet itself down to zero capacity.
      opts.gate.release(organizationId);
    }
  };
}

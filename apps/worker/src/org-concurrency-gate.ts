/**
 * Per-organization concurrency cap for BullMQ job processing.
 *
 * WHY AN APPLICATION-LEVEL GATE RATHER THAN A BULLMQ FACILITY
 *
 * BullMQ OSS offers two throttles, and neither expresses "per tenant":
 *
 *  - `limiter: { max, duration }` on a Worker is a QUEUE-WIDE token bucket. One
 *    noisy organization exhausting it stalls every other tenant on that queue,
 *    which is the failure this cap exists to prevent, not a cure for it.
 *  - Per-group concurrency (`group: { id }`) — the facility that would model this
 *    directly — is a BullMQ **Pro** feature, i.e. a paid dependency. The hosted
 *    plan (see the hosted-SaaS program design §3) budgets ≈€6.50/mo of infra in
 *    total, so a paid queue licence is out of proportion to the whole offering.
 *
 * So the gate lives in the process: a counter per organization, consulted before
 * a job starts real work and released when it finishes. A refused job is pushed
 * back onto the delayed set (`Job.moveToDelayed`) instead of occupying the
 * worker slot, which is what lets a quieter tenant's job take that slot.
 *
 * SCOPE HONESTY: this is an in-process counter, so the cap binds per worker
 * process. The pooled deployment runs a single worker container (program design
 * §3), so process-local and cluster-wide coincide today. A second worker replica
 * would multiply the effective cap by the replica count and this would need to
 * move to a Redis counter — noted here so that is a deliberate decision later
 * rather than a silent regression.
 */
export class OrgConcurrencyGate {
  private readonly inFlightByOrg = new Map<string, number>();
  /**
   * organizationId -> timestamp until which this org is known to be at its cap.
   *
   * Exists to stop LOAD AMPLIFICATION, not to make the decision. A `DelayedError`
   * makes BullMQ immediately pull the next job with no pause, so a capped
   * organization with N ready jobs would otherwise re-run the full
   * resolve-then-refuse path N times every retry interval — N Prisma queries and
   * N log lines per cycle, indefinitely, against a Postgres this deployment caps
   * at 256 MiB. That is load amplification in exactly the scenario this cap
   * exists to prevent. With this, a job whose organization is already known to be
   * capped is deferred without touching the database.
   */
  private readonly cappedUntilByOrg = new Map<string, number>();

  /**
   * @param maxPerOrg Maximum jobs one organization may run at once.
   *   Zero or negative disables the gate entirely — every acquire is admitted.
   *   Disabled is the DEFAULT, so a single-organization deployment (every
   *   self-host and the open-source distribution) behaves exactly as it did
   *   before this class existed.
   */
  constructor(private readonly maxPerOrg: number) {}

  /** True when the cap can actually refuse something. */
  isEnabled(): boolean {
    return this.maxPerOrg > 0;
  }

  /**
   * Reserve a slot for `organizationId`. Returns false when the organization is
   * already at its cap; a refusal reserves nothing, so the caller must NOT
   * release after a false return.
   */
  tryAcquire(organizationId: string): boolean {
    if (!this.isEnabled()) return true;
    const current = this.inFlightByOrg.get(organizationId) ?? 0;
    if (current >= this.maxPerOrg) return false;
    this.inFlightByOrg.set(organizationId, current + 1);
    return true;
  }

  /** Give the slot back. Safe to call more often than acquired; never goes negative. */
  release(organizationId: string): void {
    if (!this.isEnabled()) return;
    const current = this.inFlightByOrg.get(organizationId) ?? 0;
    const next = current - 1;
    // Delete rather than store 0: the worker is long-lived and the tenant count
    // is unbounded, so keeping a zero entry per organization ever seen would be
    // a slow leak in the very process this slice is trying to keep inside its
    // memory ceiling.
    if (next <= 0) this.inFlightByOrg.delete(organizationId);
    else this.inFlightByOrg.set(organizationId, next);
    // A slot just freed up, so the "already capped" shortcut is stale.
    this.clearCapped(organizationId);
  }

  /** Jobs currently holding a slot for this organization. */
  inFlight(organizationId: string): number {
    return this.inFlightByOrg.get(organizationId) ?? 0;
  }

  /** Organizations currently tracked — asserts the map does not leak entries. */
  trackedOrganizations(): number {
    return this.inFlightByOrg.size;
  }

  /**
   * Record that this organization was found at its cap, so the next job for it
   * can be deferred without a database lookup until `untilMs`.
   */
  markCapped(organizationId: string, untilMs: number): void {
    if (!this.isEnabled()) return;
    this.cappedUntilByOrg.set(organizationId, untilMs);
  }

  /**
   * True when this organization was recently found at its cap and the window has
   * not elapsed. Expired entries are dropped on read, which is enough to keep the
   * map bounded by the number of CURRENTLY capped organizations rather than every
   * organization ever capped.
   */
  isCappedUntil(organizationId: string, nowMs: number): boolean {
    const until = this.cappedUntilByOrg.get(organizationId);
    if (until === undefined) return false;
    if (nowMs >= until) {
      this.cappedUntilByOrg.delete(organizationId);
      return false;
    }
    return true;
  }

  /**
   * Clear the capped mark. Called on release: a freed slot means the next job for
   * this organization should be reconsidered immediately rather than sitting out
   * the rest of the retry interval.
   */
  clearCapped(organizationId: string): void {
    this.cappedUntilByOrg.delete(organizationId);
  }

  /** Organizations currently marked capped — asserts this map does not leak either. */
  trackedCappedOrganizations(): number {
    return this.cappedUntilByOrg.size;
  }
}

/** Cap of 0 (disabled) unless the operator sets a positive value. */
export const DEFAULT_MAX_JOBS_PER_ORG = 0;

/**
 * How long a refused job waits before it is retried. Short enough that a freed
 * slot is picked up promptly, long enough that a capped-out organization with
 * many queued jobs does not spin the worker re-delaying them.
 */
export const ORG_GATE_RETRY_DELAY_MS = 5_000;

/**
 * Fraction of the retry delay added as random jitter. Without it, a capped
 * organization's N deferred jobs all become ready in the same millisecond and
 * stampede the worker together every interval; with it they spread out and the
 * freed slot goes to whichever arrives first.
 */
export const ORG_GATE_JITTER_RATIO = 0.5;

/**
 * Deferrals of a single job after which the gate logs a warning. It keeps
 * deferring — it does NOT fail the job or let it through. Both alternatives are
 * worse: failing dead-letters customer sync work over a fairness policy, and
 * letting it through means a tenant with a large backlog eventually bypasses the
 * cap wholesale, which is the monopolisation this exists to prevent. The counter
 * exists so a slot held by a hung job is visible rather than silent.
 */
export const ORG_GATE_DEFERRAL_WARN_THRESHOLD = 60;

/** Parse the operator-facing env value, ignoring anything non-numeric. */
export function resolveMaxJobsPerOrg(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_MAX_JOBS_PER_ORG;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_MAX_JOBS_PER_ORG;
  return Math.floor(parsed);
}

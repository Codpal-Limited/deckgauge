/**
 * The payload an API route puts on a sync queue, defined ONCE for both processes.
 *
 * ## Why this is in `packages/shared` and not written inline at each enqueue site
 *
 * It was written inline at every enqueue site, and the drift that caused is exactly
 * the defect this module exists to prevent. `POST /github/sync` and
 * `POST /azure-devops/sync` enqueued `{ trigger: 'manual' }` with no tenant, and the
 * worker handlers loaded every organization's connections — one tenant's member spent
 * every other tenant's credentials. The first fix scoped the handlers and two of the
 * routes, and **broke `POST /intelligence/sync`**, which enqueues to all four queues
 * from a seventh site nobody had scoped: the handler refused the now-invalid payload,
 * the route had already answered `202`, and the UI reported success while nothing
 * synced.
 *
 * The API and the worker are separate processes, so the payload is a wire contract
 * across a boundary that no compiler checks end to end. Two copies of a wire contract
 * is one copy too many. Building it here means:
 *
 *   - an enqueue site cannot omit the tenant — `organizationId` is a required
 *     parameter, not an optional field somebody remembers to set;
 *   - a **worker** test can import this and drive a handler with the payload the route
 *     actually sends, rather than a synthesised one that agrees with the test's own
 *     assumptions. That is the test that would have caught the regression above, and
 *     it is why this lives in `shared` rather than in `apps/api`.
 */

/** Triggers whose purpose is to sweep every tenant. Only the worker's own boot and cron. */
export type SweepingSyncTrigger = 'scheduled' | 'startup';

/** A sync asked for by a person, on behalf of exactly one organization. */
export interface ManualSyncJobPayload {
  trigger: 'manual';
  /**
   * The organization whose member asked for the sync, and the only thing that keeps
   * the worker from touching every tenant's connections. Required, deliberately: an
   * optional tenant on a manual job is what produced the original defect.
   */
  organizationId: string;
}

/** A sweep with no person behind it, and therefore no tenant to attribute it to. */
export interface SweepSyncJobPayload {
  trigger: SweepingSyncTrigger;
}

export type SyncJobPayload = ManualSyncJobPayload | SweepSyncJobPayload;

/**
 * The payload for a person-initiated sync. Use this at EVERY manual enqueue site.
 *
 * Takes the organization as its only argument so the call site cannot compile without
 * having resolved one — the routes get it from `requireOrganizationId(req)` (behind an
 * `orgRole` policy) or from `req.membership`, answering 403 `NO_ORGANIZATION` when
 * there is none.
 */
export function manualSyncJobPayload(organizationId: string): ManualSyncJobPayload {
  return { trigger: 'manual', organizationId };
}

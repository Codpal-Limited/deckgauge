/**
 * Decides which organizations' connections a sync job is allowed to touch.
 *
 * ## The defect this exists to close
 *
 * `POST /github/sync`, `POST /azure-devops/sync` and `POST /intelligence/sync` are
 * `ORG_MEMBER`/`ADMIN` routes whose handlers took `_req` — they read no caller — and
 * enqueued `{ trigger: 'manual' }` carrying no scope. **Seven** sync handlers then
 * loaded their connections with an unscoped read, so one organization's member
 * triggered a sync of EVERY tenant's connections: their stored credentials spent,
 * their provider rate limit burned, and rows written (`SyncRun`, `Project`,
 * ClickHouse) attributed to that sync. Inert while the deployment holds one
 * organization; live the moment it holds two.
 *
 * `ADMIN` is not an instance-only role, which is what made the intelligence route the
 * worst of them: `policy.ts` tests `ctx.isAdmin`, and `keycloak-auth.plugin.ts` sets
 * that for `membership.role === 'ADMIN'`. So an ORGANIZATION admin of one tenant could
 * spend every other tenant's Atlassian and Azure DevOps tokens.
 *
 * ## Why this is a shared function and not seven `where` clauses
 *
 * The predicate belongs to the step that turns a job into work, so that the tenant and
 * the work cannot come from different places — the shape
 * `feature/board-reverse-index-tenancy` settled on. Seven copies of the rule would be
 * seven chances to get the fail-closed branch wrong, and this rule's whole value is in
 * its default.
 *
 * ## Why absence is REFUSED and not swept
 *
 * `organizationId?: string` where "absent" quietly means "every tenant" is precisely
 * the footgun that produced the defect, so a manual job is never allowed to mean that
 * by omission. A manual job must NAME a scope. Sweeping is reserved for the triggers
 * whose purpose is to sweep, and — see `SWEEPING_TRIGGERS` below — it must say so
 * explicitly rather than by leaving a field out.
 */

/**
 * Triggers that legitimately cross tenants: the worker's own boot and its cron. No
 * caller is behind either, so there is no tenant to attribute them to, and syncing
 * every connection is the entire point.
 */
const SWEEPING_TRIGGERS = new Set(['scheduled', 'startup']);

export interface SyncJobScopeInput {
  trigger?: string | null;
  /** Narrows to one connection. Set by the per-board path. */
  instanceId?: string;
  /** The organization whose member asked for this sync. Set by the manual routes. */
  organizationId?: string;
}

export type SyncJobScope =
  | {
      allowed: true;
      /**
       * The organization to narrow the connection load to, or `undefined` for a
       * deliberate deployment-wide sweep.
       *
       * Returned raw rather than as a ready-made `where` because the handlers do not
       * share a predicate shape: most filter an instance table directly
       * (`{ organizationId }`), while GitLab filters `gitLabProjectSync` through its
       * parent (`{ gitlabInstance: { organizationId } }`) and the GitHub fan-out
       * filters `gitHubRepoSync` through `githubInstance`. `undefined` is only ever
       * returned for an EXPLICIT sweeping trigger — never because a field was missing.
       */
      organizationId: string | undefined;
    }
  | { allowed: false; reason: string };

/**
 * `instanceId` narrows further, but it does NOT replace the tenant predicate.
 *
 * A job may carry both, and when it does both are applied: the tenant on the query and
 * the instance on top of it. The reason matters — the connection rows carry plaintext
 * `apiToken`/`accessToken`, so a query that fetches every tenant's row and discards the
 * wrong ones in the loop has already read credentials it had no business reading. An
 * instance-scoped job that carries no organization is still accepted, because the only
 * enqueuer that does that is `board-sync.service.ts`, which derives the ids from
 * `board*Source` rows of ONE board the caller holds EDITOR on — the tenant was enforced
 * at the boundary, by the board policy, before the id existed. For that path the trust
 * boundary is the enqueuing code, not this function.
 */
export function resolveSyncJobScope(
  // Nullish-tolerant on purpose. BullMQ deserialises absent job data to `{}`, but the
  // five worker call sites used to guard that themselves with
  // `job.data ?? { trigger: 'scheduled' }` — inventing a SWEEPING trigger, outside this
  // function, in the one place this function cannot see. Accepting nullish here and
  // refusing it means no call site needs a default, so none can pick the wrong one.
  jobData: SyncJobScopeInput | null | undefined,
): SyncJobScope {
  const { trigger, organizationId, instanceId } = jobData ?? {};

  // Most specific wins: an explicit organization scopes the job whatever the trigger,
  // so a per-tenant cron could be added without revisiting this rule.
  if (organizationId) {
    return { allowed: true, organizationId };
  }

  // A sweep must SAY it is a sweep. There is deliberately no default here: the previous
  // version fell back to `trigger || 'scheduled'`, which made a job with a missing,
  // null or empty trigger sweep every tenant while a job with a typo (`'MANUAL'`) was
  // refused — stricter about a typo than about an absent field, which is the exact
  // drift direction this helper exists to prevent. A replayed or truncated job omits
  // fields; it does not invent trigger strings.
  if (typeof trigger === 'string' && SWEEPING_TRIGGERS.has(trigger)) {
    return { allowed: true, organizationId: undefined };
  }

  if (instanceId) {
    return { allowed: true, organizationId: undefined };
  }

  return {
    allowed: false,
    reason:
      `Refusing a sync job with trigger ${JSON.stringify(trigger)} that names no ` +
      `scope: it has neither an organizationId nor an instanceId, and only an ` +
      `explicit "scheduled" or "startup" trigger may cross tenants. Syncing every ` +
      `organization's connections would spend other tenants' credentials. The ` +
      `enqueuing route must pass the caller's organizationId — build the payload with ` +
      `\`manualSyncJobPayload\` from @deckgauge/shared.`,
  };
}

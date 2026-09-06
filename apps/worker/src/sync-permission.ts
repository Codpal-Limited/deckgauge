import type { WorkerEditionModule } from './edition-loader.js';

/**
 * Whether an organization may SYNC — call its providers' APIs and write board rows
 * to Postgres — according to the loaded edition module.
 *
 * **Why this exists next to `createIngestPermission`, which looks identical.**
 * That one is bound to a single organization at construction, because it hangs off
 * `chClientFor(organizationId)` — the one place every ClickHouse write passes
 * through with a tenant already bound. It gates the ClickHouse write and nothing
 * else. This one takes the organization per call, because a sync JOB is not
 * per-tenant: `handleSyncJob` and its siblings select every provider instance the
 * job's scope allows and iterate them, and those instances can belong to different
 * organizations.
 *
 * **What it fixes.** The product told expired customers "editing and data syncing
 * are paused" while only the ClickHouse write was gated. Jobs still ran, still
 * called the customer's Jira/GitHub/ADO/GitLab APIs on their credentials, and still
 * created and updated board rows in Postgres. So the sentence was false in both
 * directions that matter: we kept consuming a non-paying customer's API quota, and
 * their board kept changing under a notice saying it would not.
 *
 * **Community (no module, or no hook) always allows.** The free product has no such
 * restriction at all, rather than a disabled one.
 *
 * When a module IS present and its hook throws, this fails CLOSED — the same
 * asymmetry `createIngestPermission` documents, for the same reason: skipping a
 * sync is recoverable because the next run catches up, and syncing for an
 * organization that should not be is not.
 */
export interface SyncPermission {
  allowed(organizationId: string): Promise<boolean>;
}

export function createSyncPermission(
  edition: WorkerEditionModule | null,
  log: (message: string) => void = console.warn,
): SyncPermission {
  // Keyed by organization and holding the PROMISE rather than the resolved value:
  // a handler filters a whole instance list at once, so two instances of one tenant
  // resolve concurrently and a value cache would still make two calls.
  const inFlight = new Map<string, Promise<boolean>>();

  return {
    async allowed(organizationId: string): Promise<boolean> {
      const hook = edition?.allowIngest;
      if (!hook) return true;

      const cached = inFlight.get(organizationId);
      if (cached) return cached;

      const resolving = hook.call(edition, organizationId).catch((err: unknown) => {
        log(
          `[edition] allowIngest failed for organization ${organizationId}; pausing sync: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return false;
      });
      inFlight.set(organizationId, resolving);
      return resolving;
    },
  };
}

/** The minimum a provider instance must expose to be gated. */
export interface SyncableInstance {
  id: string;
  organizationId: string;
}

/**
 * Splits a provider-instance list into the ones that may sync and the ones that may
 * not.
 *
 * This sits between the `findMany` and the loop in every sync handler, which is the
 * earliest point where the organization is known — the job itself carries no single
 * tenant. Filtering here, rather than checking inside the loop body, means a
 * restricted organization's credentials are never used and its board rows are never
 * touched, instead of being decided after the provider has already been called.
 *
 * Skipped instances are RETURNED rather than silently dropped: a sync that stops
 * without saying why reads as a broken sync, and that produces a support ticket
 * rather than a payment.
 */
export async function filterSyncableInstances<T extends SyncableInstance>(
  instances: readonly T[],
  permission: SyncPermission,
): Promise<{ syncable: T[]; skipped: T[] }> {
  if (instances.length === 0) return { syncable: [], skipped: [] };

  const verdicts = await Promise.all(
    instances.map(async (instance) => ({
      instance,
      allowed: await permission.allowed(instance.organizationId),
    })),
  );

  return {
    syncable: verdicts.filter((v) => v.allowed).map((v) => v.instance),
    skipped: verdicts.filter((v) => !v.allowed).map((v) => v.instance),
  };
}

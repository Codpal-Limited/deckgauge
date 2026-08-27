import type { PrismaClient } from '@deckgauge/db';
import type { JiraPort, JiraConfig } from '@deckgauge/shared';
import type { ChClientFactory } from './jira-dual-writer.js';
import { jiraSyncProcessor } from './jira-sync.processor.js';
import { resolveSyncJobScope } from './sync-job-scope.js';

export interface SyncJobData {
  trigger?: string;
  /** When set, only sync this specific instance. */
  instanceId?: string;
  /** When set, sync only these project keys instead of all keys on the instance. */
  projectKeys?: string[];
  /**
   * The organization whose member asked for this sync.
   *
   * Set by the manual trigger routes from the caller's membership. Absence NEVER
   * means "every tenant" for a manual job — see `resolveSyncJobScope`, which refuses
   * a manual job naming no scope rather than sweeping. Scheduled and startup sweeps
   * legitimately omit it.
   */
  organizationId?: string;
}

export interface SyncJobResult {
  instance: string;
  status?: string;
  trigger?: string;
  epicCount?: number;
  issueCount?: number;
  finishedAt?: Date | null;
  errorMessage?: string | null;
  error?: string;
  skipped?: boolean;
}

export type AdapterFactory = (config: JiraConfig) => JiraPort;

export async function handleSyncJob(
  jobData: SyncJobData,
  db: PrismaClient,
  adapterFactory: AdapterFactory,
  /**
   * Builds a ClickHouse client bound to one organization. Called once per
   * instance below, with THAT instance's organizationId — the connections this
   * job iterates can belong to different tenants.
   */
  chClientFor?: ChClientFactory,
): Promise<SyncJobResult[]> {
  const trigger = jobData.trigger || 'scheduled';
  const scopedInstanceId = jobData.instanceId;
  const scopedProjectKeys = jobData.projectKeys;

  // The tenant boundary of this handler. `resolveSyncJobScope` is fail-closed: a
  // manual job that names no scope is refused here rather than sweeping every
  // organization's connections. See sync-trigger-tenancy.test.ts.
  const scope = resolveSyncJobScope(jobData);
  if (!scope.allowed) {
    console.error(`[Jira sync] ${scope.reason}`);
    return [{ instance: 'none', skipped: true, error: scope.reason }];
  }

  // BOTH predicates, on the query. The instance narrowing used to happen only in the
  // loop below (`continue`), which meant an instance-scoped job still SELECTed every
  // tenant's row — and these rows carry the plaintext access token. Discarding a
  // credential after reading it is not scoping it.
  //
  // `undefined`, not `{}`, for the no-filter case: Prisma's generated overload for
  // this model accepts `{ where } | undefined`, and `{}` widens the union past it
  // (TS2345).
  const instanceWhere = {
    ...(scope.organizationId ? { organizationId: scope.organizationId } : {}),
    ...(scopedInstanceId ? { id: scopedInstanceId } : {}),
  };
  const instances = await db.jiraInstance.findMany(
    Object.keys(instanceWhere).length > 0 ? { where: instanceWhere } : undefined,
  );
  if (instances.length === 0) {
    console.log('No Jira instances configured — skipping sync');
    return [{ instance: 'none', skipped: true }];
  }

  const results: SyncJobResult[] = [];

  for (const instance of instances) {
    // If scoped to a specific instance, skip all others
    if (scopedInstanceId && instance.id !== scopedInstanceId) continue;

    // For scoped syncs, use the job-specified keys.
    // For full syncs, iterate JiraProjectSync rows for this instance (multi-board model).
    // Fall back to instance.projectKeys only when no project-sync rows exist at all
    // (e.g. freshly bootstrapped from YAML before any sync row is created).
    let projectKeys: string[];
    const syncConfigMap = new Map<string, string>();

    if (scopedProjectKeys) {
      projectKeys = scopedProjectKeys;
      const scopedSyncs = await db.jiraProjectSync.findMany({
        where: { jiraInstanceId: instance.id, jiraProjectKey: { in: scopedProjectKeys } },
        select: { id: true, jiraProjectKey: true },
      });
      for (const ps of scopedSyncs) {
        syncConfigMap.set(ps.jiraProjectKey, ps.id);
      }
    } else {
      const projectSyncs = await db.jiraProjectSync.findMany({
        where: { jiraInstanceId: instance.id },
        select: { id: true, jiraProjectKey: true },
      });
      const syncKeys = projectSyncs.map((ps) => ps.jiraProjectKey);
      projectKeys = syncKeys.length > 0
        ? syncKeys
        : (instance.projectKeys as string[]);
      for (const ps of projectSyncs) {
        syncConfigMap.set(ps.jiraProjectKey, ps.id);
      }
    }

    try {
      // Bind ClickHouse to the organization that owns THIS connection. Inside
      // the loop, never outside it: two instances here can belong to two
      // different tenants.
      const ch = chClientFor?.(instance.organizationId);

      const adapter = adapterFactory({
        atlassianUrl: instance.atlassianUrl,
        email: instance.email,
        apiToken: instance.apiToken,
        projectKeys,
      });

      const result = await jiraSyncProcessor({
        adapter,
        projectKeys,
        trigger,
        db,
        syncConfigMap,
        ch,
        instanceId: instance.id,
        // The tenant of THIS connection, read inside the loop for the same
        // reason `ch` is: the instances iterated here can belong to different
        // organizations. It is stamped on the SyncRun the processor writes.
        organizationId: instance.organizationId,
      });
      results.push({ instance: instance.name, ...result });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`Sync failed for instance "${instance.name}": ${errorMessage}`);
      results.push({ instance: instance.name, status: 'FAILED', error: errorMessage });
    }
  }

  return results;
}

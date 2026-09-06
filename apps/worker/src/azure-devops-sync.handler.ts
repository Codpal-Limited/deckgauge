import type { PrismaClient } from '@deckgauge/db';
import type { AzureDevOpsPort } from '@deckgauge/shared';
import type { ChClientFactory } from './jira-dual-writer.js';
import { azureDevOpsSyncProcessor } from './azure-devops-sync.processor.js';
import { resolveSyncJobScope } from './sync-job-scope.js';
import {
  createSyncPermission,
  filterSyncableInstances,
  type SyncPermission,
} from './sync-permission.js';

export interface AzureDevOpsSyncJobData {
  trigger?: string;
  instanceId?: string;
  projects?: string[];
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

export interface AzureDevOpsSyncJobResult {
  instance: string;
  status?: string;
  trigger?: string;
  workItemCount?: number;
  finishedAt?: Date | null;
  errorMessage?: string | null;
  error?: string;
  skipped?: boolean;
}

export type AzureDevOpsAdapterFactory = (config: {
  orgUrl: string;
  authMethod: 'PAT' | 'BASIC';
  accessToken: string;
  username?: string;
}) => AzureDevOpsPort;

export async function handleAzureDevOpsSyncJob(
  jobData: AzureDevOpsSyncJobData,
  db: PrismaClient,
  adapterFactory: AzureDevOpsAdapterFactory,
  /**
   * Builds a ClickHouse client bound to one organization. Called once per
   * instance below, with THAT instance's organizationId — the ADO connections
   * this job iterates can belong to different tenants.
   */
  chClientFor?: ChClientFactory,
  /**
   * Whether each instance's organization may sync at all. Optional, and absent
   * means allow — the Community behaviour.
   */
  syncPermission: SyncPermission = createSyncPermission(null),
): Promise<AzureDevOpsSyncJobResult[]> {
  const trigger = jobData.trigger || 'scheduled';
  const scopedInstanceId = jobData.instanceId;
  const scopedProjects = jobData.projects;

  // The tenant boundary of this handler. `resolveSyncJobScope` is fail-closed: a
  // manual job that names no scope is refused here rather than sweeping every
  // organization's connections. See sync-trigger-tenancy.test.ts.
  const scope = resolveSyncJobScope(jobData);
  if (!scope.allowed) {
    console.error(`[Azure DevOps sync] ${scope.reason}`);
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
  const instances = await db.azureDevOpsInstance.findMany(
    Object.keys(instanceWhere).length > 0 ? { where: instanceWhere } : undefined,
  );
  if (instances.length === 0) {
    console.log('No Azure DevOps instances configured — skipping sync');
    return [{ instance: 'none', skipped: true }];
  }

  // BEFORE the loop — see the note in jira-sync.handler.ts. Deciding inside the
  // loop would mean the customer's ADO token had already been used. This one also
  // carries a contractual edge: Microsoft's API terms govern what we may do with
  // data obtained through their APIs, so not calling them at all for an
  // organization we have paused is the cleaner position.
  const { syncable, skipped } = await filterSyncableInstances(instances, syncPermission);
  const results: AzureDevOpsSyncJobResult[] = skipped.map((instance) => {
    console.log(
      `[ADO sync] skipping instance ${instance.id}: organization ${instance.organizationId} may not sync`,
    );
    return { instance: instance.id, skipped: true, trigger, status: 'billing_paused' };
  });

  for (const instance of syncable) {
    if (scopedInstanceId && instance.id !== scopedInstanceId) continue;

    // Determine which ADO projects to sync.
    //
    // New (P5) model: AzureDevOpsProjectSync rows are the source of truth — one
    // row per (instance, adoProject). Fall back to instance.projects only when
    // no project-sync rows exist at all (e.g. freshly bootstrapped before any
    // project sync row is created).
    let projects: string[];
    if (scopedProjects) {
      projects = scopedProjects;
    } else {
      const projectSyncs = await db.azureDevOpsProjectSync.findMany({
        where: { azureDevOpsInstanceId: instance.id },
        select: { adoProject: true },
      });
      const syncProjectNames = projectSyncs.map((ps) => ps.adoProject);
      projects =
        syncProjectNames.length > 0 ? syncProjectNames : (instance.projects as string[]);
    }

    try {
      // Bind ClickHouse to the organization that owns THIS instance — inside the
      // loop, so a second instance on another tenant gets its own client.
      const ch = chClientFor?.(instance.organizationId);

      const adapter = adapterFactory({
        orgUrl: instance.orgUrl,
        authMethod: instance.authMethod as 'PAT' | 'BASIC',
        accessToken: instance.accessToken,
        username: instance.username ?? undefined,
      });

      const result = await azureDevOpsSyncProcessor({
        adapter,
        projects,
        trigger,
        db,
        ch,
        orgUrl: instance.orgUrl,
        instanceId: instance.id,
        // The tenant of THIS instance, read inside the loop for the same reason
        // `ch` is. Stamped on the SyncRun the processor writes.
        organizationId: instance.organizationId,
      });
      results.push({
        instance: instance.id,
        status: result.status,
        trigger: result.trigger,
        workItemCount: result.workItemCount,
        finishedAt: result.finishedAt,
        errorMessage: result.errorMessage,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`Azure DevOps sync failed for instance "${instance.id}": ${errorMessage}`);
      results.push({ instance: instance.id, status: 'FAILED', error: errorMessage });
    }
  }

  return results;
}

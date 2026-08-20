import type { PrismaClient } from '@deckgauge/db';
import type { AzureDevOpsPort } from '@deckgauge/shared';
import type { ChClientFactory } from './jira-dual-writer.js';
import { azureDevOpsSyncProcessor } from './azure-devops-sync.processor.js';

export interface AzureDevOpsSyncJobData {
  trigger?: string;
  instanceId?: string;
  projects?: string[];
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
): Promise<AzureDevOpsSyncJobResult[]> {
  const trigger = jobData.trigger || 'scheduled';
  const scopedInstanceId = jobData.instanceId;
  const scopedProjects = jobData.projects;

  const instances = await db.azureDevOpsInstance.findMany();
  if (instances.length === 0) {
    console.log('No Azure DevOps instances configured — skipping sync');
    return [{ instance: 'none', skipped: true }];
  }

  const results: AzureDevOpsSyncJobResult[] = [];

  for (const instance of instances) {
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

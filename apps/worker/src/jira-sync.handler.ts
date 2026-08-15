import type { PrismaClient } from '@deckgauge/db';
import type { JiraPort, JiraConfig } from '@deckgauge/shared';
import type { ChClient } from './jira-dual-writer.js';
import { jiraSyncProcessor } from './jira-sync.processor.js';

export interface SyncJobData {
  trigger?: string;
  /** When set, only sync this specific instance. */
  instanceId?: string;
  /** When set, sync only these project keys instead of all keys on the instance. */
  projectKeys?: string[];
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
  ch?: ChClient,
): Promise<SyncJobResult[]> {
  const trigger = jobData.trigger || 'scheduled';
  const scopedInstanceId = jobData.instanceId;
  const scopedProjectKeys = jobData.projectKeys;

  const instances = await db.jiraInstance.findMany();
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

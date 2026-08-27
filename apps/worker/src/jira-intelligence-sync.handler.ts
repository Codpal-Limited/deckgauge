// EI-012 — Jira intelligence sync (additive dual-write).
import { PrismaClient } from '@deckgauge/db';
import type { JiraIntelligencePort } from '@deckgauge/shared';
import { resolveSyncJobScope } from './sync-job-scope.js';

export interface JiraIntelligenceJobData {
  trigger: 'manual' | 'scheduled' | 'startup';
  instanceId?: string;
  projectKeys?: string[];
  /**
   * The organization whose admin asked for this sync — REQUIRED for a `manual` job.
   *
   * `POST /intelligence/sync` reaches this handler, and its `ADMIN` policy is not
   * instance-only (`policy.ts` tests `ctx.isAdmin`, which the auth plugin sets for
   * `membership.role === 'ADMIN'`), so before 2026-08-27 an ORGANIZATION admin of one
   * tenant spent every other tenant's Atlassian tokens through it. Built by
   * `manualSyncJobPayload` in @deckgauge/shared.
   */
  organizationId?: string;
}

export type JiraIntelligenceFactory = (cfg: {
  atlassianUrl: string;
  email: string;
  apiToken: string;
}) => JiraIntelligencePort;

export interface ChClient {
  insertRows(table: string, rows: ReadonlyArray<Record<string, unknown>>): Promise<void>;
}

/**
 * Builds a ClickHouse client bound to one organization. See
 * jira-dual-writer.ts for why handlers take the factory rather than a client:
 * the instances this handler loops over can belong to different tenants, and
 * `organization_id` is a sort-key column ClickHouse cannot correct afterwards.
 */
export type ChClientFactory = (organizationId: string) => ChClient;

export interface JiraIntelligenceResult {
  instancesProcessed: number;
  issuesWritten: number;
  transitionsWritten: number;
  worklogsWritten: number;
  errors: Array<{ instanceId: string; message: string }>;
}

// Which projects to intelligence-sync for an instance when the job doesn't name
// them explicitly. Boards pick projects per-board (jira_project_syncs), so a
// shared connection's instance.projectKeys may be empty — mirror the basic
// sync handler and drive off the per-board picks, falling back to
// instance.projectKeys only when no project-sync rows exist (fresh bootstrap).
async function resolveInstanceProjectKeys(
  db: PrismaClient,
  instance: { id: string; projectKeys: string[] },
): Promise<string[]> {
  const syncs: Array<{ jiraProjectKey: string }> = await db.jiraProjectSync.findMany({
    where: { jiraInstanceId: instance.id },
    select: { jiraProjectKey: true },
  });
  if (syncs.length > 0) {
    return [...new Set(syncs.map((s) => s.jiraProjectKey))];
  }
  return instance.projectKeys;
}

export async function handleJiraIntelligenceSync(
  job: JiraIntelligenceJobData,
  db: PrismaClient,
  factory: JiraIntelligenceFactory,
  chClientFor: ChClientFactory,
  opts: { syncWorklogs?: boolean } = {},
): Promise<JiraIntelligenceResult> {
  const result: JiraIntelligenceResult = {
    instancesProcessed: 0,
    issuesWritten: 0,
    transitionsWritten: 0,
    worklogsWritten: 0,
    errors: [],
  };
  // The tenant boundary. Fail-closed: a manual job naming no scope is refused rather
  // than loading every organization's Jira credentials. See sync-trigger-tenancy.test.ts.
  const scope = resolveSyncJobScope(job);
  if (!scope.allowed) {
    console.error(`[Jira intel] ${scope.reason}`);
    result.errors.push({ instanceId: 'none', message: scope.reason });
    return result;
  }

  const where: Record<string, unknown> = {};
  if (job.instanceId) where.id = job.instanceId;
  if (scope.organizationId) where.organizationId = scope.organizationId;
  const instances = await db.jiraInstance.findMany({ where });

  for (const instance of instances) {
    result.instancesProcessed++;
    try {
      // Bind ClickHouse to the organization that owns THIS connection — inside
      // the loop, so a second instance on another tenant gets its own client.
      const ch = chClientFor(instance.organizationId);

      const adapter = factory({
        atlassianUrl: instance.atlassianUrl,
        email: instance.email,
        apiToken: instance.apiToken,
      });
      const keys = job.projectKeys ?? (await resolveInstanceProjectKeys(db, instance));
      if (keys.length === 0) continue;
      // Stream page-by-page: insert each page into ClickHouse as it arrives so
      // peak memory stays bounded to one page. Buffering the full result set
      // OOM-killed the worker (384M cap) on real-sized projects and tripped
      // BullMQ's stall detection. Mirrors the ADO streaming sync.
      await adapter.fetchIssuesWithChangelog({
        projectKeys: keys,
        onBatch: async ({ issues, transitions }) => {
          if (issues.length > 0) {
            await ch.insertRows('jira_issues', issues as unknown as Array<Record<string, unknown>>);
            result.issuesWritten += issues.length;
          }
          if (transitions.length > 0) {
            await ch.insertRows('jira_transitions', transitions as unknown as Array<Record<string, unknown>>);
            result.transitionsWritten += transitions.length;
          }
          if (opts.syncWorklogs) {
            for (const issue of issues) {
              const wl = await adapter.fetchWorklogs(issue.key, issue.project_key);
              if (wl.length > 0) {
                await ch.insertRows('jira_worklogs', wl as unknown as Array<Record<string, unknown>>);
                result.worklogsWritten += wl.length;
              }
            }
          }
        },
      });
      // Symmetric with github/ado/gitlab intelligence handlers: stamp the
      // per-project lastSyncedAt so BoardSyncService.getBoardSyncStatus has
      // a deterministic "last successful sync" signal to surface in the UI.
      await db.jiraProjectSync.updateMany({
        where: { jiraInstanceId: instance.id, jiraProjectKey: { in: keys } },
        data: { lastSyncedAt: new Date() },
      });
    } catch (err) {
      result.errors.push({ instanceId: instance.id, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}

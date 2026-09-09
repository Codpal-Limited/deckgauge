import { PrismaClient } from '@deckgauge/db';
import { AzureDevOpsPort, AzureDevOpsWorkItem, buildAdoTransitions } from '@deckgauge/shared';
import type { AdoWorkItemRevision } from '@deckgauge/shared';
import {
  AzureDevOpsPromoteService,
  type PromoteAdoWorkItem,
} from './azure-devops-promote.service.js';
import {
  type ChClient,
  mapAdoToClickHouseRows,
  writeAdoBasicToClickHouse,
} from './ado-dual-writer.js';
import { fetchAdoPriorStates, type ChQueryClient } from './ado-transition-priors.js';

/**
 * Convert an adapter-shaped `AzureDevOpsWorkItem` into the leaner shape the
 * promote service expects. The adapter output has no `adoProject` (it's only
 * available from the calling scope) so we inject it here.
 */
/**
 * ADO serves the scheduling due date as an ISO string in the untyped `fields`
 * bag (mapWorkItem keeps every non-`System.` field). Guard the parse: an absent
 * or malformed value must become null, not an Invalid Date that Prisma rejects.
 */
function adoDueDate(fields: Record<string, unknown> | undefined): Date | null {
  const raw = fields?.['Microsoft.VSTS.Scheduling.DueDate'];
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toPromoteAdoWorkItem(
  wi: AzureDevOpsWorkItem,
  adoProject: string,
): PromoteAdoWorkItem {
  return {
    adoId: wi.adoId,
    adoProject,
    type: wi.type,
    title: wi.title,
    state: wi.state,
    description: wi.description ?? null,
    assignedTo: wi.assignedTo ?? null,
    areaPath: wi.areaPath ?? null,
    iterationPath: wi.iterationPath ?? null,
    adoParentId: wi.adoParentId ?? null,
    dueDate: adoDueDate(wi.fields as Record<string, unknown> | undefined),
  };
}

interface ProcessorInput {
  adapter: AzureDevOpsPort;
  projects: string[];
  trigger: string;
  db: PrismaClient;
  /**
   * Optional ClickHouse client, ALREADY BOUND to the organization that owns the
   * ADO instance being synced — azure-devops-sync.handler calls `chClientFor`
   * inside its per-instance loop and hands the result down, so the processor
   * stays tenant-agnostic and cannot pick the wrong organization.
   *
   * When provided, the processor dual-writes the full unfiltered set of fetched
   * work items into the `ado_work_items` CH table BEFORE the Postgres upserts.
   *
   * Thin coverage: the basic AzureDevOpsPort adapter only surfaces work item
   * metadata — no transitions, no PRs. PR data is written by
   * ado-intelligence-sync.handler against the same ReplacingMergeTree table
   * family (`ado_pull_requests`). Transitions are dual-written via a Reporting
   * Work Item Revisions sweep (best-effort). Omitted in tests that don't care
   * about CH coverage so the call site stays backward-compatible.
   *
   * When the client also implements `queryRows`, the revisions sweep runs
   * INCREMENTALLY from a per-project watermark (see the sweep below). Without
   * it the sweep falls back to a full history read, which is correct but is
   * what exhausted the Azure DevOps throughput budget.
   */
  ch?: ChClient & Partial<ChQueryClient>;
  /**
   * Optional orgUrl / instanceId — required when `ch` is provided so the CH
   * row's primary key (`org_url`, `project`, `ado_id`) matches what
   * backfill-to-clickhouse.ts and the intelligence handler use. The handler
   * forwards these from AzureDevOpsInstance. When `ch` is absent these are
   * ignored.
   */
  orgUrl?: string;
  instanceId?: string;
  /**
   * The organization that owns the ADO instance being synced. **Required** — note
   * the contrast with `orgUrl`/`instanceId` above, which are optional because
   * they only shape the ClickHouse row key.
   *
   * This one is stamped onto the `SyncRun` this processor writes, and is the only
   * way that row can be attributed: `SyncRun`'s four `*SyncId` columns are dead
   * (nothing has ever written one) and it had no tenant column at all until
   * 2026-08-26, so an unattributed run is served to every tenant by
   * `GET /azure-devops/sync/status`. ADO's `errorMessage` carries the team
   * project name, which makes it the most revealing of the three sources.
   *
   * `azure-devops-sync.handler.ts` already loops per instance and passes
   * `instance.organizationId` from the same object it takes `instance.orgUrl` from.
   */
  organizationId: string;
}

interface ProcessorOutput {
  status: string;
  trigger: string;
  workItemCount: number;
  finishedAt: Date | null;
  errorMessage: string | null;
}

export async function azureDevOpsSyncProcessor(input: ProcessorInput): Promise<ProcessorOutput> {
  const { adapter, projects, trigger, db, ch, orgUrl, instanceId, organizationId } = input;

  const syncRun = await db.syncRun.create({
    data: {
      organizationId,
      status: 'PENDING',
      trigger: normalizeTrigger(trigger),
      startedAt: new Date(),
      source: 'azure-devops',
    },
  });

  try {
    let totalWorkItems = 0;
    let created = 0;
    let updated = 0;
    let markedRemoved = 0;
    const promoteService = new AzureDevOpsPromoteService(db);

    for (const project of projects) {
      console.log(`[Azure DevOps Processor] Processing project: ${project}`);

      // P9.2: per-board filters live on BoardAdoSource. Scope by project AND
      // instance — the same adoProject name can exist on multiple instances.
      const boardSources = await db.boardAdoSource.findMany({
        where: {
          azureDevOpsProjectSync: {
            adoProject: project,
            azureDevOpsInstanceId: instanceId ?? '',
          },
        },
        include: { azureDevOpsProjectSync: true },
      });

      // Pre-compute WIQL ID sets per board source (ID sets are cheap even for
      // large projects). Boards without a WIQL filter contribute nothing — the
      // promote service treats them as "no WIQL narrowing". Type narrowing
      // (allowedWorkItemTypes) is applied in the promote service, so pass `[]`.
      const wiqlIdsByBoardSource: Record<string, Set<number>> = {};
      for (const boardSource of boardSources) {
        // `=== false`, not `!flag`: absent means ON — see the matching guard
        // in azure-devops-promote.service.ts for the full rationale.
        if (boardSource.syncWorkItemsToBoard === false) continue;
        const wiqlFilter = boardSource.wiqlFilter as string | null | undefined;
        if (wiqlFilter && wiqlFilter.trim().length > 0) {
          console.log(
            `[Azure DevOps Processor] Querying WIQL IDs for project=${project} boardSource=${boardSource.id}`,
          );
          wiqlIdsByBoardSource[boardSource.id] = await adapter.queryMatchingIds(
            project,
            [],
            wiqlFilter,
          );
        }
      }

      console.log(
        `[Azure DevOps Processor] Streaming work items for project=${project} (unfiltered, instance=${instanceId ?? ''})`,
      );

      // Stream the project's work items in batches. Each batch is dual-written
      // to ClickHouse (the unfiltered set Engineering Intelligence needs — see
      // planning/STORAGE-SPLIT.md) and handed to the promote service, so even a
      // 20k+ project is never held in memory all at once. The basic
      // AzureDevOpsPort carries no PRs/transitions — ado-intelligence-sync
      // covers PRs against the same ReplacingMergeTree table family.
      let projectCount = 0;
      const promoteBatches = async function* (): AsyncGenerator<PromoteAdoWorkItem[]> {
        for await (const batch of adapter.streamWorkItems(project)) {
          if (ch && batch.length > 0) {
            const rows = mapAdoToClickHouseRows({
              workItems: batch,
              orgUrl: orgUrl ?? '',
              project,
              instanceId: instanceId ?? '',
            });
            await writeAdoBasicToClickHouse(ch, { workItems: rows });
          }
          projectCount += batch.length;
          totalWorkItems += batch.length;
          yield batch.map((wi) => toPromoteAdoWorkItem(wi, project));
        }
      };

      const result = await promoteService.promoteProjectStream({
        adoProject: project,
        instanceId: instanceId ?? '',
        batches: promoteBatches(),
        wiqlIdsByBoardSource,
      });
      created += result.created;
      updated += result.updated;
      markedRemoved += result.markedRemoved;

      console.log(
        `[Azure DevOps Processor] Fetched ${projectCount} work items for ${project} (unfiltered)`,
      );

      // Reconstruct status transitions for the timesheet. The basic work-item
      // sweep above carries only current state; the Reporting Work Item
      // Revisions endpoint gives full state history. Best-effort: a failure
      // here must not fail the work-item sync (transitions retry next run;
      // ReplacingMergeTree dedups re-swept rows by id).
      //
      // INCREMENTAL. This sweep used to run with no `startDateTime`, re-reading
      // every project's complete revision history on every scheduled run —
      // ~256k revisions per cycle across one large org, every 15 minutes,
      // which is what got the account's requests throttled by Azure DevOps. It
      // now resumes from a per-project watermark, seeding the builder with the
      // state each item was already in so a change at the window boundary keeps
      // its true from_state and dwell time (see fetchAdoPriorStates).
      if (ch) {
        try {
          const sync = instanceId
            ? await db.azureDevOpsProjectSync.findUnique({
                where: {
                  azureDevOpsInstanceId_adoProject: {
                    azureDevOpsInstanceId: instanceId,
                    adoProject: project,
                  },
                },
                select: { id: true, lastRevisionSyncAt: true },
              })
            : null;

          // Incremental needs a watermark, the ability to read back prior states,
          // AND a tenant to scope that read to; without any of them, fall back to a
          // correct full sweep.
          //
          // `organizationId` is part of the gate, not an assumption. This read's
          // result is WRITTEN BACK as `from_state` and dwell time, so an unscoped
          // one persists another tenant's value under this tenant's key. A
          // tenant-less client therefore must not go incremental — and refusing
          // HERE is better than letting `orgPredicate` throw into the sweep's
          // best-effort catch, because that path silently writes no transitions at
          // all and never advances the watermark. Falling back to the full sweep
          // costs Azure DevOps requests and is correct.
          const canReadPriors =
            typeof ch.queryRows === 'function' && typeof ch.organizationId === 'string';
          const since = canReadPriors ? (sync?.lastRevisionSyncAt ?? undefined) : undefined;

          // Stamp from BEFORE the fetch so revisions written mid-sweep are
          // picked up next run rather than skipped.
          const revisionStart = new Date();

          const revisions: AdoWorkItemRevision[] = [];
          for await (const batch of adapter.streamWorkItemRevisions(project, since)) {
            revisions.push(...batch);
          }

          const priorStates = since
            ? await fetchAdoPriorStates(
                ch as ChQueryClient,
                project,
                Array.from(new Set(revisions.map((r) => r.workItemId))),
              )
            : undefined;

          const transitions = buildAdoTransitions(revisions, priorStates);
          if (transitions.length > 0) {
            await writeAdoBasicToClickHouse(ch, { workItems: [], transitions });
          }

          // Only advance the watermark once the rows are safely written, so a
          // mid-sweep failure re-reads the same window instead of losing it.
          if (sync && canReadPriors) {
            await db.azureDevOpsProjectSync.update({
              where: { id: sync.id },
              data: { lastRevisionSyncAt: revisionStart },
            });
          }

          console.log(
            `[Azure DevOps Processor] Wrote ${transitions.length} transitions for ${project} ` +
              `(${since ? `incremental since ${since.toISOString()}` : 'full sweep'}, ` +
              `${revisions.length} revisions read)`,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(
            `[Azure DevOps Processor] Transitions sweep failed for ${project}: ${message}`,
          );
        }
      }
    }

    console.log(
      `[Azure DevOps Processor] Promote: ${created} created, ${updated} updated, ${markedRemoved} marked removed`,
    );

    const updatedRun = await db.syncRun.update({
      where: { id: syncRun.id },
      data: {
        status: 'COMPLETED',
        finishedAt: new Date(),
        workItemCount: totalWorkItems,
      },
    });

    return {
      status: updatedRun.status,
      trigger: updatedRun.trigger,
      workItemCount: updatedRun.workItemCount,
      finishedAt: updatedRun.finishedAt,
      errorMessage: updatedRun.errorMessage,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const updated = await db.syncRun.update({
      where: { id: syncRun.id },
      data: {
        status: 'FAILED',
        finishedAt: new Date(),
        errorMessage,
      },
    });

    return {
      status: updated.status,
      trigger: updated.trigger,
      workItemCount: updated.workItemCount,
      finishedAt: updated.finishedAt,
      errorMessage: updated.errorMessage,
    };
  }
}

function normalizeTrigger(trigger: string): 'STARTUP' | 'MANUAL' | 'SCHEDULED' {
  const normalized = trigger.toUpperCase();
  if (normalized === 'STARTUP') return 'STARTUP';
  if (normalized === 'MANUAL') return 'MANUAL';
  if (normalized === 'SCHEDULED') return 'SCHEDULED';
  throw new Error(`Unknown trigger: ${trigger}`);
}

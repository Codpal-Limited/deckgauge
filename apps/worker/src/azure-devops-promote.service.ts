import { PrismaClient } from '@deckgauge/db';
import { LEGACY_STATUS_LABELS, shouldSync, STATUS_COLORS } from '@deckgauge/shared';
import { ensureDefaultGroup } from './sync-default-group.js';
import { createSyncAutomationRunner, type SyncAutomationRunner } from './sync-automations.js';

export interface AdoPromoteResult {
  created: number;
  updated: number;
  markedRemoved: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Map board status label back to legacy ProjectStatus enum for the required `status` column. */
const LABEL_TO_ENUM: Record<string, string> = {
  'not started': 'NOT_STARTED',
  'in progress': 'IN_PROGRESS',
  'at risk': 'AT_RISK',
  blocked: 'BLOCKED',
  done: 'DONE',
};

interface CachedBoardStatus {
  id: string;
  label: string;
  color: string;
}

/** Existing-project row snapshotted per board before promotion. */
interface ExistingProjectRow {
  id: string;
  adoWorkItemId: number | null;
  status: string;
  statusId: string | null;
  adoSyncedFields: unknown;
  overriddenFields: string[];
}

/** The BoardAdoSource fields the promote state machine reads. */
interface BoardSourceConfig {
  id: string;
  boardId: string;
  targetGroupId: string | null;
  statusMapping: unknown;
  fieldMappings: unknown;
  defaultSyncedFields: unknown;
  allowedWorkItemTypes: unknown;
  areaPaths: unknown;
  syncWorkItemsToBoard: boolean;
}

/**
 * Mutable per-(board source) promotion state. Snapshotted once, then carried
 * across streamed work-item batches so a large project can be promoted
 * incrementally without buffering every item. mark-removed runs once at
 * finalize, after every batch has contributed to `seenAdoIds`.
 */
interface BoardPromoteState {
  boardSource: BoardSourceConfig;
  adoProject: string;
  statusMapping: Record<string, string>;
  fieldMappings: Record<string, string>;
  defaultSyncedFields: string[];
  allowedWorkItemTypes: string[];
  areaPaths: string[];
  statusCache: Map<string, CachedBoardStatus>;
  projectByAdoId: Map<number | null, ExistingProjectRow>;
  groupId: string | null;
  excludedAdoIds: Set<string>;
  seenAdoIds: number[];
  created: number;
  updated: number;
  markedRemoved: number;
  /** Caches this board's automation rules for the whole run. See sync-automations.ts. */
  automations: SyncAutomationRunner;
}

/**
 * Minimal ADO work-item shape the promote service needs. Sourced from the
 * AzureDevOpsPort adapter's fetchWorkItems output — fed in-memory by the
 * processor. Previously read from Postgres `azure_devops_work_items`, dropped
 * in 20260603120000_drop_legacy_phase3_tables.
 */
export interface PromoteAdoWorkItem {
  adoId: number;
  adoProject: string;
  type: string;
  title: string;
  state: string;
  description?: string | null;
  assignedTo?: string | null;
  areaPath?: string | null;
  iterationPath?: string | null;
  adoParentId?: number | null;
  dueDate?: Date | null;
}

export interface AdoPromotePayload {
  /** Unfiltered work items, keyed by adoProject. */
  workItemsByProject: Record<string, PromoteAdoWorkItem[]>;

  /**
   * Optional. ID sets keyed by board source ID. When present for a board
   * source, the promote service intersects the filtered work-item list
   * with the IDs in the set. Boards without a WIQL filter are omitted
   * from this map.
   */
  wiqlIdsByBoardSource?: Record<string, Set<number>>;
}

/** What confines a buffered promote run. Required, because the tenant boundary rides on it. */
export interface AdoPromoteOptions {
  /**
   * The Azure DevOps connection this run fetched from — the same confinement
   * `promoteProjectStream` already takes, and for the same reason: `adoProject`
   * is a name unique inside one ADO organization, not across tenants.
   */
  instanceId: string;
}

export class AzureDevOpsPromoteService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Buffered promotion: every project's work items are supplied up front in
   * `payload`. Iterates this connection's project syncs (1 per (instance,
   * adoProject)); each fans out to N board sources. Shares the per-board state
   * machine with promoteProjectStream so behaviour is identical whether items
   * arrive all at once or batch-by-batch.
   *
   * **No production caller today** — `azure-devops-sync.processor.ts` uses
   * `promoteProjectStream`. That is why the unconfined read this replaces was
   * latent rather than live, and why it is fixed rather than deleted: "no caller"
   * is a property of the call graph, not of the method, and the next caller would
   * have inherited the bug.
   */
  async promoteAll(
    payload: AdoPromotePayload = { workItemsByProject: {} },
    options: AdoPromoteOptions,
  ): Promise<AdoPromoteResult> {
    // The same predicate `promoteProjectStream` has carried all along, minus its
    // `adoProject` half (this method promotes every project in the payload).
    // Without it, `ps.adoProject` — a name unique within one ADO organization,
    // not across tenants — decided which board a work item landed on
    // (TENANCY-PROGRAMME §5a).
    const projectSyncs = await this.prisma.azureDevOpsProjectSync.findMany({
      where: { azureDevOpsInstanceId: options.instanceId },
      include: { boardSources: true },
    });

    let created = 0;
    let updated = 0;
    let markedRemoved = 0;

    for (const ps of projectSyncs) {
      const items: PromoteAdoWorkItem[] = payload.workItemsByProject[ps.adoProject] ?? [];
      for (const boardSource of ps.boardSources) {
        // Skipped BEFORE initBoardState, deliberately: "off" must mean
        // DETACHED, not EMPTIED. A source that promotes nothing must not
        // finalize either, or it would mark every existing card removed.
        //
        // `=== false`, not `!flag`: the column is NOT NULL with @default(true),
        // so production can never see `undefined` here — only a query that
        // failed to select it could. Absent means ON ("empty means all, never
        // none"), so the worst case of a missing value is a board that keeps
        // syncing when it shouldn't, not every board going dark at once.
        if (boardSource.syncWorkItemsToBoard === false) continue;
        const state = await this.initBoardState(boardSource, ps.adoProject);
        await this.processBatchForBoard(
          state,
          items,
          payload.wiqlIdsByBoardSource?.[boardSource.id],
        );
        await this.finalizeBoard(state);
        created += state.created;
        updated += state.updated;
        markedRemoved += state.markedRemoved;
      }
    }

    return { created, updated, markedRemoved };
  }

  /**
   * Streaming promotion used by the worker for large projects: promote work
   * items batch-by-batch so a 20k+ project is never buffered in full. Board
   * sources are scoped to a single (adoProject, instance); every batch is
   * applied to each board source, and mark-removed runs once after the stream
   * drains (it needs the complete seen-id set).
   */
  async promoteProjectStream(opts: {
    adoProject: string;
    instanceId: string;
    batches: AsyncIterable<PromoteAdoWorkItem[]>;
    wiqlIdsByBoardSource?: Record<string, Set<number>>;
  }): Promise<AdoPromoteResult> {
    const projectSyncs = await this.prisma.azureDevOpsProjectSync.findMany({
      where: { adoProject: opts.adoProject, azureDevOpsInstanceId: opts.instanceId },
      include: { boardSources: true },
    });

    const states: BoardPromoteState[] = [];
    for (const ps of projectSyncs) {
      for (const boardSource of ps.boardSources) {
        // Skipped BEFORE initBoardState, deliberately: "off" must mean
        // DETACHED, not EMPTIED. A source that promotes nothing must not
        // finalize either, or it would mark every existing card removed.
        //
        // `=== false`, not `!flag`: the column is NOT NULL with @default(true),
        // so production can never see `undefined` here — only a query that
        // failed to select it could. Absent means ON ("empty means all, never
        // none"), so the worst case of a missing value is a board that keeps
        // syncing when it shouldn't, not every board going dark at once.
        if (boardSource.syncWorkItemsToBoard === false) continue;
        states.push(await this.initBoardState(boardSource, opts.adoProject));
      }
    }

    for await (const batch of opts.batches) {
      for (const state of states) {
        await this.processBatchForBoard(
          state,
          batch,
          opts.wiqlIdsByBoardSource?.[state.boardSource.id],
        );
      }
    }

    let created = 0;
    let updated = 0;
    let markedRemoved = 0;
    for (const state of states) {
      await this.finalizeBoard(state);
      created += state.created;
      updated += state.updated;
      markedRemoved += state.markedRemoved;
    }

    return { created, updated, markedRemoved };
  }

  /** Snapshot per-board config, status cache, and existing projects for incremental promotion. */
  private async initBoardState(
    boardSource: BoardSourceConfig,
    adoProject: string,
  ): Promise<BoardPromoteState> {
    // Batch-fetch existing ADO projects scoped to THIS board (multi-board fan-out:
    // the same adoWorkItemId can exist on multiple boards, so scope by boardId).
    const existingProjects = await this.prisma.project.findMany({
      where: { boardId: boardSource.boardId, adoProject },
      select: { id: true, adoWorkItemId: true, status: true, statusId: true, adoSyncedFields: true, overriddenFields: true },
    });
    const projectByAdoId = new Map<number | null, ExistingProjectRow>(
      existingProjects.map((p): [number | null, ExistingProjectRow] => [p.adoWorkItemId, p]),
    );

    const exclusions = await this.prisma.boardSyncExclusion.findMany({
      where: { boardId: boardSource.boardId, source: 'ADO' },
      select: { externalId: true },
    });

    return {
      boardSource,
      adoProject,
      statusMapping: (boardSource.statusMapping ?? {}) as Record<string, string>,
      fieldMappings: (boardSource.fieldMappings ?? {}) as Record<string, string>,
      defaultSyncedFields: (boardSource.defaultSyncedFields ?? [
        'name',
        'status',
        'owner',
      ]) as string[],
      allowedWorkItemTypes: (boardSource.allowedWorkItemTypes ?? []) as string[],
      areaPaths: (boardSource.areaPaths ?? []) as string[],
      statusCache: await this.loadStatusCache(boardSource.boardId),
      projectByAdoId,
      // Resolve group lazily — only create a default group on first new-project
      // creation, so syncs with no new items don't leave empty groups behind.
      groupId: boardSource.targetGroupId,
      excludedAdoIds: new Set(exclusions.map((e) => e.externalId)),
      seenAdoIds: [],
      created: 0,
      updated: 0,
      markedRemoved: 0,
      automations: createSyncAutomationRunner(this.prisma),
    };
  }

  /** Promote one batch of work items into one board source, mutating `state`. */
  private async processBatchForBoard(
    state: BoardPromoteState,
    items: PromoteAdoWorkItem[],
    wiqlIds?: Set<number>,
  ): Promise<void> {
    // Seen means "present in Azure DevOps", not "promoted to this board".
    // Recorded before every filter below, so `finalizeBoard` can tell a work
    // item that was DELETED in ADO from one that is simply outside this
    // board's scope — narrowing a filter must never remove a card that may
    // carry comments and local work.
    for (const item of items) state.seenAdoIds.push(item.adoId);

    let workItems = items;
    if (state.allowedWorkItemTypes.length > 0) {
      // An item ALREADY on this board stays in the batch whatever its type —
      // same carve-out as area paths below (spec §4.2, Ruling 13): scope
      // governs what is ADDED, not what keeps updating. Without this, an
      // out-of-type card stops receiving Azure DevOps updates but is never
      // marked removed either (finalizeBoard's seenAdoIds is unfiltered) — it
      // would sit on the board frozen, looking current, forever.
      workItems = workItems.filter(
        (wi) => state.projectByAdoId.has(wi.adoId) || state.allowedWorkItemTypes.includes(wi.type),
      );
    }
    if (wiqlIds !== undefined) {
      // Same carve-out as above: a card already on the board keeps receiving
      // updates even if it falls outside the WIQL filter.
      workItems = workItems.filter((wi) => state.projectByAdoId.has(wi.adoId) || wiqlIds.has(wi.adoId));
    }
    if (state.excludedAdoIds.size > 0) {
      // Deliberately NO projectByAdoId carve-out here: an excluded item is one
      // the user explicitly deleted from the board, so it has no row and
      // `projectByAdoId.has` is always false for it — it must stay filtered.
      workItems = workItems.filter((wi) => !state.excludedAdoIds.has(String(wi.adoId)));
    }
    if (state.areaPaths.length > 0) {
      // Prefix match, value used verbatim: an area path is a tree and
      // selecting a parent in ADO always means its subtree. An item ALREADY on
      // this board stays in the batch whatever its area path — scope governs
      // what is added, and a card that may carry comments and local work keeps
      // receiving Azure DevOps updates (spec §4.2).
      workItems = workItems.filter(
        (wi) =>
          state.projectByAdoId.has(wi.adoId) ||
          state.areaPaths.some((p) => (wi.areaPath ?? '').startsWith(p)),
      );
    }

    const boardId = state.boardSource.boardId;

    for (const item of workItems) {
      const existing = state.projectByAdoId.get(item.adoId) ?? null;

      const statusId = await this.resolveStatusId(
        item.state,
        state.statusMapping,
        boardId,
        state.statusCache,
      );
      const legacyStatus = this.toLegacyEnum(statusId, state.statusCache);

      if (!existing) {
        if (state.groupId === null) {
          state.groupId = await ensureDefaultGroup(this.prisma, boardId, state.adoProject);
        }
        const newProject = await this.prisma.project.create({
          data: {
            name: item.title,
            description: item.description,
            status: legacyStatus as never,
            statusId,
            owner: item.assignedTo ?? '',
            assignee: item.assignedTo ?? '',
            boardId,
            groupId: state.groupId,
            adoWorkItemId: item.adoId,
            adoProject: state.adoProject,
            dueDate: item.dueDate ?? null,
            adoSyncedFields: state.defaultSyncedFields,
            adoRemovedFromSource: false,
          },
        });
        state.created++;

        await this.prisma.projectStatusChange.create({
          data: {
            projectId: newProject.id,
            fromStatus: null,
            toStatus: this.labelFromCache(statusId, state.statusCache) ?? legacyStatus,
            changedBy: 'sync:azure-devops',
          },
        });

        await this.applyFieldMappings(
          state.fieldMappings,
          item as unknown as Record<string, unknown>,
          newProject.id,
        );

        // A synced row is a new row on the board like any other.
        await state.automations.run({
          boardId,
          projectId: newProject.id,
          changes: { status: legacyStatus, statusId },
        });
      } else {
        const syncedFields = (existing.adoSyncedFields ?? state.defaultSyncedFields) as string[];
        const overriddenFields = (existing.overriddenFields ?? []) as string[];
        // One predicate for every field — see sync-field-registry.ts.
        const syncs = (key: string) => shouldSync({ key, overriddenFields, syncedFields });

        const updateData: Record<string, unknown> = {
          adoRemovedFromSource: false,
        };

        if (syncs('name')) {
          updateData.name = item.title;
        }
        if (syncs('status')) {
          updateData.statusId = statusId;
          updateData.status = legacyStatus;
        }
        // Assignee is the synced-truth column with no editable counterpart, so
        // it refreshes even when Owner is overridden.
        if (syncedFields.includes('owner')) {
          updateData.assignee = item.assignedTo ?? '';
        }
        if (syncs('owner')) {
          updateData.owner = item.assignedTo ?? '';
        }
        if (syncs('description')) {
          updateData.description = item.description;
        }
        if (syncs('dueDate')) {
          updateData.dueDate = item.dueDate ?? null;
        }

        await this.prisma.project.update({
          where: { id: existing.id },
          data: updateData,
        });
        state.updated++;

        if (updateData.status && updateData.status !== existing.status) {
          await this.prisma.projectStatusChange.create({
            data: {
              projectId: existing.id,
              fromStatus:
                this.labelFromCache(existing.statusId as string, state.statusCache) ??
                (existing.status as string),
              toStatus: this.labelFromCache(statusId, state.statusCache) ?? legacyStatus,
              changedBy: 'sync:azure-devops',
            },
          });
        }

        await this.applyFieldMappings(
          state.fieldMappings,
          item as unknown as Record<string, unknown>,
          existing.id,
        );

        // Full before/after pair — the rule engine decides whether anything
        // actually changed, the same decision the hand-edit path makes.
        await state.automations.run({
          boardId,
          projectId: existing.id,
          changes: {
            status: updateData.status as string | undefined,
            previousStatus: existing.status as string,
            statusId: updateData.statusId as string | undefined,
            previousStatusId: existing.statusId as string | null,
          },
        });
      }
    }
  }

  /** Mark-removed for one board source after all its batches have been processed. */
  private async finalizeBoard(state: BoardPromoteState): Promise<void> {
    // Candidates are computed in memory from state already snapshotted, then
    // matched with `in`. The old `notIn: seenAdoIds` would now carry the
    // project's ENTIRE work-item id set — tens of thousands on a large
    // project — against Postgres's 65535 bind-parameter ceiling (see
    // sync-exclusion.ts). Candidates are normally a handful: the items
    // genuinely deleted in ADO.
    const seen = new Set(state.seenAdoIds);
    const candidates = [...state.projectByAdoId.keys()].filter(
      (id): id is number => id !== null && !seen.has(id),
    );
    if (candidates.length === 0) return;

    const markResult = await this.prisma.project.updateMany({
      where: {
        boardId: state.boardSource.boardId,
        adoProject: state.adoProject,
        adoWorkItemId: { in: candidates },
        adoRemovedFromSource: false,
      },
      data: { adoRemovedFromSource: true },
    });
    state.markedRemoved += markResult.count;
  }

  /**
   * Resolve an ADO work item state string to a board_status ID.
   *
   * Resolution order:
   * 1. Explicit mapping value (UUID → direct; legacy enum → label lookup; label string → cache)
   * 2. Case-insensitive label match on the board
   * 3. Upsert a new board status with the ADO state name
   */
  private async resolveStatusId(
    adoState: string,
    statusMap: Record<string, string>,
    boardId: string,
    cache: Map<string, CachedBoardStatus>,
  ): Promise<string> {
    const mapped = statusMap[adoState];
    if (mapped) {
      // Already a board status UUID — but only use it if it belongs to this board
      if (UUID_RE.test(mapped)) {
        for (const s of cache.values()) {
          if (s.id === mapped) return mapped;
        }
        // UUID not on this board — fall through to other resolution methods
      }

      // Legacy enum value (e.g. "NOT_STARTED") → resolve label
      const label = LEGACY_STATUS_LABELS[mapped];
      if (label) {
        const cached = cache.get(label.toLowerCase());
        if (cached) return cached.id;
      }

      // Mapped value might be a label itself
      const byLabel = cache.get(mapped.toLowerCase());
      if (byLabel) return byLabel.id;
    }

    // Fallback: case-insensitive match on ADO state name
    const byName = cache.get(adoState.toLowerCase());
    if (byName) return byName.id;

    // No match — upsert a new board status
    return this.upsertBoardStatus(adoState, boardId, cache);
  }

  /** Create a new board status for an unknown ADO state, handling race conditions. */
  private async upsertBoardStatus(
    label: string,
    boardId: string,
    cache: Map<string, CachedBoardStatus>,
  ): Promise<string> {
    try {
      const color = this.pickUnusedColor(cache);
      const maxOrder = await this.prisma.boardStatus.aggregate({
        where: { boardId },
        _max: { order: true },
      });

      const created = await this.prisma.boardStatus.create({
        data: {
          boardId,
          label,
          color,
          order: (maxOrder._max.order ?? -1) + 1,
        },
      });

      cache.set(label.toLowerCase(), { id: created.id, label: created.label, color });
      return created.id;
    } catch (err: unknown) {
      // Unique constraint violation (P2002) — concurrent sync created it first
      if (
        typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        (err as { code: string }).code === 'P2002'
      ) {
        const existing = await this.prisma.boardStatus.findFirst({
          where: { boardId, label: { equals: label, mode: 'insensitive' } },
        });
        if (existing) {
          cache.set(label.toLowerCase(), { id: existing.id, label: existing.label, color: '' });
          return existing.id;
        }
      }
      throw err;
    }
  }

  /**
   * Pick a color for a new board status. Prefers a color not yet used on this
   * board; once the palette is exhausted, reuses the least-used color so colors
   * stay balanced instead of colliding arbitrarily. Duplicate colors per board
   * are allowed — the UNIQUE(board_id, color) index was dropped in
   * 20260619000000_drop_board_status_color_unique, so a board can hold more
   * statuses than there are palette colors without the insert failing.
   */
  private pickUnusedColor(cache: Map<string, CachedBoardStatus>): string {
    const counts = new Map<string, number>();
    for (const color of STATUS_COLORS) counts.set(color, 0);
    for (const s of cache.values()) {
      if (counts.has(s.color)) counts.set(s.color, (counts.get(s.color) ?? 0) + 1);
    }

    let best: string = STATUS_COLORS[0]!;
    let bestCount = Infinity;
    for (const color of STATUS_COLORS) {
      const count = counts.get(color) ?? 0;
      if (count < bestCount) {
        bestCount = count;
        best = color;
      }
    }
    return best;
  }

  /** Load all board statuses into a lowercase-label-keyed cache (includes color for pickUnusedColor). */
  private async loadStatusCache(boardId: string): Promise<Map<string, CachedBoardStatus>> {
    const statuses = await this.prisma.boardStatus.findMany({
      where: { boardId },
      select: { id: true, label: true, color: true },
    });
    const cache = new Map<string, CachedBoardStatus>();
    for (const s of statuses) {
      cache.set(s.label.toLowerCase(), { id: s.id, label: s.label, color: s.color });
    }
    return cache;
  }

  /** Map a board status ID back to the legacy ProjectStatus enum value. */
  private toLegacyEnum(statusId: string, cache: Map<string, CachedBoardStatus>): string {
    for (const s of cache.values()) {
      if (s.id === statusId) {
        return LABEL_TO_ENUM[s.label.toLowerCase()] ?? 'NOT_STARTED';
      }
    }
    return 'NOT_STARTED';
  }

  /** Find the human-readable label for a board status ID by scanning the cache. */
  private labelFromCache(statusId: string, cache: Map<string, CachedBoardStatus>): string | null {
    for (const s of cache.values()) {
      if (s.id === statusId) return s.label;
    }
    return null;
  }

  private async applyFieldMappings(
    fieldMappings: Record<string, string>,
    item: Record<string, unknown>,
    projectId: string,
  ): Promise<void> {
    for (const [adoField, columnId] of Object.entries(fieldMappings)) {
      const value = item[adoField];
      if (value === undefined || value === null) continue;

      const stringValue = String(value);
      await this.prisma.projectFieldValue.upsert({
        where: { projectId_columnId: { projectId, columnId } },
        update: { value: stringValue },
        create: { projectId, columnId, value: stringValue },
      });
    }
  }
}

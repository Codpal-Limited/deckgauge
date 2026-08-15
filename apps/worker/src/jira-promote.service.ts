import { PrismaClient } from '@deckgauge/db';
import { LEGACY_STATUS_LABELS, STATUS_COLORS } from '@deckgauge/shared';
import { ensureDefaultGroup } from './sync-default-group.js';

export interface PromoteResult {
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
  'blocked': 'BLOCKED',
  'done': 'DONE',
};

interface CachedBoardStatus {
  id: string;
  label: string;
  color: string;
}

/**
 * Minimal Jira item shape the promote service needs. Sourced from the JiraPort
 * adapter's fetchEpics/fetchIssues output — fed in-memory by the processor.
 * Previously this data was mirrored in Postgres `jira_epics` / `jira_issues`,
 * but those tables were dropped by 20260603120000_drop_legacy_phase3_tables.
 */
export interface PromoteJiraItem {
  key: string;
  projectKey: string;
  summary: string;
  description?: string | null;
  status: string;
  assignee?: string | null;
  type: string;
}

export interface PromotePayload {
  epics: PromoteJiraItem[];
  issues: PromoteJiraItem[];
}

/**
 * Per-board-source JQL filtering, resolved by `resolveJqlAllowLists` before the
 * promote runs. Sources absent from both collections are promoted unfiltered.
 */
export interface PromoteOptions {
  /** boardJiraSource.id → the only issue keys that source may promote. */
  allowedKeysBySourceId?: Map<string, ReadonlySet<string>>;
  /** Sources whose filter could not be resolved — skipped entirely, so a broken filter never widens the board. */
  skipSourceIds?: ReadonlySet<string>;
}

export class JiraPromoteService {
  constructor(private readonly prisma: PrismaClient) {}

  async promoteAll(
    payload: PromotePayload = { epics: [], issues: [] },
    options: PromoteOptions = {},
  ): Promise<PromoteResult> {
    let created = 0;
    let updated = 0;
    let markedRemoved = 0;

    // New model: 1 JiraProjectSync per (instance, project key); per-board filters
    // live on BoardJiraSource. One project sync fans out into N board sources.
    const projectSyncs = await this.prisma.jiraProjectSync.findMany({
      include: { boardSources: true },
    });

    for (const ps of projectSyncs) {
      const jiraProjectKey = ps.jiraProjectKey;

      for (const boardSource of ps.boardSources) {
        // Its JQL filter could not be resolved this run (Jira rejected it, or was
        // unreachable). Promoting unfiltered would flood the board with the whole
        // project; marking removed would flag every row it already has. Leave it be.
        if (options.skipSourceIds?.has(boardSource.id)) {
          console.warn(
            `[JiraPromote] Skipping board source ${boardSource.id} (${jiraProjectKey}) — its JQL filter could not be resolved`,
          );
          continue;
        }

        const allowedKeys = options.allowedKeysBySourceId?.get(boardSource.id) ?? null;
        const allowedTypes = boardSource.allowedIssueTypes as string[];
        const statusMapping = (boardSource.statusMapping ?? {}) as Record<string, string>;
        const fieldMappings = (boardSource.fieldMappings ?? {}) as Record<string, string>;
        const defaultSyncedFields = (boardSource.defaultSyncedFields ?? [
          'name',
          'status',
          'owner',
          'description',
        ]) as string[];

        // Pre-load board statuses for this board (cache to avoid N+1)
        const statusCache = await this.loadStatusCache(boardSource.boardId);

        // Resolve group lazily — only create a default group on first new-project
        // creation, so syncs with no new items don't leave empty groups behind.
        let groupId: string | null = boardSource.targetGroupId;

        // Batch-fetch existing projects scoped to this board (multi-board fan-out:
        // the same jiraKey can exist on multiple boards, so we must NOT key purely
        // by jiraProjectKey).
        const existingProjects = await this.prisma.project.findMany({
          where: { jiraProjectKey, boardId: boardSource.boardId },
          select: { id: true, jiraKey: true, jiraProjectKey: true, status: true, statusId: true, jiraSyncedFields: true, ownerOverridden: true },
        });
        const projectByJiraKey = new Map(existingProjects.map((p) => [p.jiraKey, p]));

        const jiraExclusions = await this.prisma.boardSyncExclusion.findMany({
          where: { boardId: boardSource.boardId, source: 'JIRA' },
          select: { externalId: true },
        });
        const excludedJiraKeys = new Set(jiraExclusions.map((e) => e.externalId));

        // Filter in-memory payload (was previously a Postgres read against the
        // now-dropped jira_epics / jira_issues tables — those tables vanished in
        // 20260603120000_drop_legacy_phase3_tables).
        const epicRows = allowedTypes.includes('Epic')
          ? payload.epics.filter((e) => e.projectKey === jiraProjectKey)
          : [];

        const nonEpicTypes = allowedTypes.filter((t) => t !== 'Epic');
        const issueRows =
          nonEpicTypes.length > 0
            ? payload.issues.filter(
                (i) => i.projectKey === jiraProjectKey && nonEpicTypes.includes(i.type),
              )
            : [];

        // Merge into a single typed array
        type RawItem = {
          key: string;
          summary: string;
          description: string | null;
          status: string;
          assignee: string | null;
          type: string;
        };
        const allItems: RawItem[] = [
          ...epicRows.map((e) => ({
            key: e.key,
            summary: e.summary,
            description: e.description ?? null,
            status: e.status,
            assignee: e.assignee ?? null,
            type: 'Epic',
          })),
          ...issueRows.map((i) => ({
            key: i.key,
            summary: i.summary,
            description: i.description ?? null,
            status: i.status,
            assignee: i.assignee ?? null,
            type: i.type,
          })),
        ];

        const notExcluded =
          excludedJiraKeys.size > 0
            ? allItems.filter((r) => !excludedJiraKeys.has(r.key))
            : allItems;

        // The board source's JQL filter, applied as an intersection. Anything it
        // drops is left out of `seenKeys`, so a row that stopped matching gets
        // flagged `jiraRemovedFromSource` by the mark-removed pass below — the
        // same treatment as an issue deleted in Jira.
        const items =
          allowedKeys === null ? notExcluded : notExcluded.filter((r) => allowedKeys.has(r.key));

        const seenKeys: string[] = [];

        for (const row of items) {
          const jiraKey = row.key;
          seenKeys.push(jiraKey);

          const existing = projectByJiraKey.get(jiraKey) ?? null;

          const statusId = await this.resolveStatusId(
            row.status,
            statusMapping,
            boardSource.boardId,
            statusCache,
          );
          const legacyStatus = this.toLegacyEnum(statusId, statusCache);

          if (!existing) {
            if (groupId === null) {
              groupId = await ensureDefaultGroup(this.prisma, boardSource.boardId, jiraProjectKey);
            }
            const newProject = await this.prisma.project.create({
              data: {
                name: row.summary,
                description: row.description,
                status: legacyStatus as never,
                statusId,
                owner: row.assignee ?? '',
                assignee: row.assignee ?? '',
                boardId: boardSource.boardId,
                groupId,
                jiraKey,
                jiraProjectKey,
                jiraType: row.type,
                jiraSyncedFields: defaultSyncedFields,
                jiraRemovedFromSource: false,
              },
            });
            created++;

            await this.prisma.projectStatusChange.create({
              data: {
                projectId: newProject.id,
                fromStatus: null,
                toStatus: this.labelFromCache(statusId, statusCache) ?? legacyStatus,
                changedBy: 'sync:jira',
              },
            });

            await this.applyFieldMappings(fieldMappings, row as Record<string, unknown>, newProject.id);
          } else {
            const syncedFields = (existing.jiraSyncedFields ?? defaultSyncedFields) as string[];
            const updateData: Record<string, unknown> = {
              jiraRemovedFromSource: false,
            };

            if (syncedFields.includes('name')) {
              updateData.name = row.summary;
            }
            if (syncedFields.includes('status')) {
              updateData.statusId = statusId;
              updateData.status = legacyStatus;
            }
            if (syncedFields.includes('owner')) {
              // Always refresh the synced Assignee; only overwrite the editable
              // Owner while it still follows the assignee (not manually set).
              updateData.assignee = row.assignee ?? '';
              if (!existing.ownerOverridden) {
                updateData.owner = row.assignee ?? '';
              }
            }
            if (syncedFields.includes('description')) {
              updateData.description = row.description;
            }

            await this.prisma.project.update({
              where: { id: existing.id },
              data: updateData,
            });
            updated++;

            if (updateData.status && updateData.status !== existing.status) {
              await this.prisma.projectStatusChange.create({
                data: {
                  projectId: existing.id,
                  fromStatus: this.labelFromCache(existing.statusId as string, statusCache) ?? (existing.status as string),
                  toStatus: this.labelFromCache(statusId, statusCache) ?? legacyStatus,
                  changedBy: 'sync:jira',
                },
              });
            }

            await this.applyFieldMappings(fieldMappings, row as Record<string, unknown>, existing.id);
          }
        }

        // Mark removed: projects on THIS board for THIS project key whose type is
        // in the board's allowedTypes but whose jiraKey is no longer in Jira.
        const markResult = await this.prisma.project.updateMany({
          where: {
            boardId: boardSource.boardId,
            jiraProjectKey,
            jiraType: { in: allowedTypes },
            jiraKey: { notIn: seenKeys },
          },
          data: { jiraRemovedFromSource: true },
        });
        markedRemoved += markResult.count;
      }
    }

    return { created, updated, markedRemoved };
  }

  /**
   * Resolve a Jira status string to a board_status ID.
   *
   * Resolution order:
   * 1. Explicit mapping value (UUID → direct; legacy enum → label lookup)
   * 2. Case-insensitive label match on the board
   * 3. Upsert a new board status with the Jira status name
   */
  private async resolveStatusId(
    jiraStatus: string,
    statusMap: Record<string, string>,
    boardId: string,
    cache: Map<string, CachedBoardStatus>,
  ): Promise<string> {
    const mapped = statusMap[jiraStatus];
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

    // Fallback: case-insensitive match on Jira status name
    const byName = cache.get(jiraStatus.toLowerCase());
    if (byName) return byName.id;

    // No match — upsert a new board status
    return this.upsertBoardStatus(jiraStatus, boardId, cache);
  }

  /** Create a new board status for an unknown Jira status, handling race conditions. */
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

  /** Pick a random color not yet used by statuses on this board (uses in-memory cache). */
  private pickUnusedColor(cache: Map<string, CachedBoardStatus>): string {
    const usedSet = new Set<string>();
    for (const s of cache.values()) usedSet.add(s.color);
    const available = STATUS_COLORS.filter((c) => !usedSet.has(c));
    if (available.length > 0) {
      return available[Math.floor(Math.random() * available.length)]!;
    }
    return STATUS_COLORS[Math.floor(Math.random() * STATUS_COLORS.length)]!;
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
    row: Record<string, unknown>,
    projectId: string
  ): Promise<void> {
    for (const [jiraField, columnId] of Object.entries(fieldMappings)) {
      const value = row[jiraField];
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

import type { PrismaClient, Prisma } from "@deckgauge/db";
import { ProjectSchema, ProjectStatusEnum, CostClassificationEnum, DURATION_RE, type Project, readOverrideState, markOverridden, clearOverride, SYNC_FIELDS, isCustomColumnKey, columnIdFromKey } from "@deckgauge/shared";
import { z } from "zod";
import { mirrorClassification } from './classification-mirror.js';
import {
  SYNC_EXCLUSION_SELECT,
  recordSyncExclusions,
  toSyncExclusion,
  toSyncExclusions,
} from '../board-sync/sync-exclusion.js';

const DELETE_ROW_SELECT = {
  id: true,
  ...SYNC_EXCLUSION_SELECT,
} as const;

/**
 * Maps default board status labels to their canonical ProjectStatus enum values.
 * Used to keep the `status` enum field in sync when a `statusId` (custom board status) is set.
 * Custom labels not present here leave the enum status unchanged.
 */
const BOARD_STATUS_LABEL_TO_ENUM: Record<string, string> = {
  "Not Started": "NOT_STARTED",
  "In Progress": "IN_PROGRESS",
  "At Risk": "AT_RISK",
  "Blocked": "BLOCKED",
  "Done": "DONE",
};

/**
 * Maps canonical ProjectStatus enum values to human-readable labels.
 * Used when recording ProjectStatusChange history entries.
 */
const STATUS_ENUM_TO_LABEL: Record<string, string> = {
  NOT_STARTED: 'Not started',
  IN_PROGRESS: 'In progress',
  AT_RISK: 'At risk',
  BLOCKED: 'Blocked',
  DONE: 'Done',
};

// The revert-eligible field keys: the registry's tracked sync fields, plus
// the `col:<columnId>` namespace for custom columns (not yet revertible —
// applyRevertedValue's `default` arm still no-ops on them — but a real,
// intended future case, so the schema must not reject it outright).
const KNOWN_REVERT_FIELD_KEYS = new Set(SYNC_FIELDS.map((f) => f.key));

export const CreateProjectInputSchema = z.object({
  name: z.string().trim().min(1),
  owner: z.string().trim().min(1),
  status: ProjectStatusEnum,
  description: z.string().optional(),
  boardId: z.string().uuid().optional(),
  groupId: z.string().uuid().optional(),
});
export type CreateProjectInput = z.infer<typeof CreateProjectInputSchema>;

export const UpdateProjectInputSchema = CreateProjectInputSchema.extend({
  order: z.number().nullable().optional(),
  groupId: z.string().nullable().optional(),
  ownerId: z.string().uuid().nullable().optional(),
  // Clears a manual Owner override: copies the synced assignee back into owner
  // and re-links the field so future syncs update it again.
  // Field keys to re-link to their sync source: restores each key's pre-edit
  // synced value and drops it from the override set. A revert and an edit of
  // the same key in one request means the revert wins. Rejected at the schema
  // boundary (400) for anything outside the known sync-field keys or the
  // `col:` custom-column namespace, rather than silently no-opping deep in
  // the service.
  revertFields: z.array(
    z.string().refine(
      (key) => KNOWN_REVERT_FIELD_KEYS.has(key) || isCustomColumnKey(key),
      { message: "Unknown field key for revert" },
    ),
  ).optional(),
  statusId: z.string().uuid().nullable().optional(),
  startDate: z.coerce.date().nullable().optional(),
  endDate: z.coerce.date().nullable().optional(),
  dueDate: z.coerce.date().nullable().optional(),
  durationCode: z.string().regex(DURATION_RE).nullable().optional(),
  costClassification: CostClassificationEnum.nullable().optional(),
}).partial().refine(
  (data) => Object.keys(data).length > 0,
  { message: "At least one field must be provided for update" },
);
export type UpdateProjectInput = z.infer<typeof UpdateProjectInputSchema>;

// Both `order` and `groupId` are optional so /projects/reorder can do
// groupId-only moves (without reordering) AND order-only reorders (without
// moving groups). Jira-synced projects can have `order: null` in the DB
// (the sync doesn't assign a board-order on ingest), so a bulk move-to-
// group must be possible without supplying an order. The service body
// conditionally includes whichever fields are present.
export const ReorderItemSchema = z.object({
  id: z.string().uuid(),
  order: z.number().optional(),
  groupId: z.string().optional(),
}).refine(
  (data) => data.order !== undefined || data.groupId !== undefined,
  { message: "At least one of order or groupId must be provided" },
);

export const ReorderInputSchema = z.array(ReorderItemSchema).min(1);
export type ReorderInput = z.infer<typeof ReorderInputSchema>;

function mapToProject(raw: {
  id: string;
  name: string;
  owner: string;
  status: string;
  description: string | null;
  order: number | null;
  groupId: string | null;
  createdAt: Date;
  updatedAt: Date;
  [key: string]: unknown;
}): Project {
  return ProjectSchema.parse({
    ...raw,
    owner: raw.owner || "Unassigned",
  });
}

/**
 * The Project scalar each tracked field key reads from, for snapshot capture.
 * `status` snapshots `statusId` rather than the legacy enum: the id is the real
 * value, and the enum is derived from it on both write and revert, so a revert
 * cannot leave the two disagreeing.
 *
 * Values are JSON-safe — Dates become ISO strings — because this lands in a
 * Prisma `Json` column.
 */
function currentValueForKey(
  row: Record<string, unknown>,
  key: string,
): unknown {
  switch (key) {
    case 'name':
    case 'description':
    case 'owner':
      return row[key] ?? null;
    case 'status':
      return row.statusId ?? null;
    case 'dueDate':
      return row.dueDate instanceof Date ? row.dueDate.toISOString() : (row.dueDate ?? null);
    default:
      return null;
  }
}

/**
 * Writes a reverted snapshot value into the Prisma update payload. Returns
 * whether it actually wrote one, so the caller only clears the override (and
 * discards the snapshot) when a restore genuinely happened — never for a key
 * this function doesn't handle, and never for a `name` snapshot too degenerate
 * to write back.
 *
 * Scalar `Project` columns only. A `col:<columnId>` key restores a row in
 * `ProjectFieldValue` instead, which this `data` object cannot express — see
 * `columnRestoreFor` and the call site.
 *
 * The caller is responsible for skipping this entirely when the snapshot
 * entry itself is missing (`undefined`) — that's a dirty flag with no
 * captured value to restore, and must never be papered over here with a
 * fallback default (that would be a wipe, not a revert). What reaches this
 * function is either a legitimately-captured value, which may itself be
 * `null` (e.g. an owner or due date that was already unset when captured).
 *
 * `status` is deliberately absent: reverting it feeds the restored statusId
 * through the same derivation an explicit statusId edit uses, so both paths
 * produce the enum identically.
 */
function applyRevertedValue(
  data: Record<string, unknown>,
  key: string,
  value: unknown,
): boolean {
  switch (key) {
    case 'name':
      if (typeof value !== 'string' || value.trim() === '') return false;
      data.name = value;
      return true;
    case 'description':
      data.description = (value ?? null) as string | null;
      return true;
    case 'owner':
      data.owner = (value ?? '') as string;
      return true;
    case 'dueDate':
      data.dueDate = value == null ? null : new Date(value as string);
      return true;
    default:
      return false;
  }
}

/**
 * A reverted custom column, which lands in a DIFFERENT table than the scalar
 * keys above: its value is a `ProjectFieldValue` row keyed by (projectId,
 * columnId), not a column on `Project`. Kept out of `applyRevertedValue`'s
 * `data` payload deliberately — smuggling a relation write through the scalar
 * update object is exactly how the two shapes would drift apart.
 */
interface ColumnRestore {
  columnId: string;
  /**
   * The value to write back, or `null` when the column held nothing before the
   * edit — in which case the row is REMOVED. Writing `null` through would put
   * the string "null" on the board, which is not what the user reverted to.
   */
  value: string | null;
}

/**
 * The restore a `col:<columnId>` revert implies, or null when this key isn't a
 * custom column or its snapshot has a shape we cannot write back. Null means
 * the same thing it means for `applyRevertedValue`: change nothing, and leave
 * the override in place rather than clearing it on a restore that never happened.
 */
function columnRestoreFor(key: string, snapshot: unknown): ColumnRestore | null {
  const columnId = columnIdFromKey(key);
  if (columnId === null) return null;
  if (snapshot === null) return { columnId, value: null };
  if (typeof snapshot === "string") return { columnId, value: snapshot };
  return null;
}

/** Which tracked field key an update input touches, if any. */
const INPUT_KEY_TO_FIELD: ReadonlyArray<{ inputKeys: readonly string[]; field: string }> = [
  { inputKeys: ['name'], field: 'name' },
  { inputKeys: ['description'], field: 'description' },
  { inputKeys: ['owner'], field: 'owner' },
  { inputKeys: ['dueDate'], field: 'dueDate' },
  { inputKeys: ['status', 'statusId'], field: 'status' },
];

export class ProjectService {
  constructor(private readonly prisma: PrismaClient) {}

  async list(
    opts: {
      boardId?: string;
      groupId?: string;
      page?: number;
      pageSize?: number;
      search?: string;
      statuses?: string[];
      sort?: {
        column: "name" | "owner" | "status" | "updatedAt";
        direction: "asc" | "desc";
      };
    } = {},
  ): Promise<{
    items: (Project & { fieldValues?: { columnId: string; value: string }[] })[];
    total: number;
    hasMore: boolean;
  }> {
    const page = Math.max(1, Math.floor(opts.page ?? 1));
    const pageSize = Math.min(500, Math.max(1, Math.floor(opts.pageSize ?? 200)));

    // Build the filter incrementally; collapse to `undefined` when empty so the
    // no-filter query is byte-identical to the original (and its tests).
    //
    // INVARIANT — `boardId` is optional in this signature but REQUIRED of every
    // caller, and a caller that omits it reads every board in the deployment.
    //
    // It holds today: the only production caller is `GET /projects`, where
    // `ProjectListQuerySchema` declares `boardId: z.string().uuid()` (required) and
    // the route policy is `board("VIEWER", viaBoardId(fromQuery("boardId")))`. The
    // Zod requirement is the load-bearing half — single-user mode bypasses the
    // policy layer entirely — which is why it is stated on the schema too.
    //
    // This is NOT the same shape as the unscoped sync handlers fixed on
    // 2026-08-27 (planning/TENANCY-PROGRAMME.md §5d), and the distinction is the
    // reason this predicate is considered sufficient: there, the policy inspected
    // no entity and the query carried no predicate at all. Here the predicate IS
    // the id the policy authorised on the same request.
    //
    // **A second caller must pass `boardId`.** Making it a required parameter is
    // the durable fix and is deliberately deferred: it changes three pre-existing
    // assertions that pin the `where: undefined` no-filter contract, which is not
    // a change to make as a drive-by. Do it when this service is next opened on
    // purpose.
    const where: Record<string, unknown> = {};
    if (opts.boardId) where.boardId = opts.boardId;
    if (opts.groupId) where.groupId = opts.groupId;
    if (opts.statuses && opts.statuses.length > 0) {
      where.status = { in: opts.statuses };
    }
    if (opts.search && opts.search.trim()) {
      const q = opts.search.trim();
      where.OR = [
        { name: { contains: q, mode: "insensitive" } },
        { owner: { contains: q, mode: "insensitive" } },
      ];
    }
    const whereArg = Object.keys(where).length > 0 ? where : undefined;

    // A unique final tiebreaker (id) makes the ORDER BY a total order so OFFSET
    // pagination is deterministic and consistent across the separate page queries
    // the board issues. Without it, rows that tie on the leading keys (e.g. a board
    // whose rows all have order=null and share createdAt) have no defined order
    // between queries, so a row at a page boundary can be returned on two pages
    // (rendered twice) while another is skipped.
    const orderBy = opts.sort
      ? [{ [opts.sort.column]: opts.sort.direction }, { id: "asc" as const }]
      : [{ order: "asc" as const }, { createdAt: "asc" as const }, { id: "asc" as const }];

    const skip = (page - 1) * pageSize;
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.project.findMany({
        where: whereArg,
        orderBy,
        include: { fieldValues: { select: { columnId: true, value: true } } },
        skip,
        take: pageSize,
      }),
      this.prisma.project.count({ where: whereArg }),
    ]);
    const items = rows.map((row) => {
      const { fieldValues, ...rest } = row;
      return { ...mapToProject(rest), fieldValues };
    });
    return { items, total, hasMore: skip + items.length < total };
  }

  async getById(id: string): Promise<Project | null> {
    const row = await this.prisma.project.findUnique({ where: { id } });
    return row ? mapToProject(row) : null;
  }

  async create(input: CreateProjectInput): Promise<Project> {
    // Place a new item at the bottom of its group (or board): one past the
    // current max order among its siblings. Sibling `order` can be null —
    // Jira-synced rows and never-reordered rows have no board order — so
    // `_max.order` ignores nulls and we coalesce to 0. The board buckets a
    // group's items with `(order ?? 0)` ascending (apps/web/app/page.tsx),
    // so a non-null order strictly greater than every sibling's `order ?? 0`
    // guarantees the new item renders last.
    const order = await this.nextBottomOrder(input.groupId, input.boardId);

    const row = await this.prisma.project.create({
      data: {
        name: input.name,
        owner: input.owner,
        status: input.status,
        description: input.description ?? null,
        ...(input.boardId && { boardId: input.boardId }),
        ...(input.groupId && { groupId: input.groupId }),
        ...(order !== undefined && { order }),
      },
    });

    if (input.boardId) {
      const sizeColumn = await this.prisma.boardColumn.findFirst({
        where: { boardId: input.boardId, name: "Size" },
        select: { id: true },
      });
      if (sizeColumn) {
        await this.prisma.projectFieldValue.create({
          data: { projectId: row.id, columnId: sizeColumn.id, value: "L" },
        });
      }
    }

    return mapToProject(row);
  }

  // Returns the order to place a new item at the bottom of its group/board,
  // or undefined when the item belongs to neither (no list to append to).
  private async nextBottomOrder(
    groupId?: string,
    boardId?: string,
  ): Promise<number | undefined> {
    const where = groupId ? { groupId } : boardId ? { boardId } : undefined;
    if (!where) return undefined;

    const agg = await this.prisma.project.aggregate({
      where,
      _max: { order: true },
    });
    return (agg._max.order ?? 0) + 1;
  }

  async update(id: string, input: UpdateProjectInput, userId?: string): Promise<Project | null> {
    const existing = await this.prisma.project.findUnique({ where: { id } });
    if (!existing) return null;

    const revertKeys = input.revertFields ?? [];
    let overrides = readOverrideState(existing as Record<string, unknown>);

    // Reverts are resolved first so a revert of `status` can feed its restored
    // statusId through the derivation below — the reverted id must produce the
    // enum exactly as an explicit statusId edit would.
    const revertData: Record<string, unknown> = {};
    // Custom-column reverts, collected here and applied to ProjectFieldValue
    // after the Project row is written — they cannot ride along in `revertData`.
    const columnRestores: ColumnRestore[] = [];
    let revertedStatusId: string | null | undefined;
    // Tracks whether this request actually touched a tracked field (via revert
    // or edit), as opposed to whether the resulting override state's *content*
    // differs from what it started as. The two are not the same: markOverridden
    // deliberately no-ops when a field is already dirty (it must not overwrite
    // an existing snapshot with a later edit's value), so re-editing an
    // already-overridden field leaves `overrides` content-identical to
    // `readOverrideState(existing)` even though the field WAS touched — and the
    // write still needs to carry the (unchanged) override columns in that case.
    let overridesTouched = false;
    for (const key of revertKeys) {
      if (!overrides.overriddenFields.includes(key)) continue; // nothing to restore
      const snapshot = overrides.preOverrideValues[key];
      // A missing snapshot entry (as opposed to one legitimately captured as
      // `null`) means the field is flagged dirty but nothing was ever
      // recorded to restore it to — writing a fallback here would wipe the
      // field instead of reverting it, so leave the override alone entirely.
      if (snapshot === undefined) continue;
      let restored: boolean;
      if (key === 'status') {
        revertedStatusId = (snapshot ?? null) as string | null;
        restored = true;
      } else if (isCustomColumnKey(key)) {
        // A mapped Jira column. Its value lives in ProjectFieldValue, so the
        // restore is queued rather than written into `revertData`.
        const restore = columnRestoreFor(key, snapshot);
        if (restore) columnRestores.push(restore);
        restored = restore !== null;
      } else {
        restored = applyRevertedValue(revertData, key, snapshot);
      }
      if (!restored) continue;
      overrides = clearOverride(overrides, key);
      overridesTouched = true;
    }

    // A manual edit marks the field dirty, capturing what it held beforehand.
    // Skipped for a key being reverted in the same request: the revert wins.
    for (const { inputKeys, field } of INPUT_KEY_TO_FIELD) {
      if (revertKeys.includes(field)) continue;
      const touched = inputKeys.some(
        (k) => (input as Record<string, unknown>)[k] !== undefined,
      );
      if (!touched) continue;
      overrides = markOverridden(
        overrides,
        field,
        currentValueForKey(existing as Record<string, unknown>, field),
      );
      overridesTouched = true;
    }

    // The status id to write: a revert's restored id wins over an explicit edit.
    const statusIdToWrite = revertedStatusId !== undefined ? revertedStatusId : input.statusId;

    // When only a statusId is in play (custom board-status change, or a
    // revert), derive the canonical enum from the board status label so
    // automations and filters stay correct. Also runs when a status WAS
    // reverted even if the request also sent an explicit `status` edit: the
    // revert must win, and the only way to know what to write instead of the
    // losing edit is to derive it from the restored id.
    let derivedStatus: string | undefined;
    if (
      statusIdToWrite !== undefined &&
      statusIdToWrite !== null &&
      (revertedStatusId !== undefined || input.status === undefined)
    ) {
      const boardStatus = await this.prisma.boardStatus.findUnique({
        where: { id: statusIdToWrite },
      });
      if (boardStatus) {
        derivedStatus = BOARD_STATUS_LABEL_TO_ENUM[boardStatus.label];
      }
    }

    // Resolve the status to write: a status revert's derived enum wins over
    // an explicit status edit in the same request (revert beats edit, and
    // this is the only way statusId and the enum can't end up disagreeing);
    // otherwise explicit input wins, then derived, then omit.
    const statusToWrite =
      revertedStatusId !== undefined
        ? (derivedStatus as typeof input.status)
        : (input.status ?? (derivedStatus as typeof input.status));

    const row = await this.prisma.project.update({
      where: { id },
      data: {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.owner !== undefined && { owner: input.owner }),
        ...(statusToWrite !== undefined && { status: statusToWrite }),
        ...(input.description !== undefined && { description: input.description }),
        ...(input.order !== undefined && { order: input.order }),
        ...(input.groupId !== undefined && { groupId: input.groupId }),
        ...(input.ownerId !== undefined && { ownerId: input.ownerId }),
        ...(statusIdToWrite !== undefined && { statusId: statusIdToWrite }),
        ...(input.startDate !== undefined && { startDate: input.startDate }),
        ...(input.endDate !== undefined && { endDate: input.endDate }),
        ...(input.dueDate !== undefined && { dueDate: input.dueDate }),
        ...(input.durationCode !== undefined && { durationCode: input.durationCode }),
        ...(input.costClassification !== undefined && { costClassification: input.costClassification }),
        // Reverted values land AFTER the edit spreads so a revert beats an edit
        // of the same field in one request.
        ...revertData,
        ...(overridesTouched && {
          overriddenFields: overrides.overriddenFields,
          preOverrideValues: overrides.preOverrideValues as Prisma.InputJsonValue,
        }),
      },
    });

    // Custom-column reverts, applied once the Project row (carrying the cleared
    // override set) is committed. Ordered after deliberately: should a write
    // here fail, the override is already cleared, so the next sync rewrites the
    // column from Jira — the same end state a successful restore reaches. The
    // reverse order would leave the column re-linked to nothing and frozen.
    for (const restore of columnRestores) {
      if (restore.value === null) {
        // Nothing was there before the edit. `deleteMany` rather than `delete`
        // so a row already absent is a no-op instead of a P2025 throw.
        await this.prisma.projectFieldValue.deleteMany({
          where: { projectId: id, columnId: restore.columnId },
        });
      } else {
        await this.prisma.projectFieldValue.upsert({
          where: { projectId_columnId: { projectId: id, columnId: restore.columnId } },
          update: { value: restore.value },
          create: { projectId: id, columnId: restore.columnId, value: restore.value },
        });
      }
    }

    // Record status change if status actually changed
    const resolvedStatus = statusToWrite;
    if (resolvedStatus && resolvedStatus !== existing.status) {
      await this.prisma.projectStatusChange.create({
        data: {
          projectId: id,
          fromStatus: STATUS_ENUM_TO_LABEL[existing.status] ?? existing.status,
          toStatus: STATUS_ENUM_TO_LABEL[resolvedStatus] ?? resolvedStatus,
          changedBy: userId ?? null,
        },
      });
    }

    if (input.costClassification !== undefined) {
      try {
        // mirrorClassification only ever inserts when row.boardId is set
        // (buildClassificationRow's own guard), so the organization that
        // owns that board is the real tenant for this row — not a
        // placeholder, but the one piece of plumbing this write actually
        // needs. A boardless project has no tenant to mirror into.
        const board = row.boardId
          ? await this.prisma.board.findUnique({
              where: { id: row.boardId },
              select: { organizationId: true },
            })
          : null;
        if (board) {
          await mirrorClassification(
            {
              id: row.id,
              boardId: row.boardId,
              jiraKey: row.jiraKey,
              adoWorkItemId: row.adoWorkItemId,
              adoProject: row.adoProject,
              githubIssueId: row.githubIssueId,
              costClassification: row.costClassification,
            },
            board.organizationId,
          );
        }
      } catch (err) {
        // Mirror failure is non-fatal: Postgres has already committed the update.
        // Log at error level (same pattern as the automation-trigger block in
        // project.routes.ts) so ops can detect ClickHouse drift without surfacing
        // the error to the client.
        // Non-fatal: Postgres commit already succeeded. Log to stderr so the
        // Fastify/pino process logger captures it (same approach as index.ts
        // startup errors; service layer has no injected app.log instance).
        console.error('[project.service] ClickHouse classification mirror failed', err);
      }
    }

    return mapToProject(row);
  }

  async delete(id: string, userId?: string): Promise<boolean> {
    const existing = await this.prisma.project.findUnique({
      where: { id },
      select: DELETE_ROW_SELECT,
    });
    if (!existing) return false;

    await this.prisma.$transaction(async (tx) => {
      const exclusion = toSyncExclusion(existing, userId);
      await recordSyncExclusions(tx, exclusion ? [exclusion] : []);
      await tx.project.delete({ where: { id } });
    });
    return true;
  }

  // Bulk delete by id. Used by the board's "delete selected" action, where the
  // selection can be tens of thousands of rows. Issuing one DELETE per id (the
  // old client loop) times out; a single deleteMany with a huge IN list risks
  // exceeding Postgres bind-parameter limits. So delete in bounded chunks and
  // sum the counts. Child rows cascade at the DB level (onDelete: Cascade).
  async deleteMany(ids: string[], userId?: string): Promise<number> {
    const CHUNK_SIZE = 1000;
    let deleted = 0;
    for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
      const chunk = ids.slice(i, i + CHUNK_SIZE);
      deleted += await this.prisma.$transaction(async (tx) => {
        const rows = await tx.project.findMany({
          where: { id: { in: chunk } },
          select: DELETE_ROW_SELECT,
        });
        await recordSyncExclusions(tx, toSyncExclusions(rows, userId));
        const result = await tx.project.deleteMany({ where: { id: { in: chunk } } });
        return result.count;
      });
    }
    return deleted;
  }

  async reorder(items: ReorderInput): Promise<Project[]> {
    const updates = items.map((item) =>
      this.prisma.project.update({
        where: { id: item.id },
        data: {
          ...(item.order !== undefined && { order: item.order }),
          ...(item.groupId !== undefined && { groupId: item.groupId }),
        },
      }),
    );

    const rows = await this.prisma.$transaction(updates);
    return rows.map(mapToProject);
  }

  async moveProjectToBoard(
    projectId: string,
    targetGroupId: string,
    userId?: string,
  ): Promise<{
    project: Project;
    dropped: { ownerCleared: boolean; statusReset: boolean; columnsDropped: string[] };
  }> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: { fieldValues: true, boardOwner: true, boardStatus: true },
    });
    if (!project) throw new Error('PROJECT_NOT_FOUND');

    const targetGroup = await this.prisma.group.findUnique({
      where: { id: targetGroupId },
      select: { id: true, boardId: true },
    });
    if (!targetGroup) throw new Error('GROUP_NOT_FOUND');

    const order = await this.nextBottomOrder(targetGroupId, targetGroup.boardId);

    // Same-board move: just relocate the group.
    if (targetGroup.boardId === project.boardId) {
      const row = await this.prisma.project.update({
        where: { id: projectId },
        data: { groupId: targetGroupId, ...(order !== undefined && { order }) },
      });
      void userId; // reserved for future audit
      return {
        project: mapToProject(row),
        dropped: { ownerCleared: false, statusReset: false, columnsDropped: [] },
      };
    }

    const targetBoardId = targetGroup.boardId!;

    // Resolve target status (by source label), owner (by userId then name), columns (by name+type).
    const sourceStatusLabel = project.boardStatus?.label ?? null;
    const targetStatus = sourceStatusLabel
      ? await this.prisma.boardStatus.findFirst({
          where: { boardId: targetBoardId, label: sourceStatusLabel },
          select: { id: true },
        })
      : null;
    const statusReset = !!project.statusId && !targetStatus;

    let targetOwnerId: string | null = null;
    let ownerCleared = false;
    if (project.ownerId) {
      const o = project.boardOwner;
      const orClauses: Array<{ userId: string } | { name: string }> = [];
      if (o?.userId) orClauses.push({ userId: o.userId });
      if (o?.name) orClauses.push({ name: o.name });
      const match = orClauses.length
        ? await this.prisma.boardOwner.findFirst({
            where: { boardId: targetBoardId, OR: orClauses },
            select: { id: true },
          })
        : null;
      targetOwnerId = match?.id ?? null;
      ownerCleared = !match;
    }

    // Map custom columns by (name, type).
    const sourceColIds = project.fieldValues.map((fv) => fv.columnId);
    const sourceCols = sourceColIds.length
      ? await this.prisma.boardColumn.findMany({
          where: { id: { in: sourceColIds } },
          select: { id: true, name: true, type: true },
        })
      : [];
    const targetCols = await this.prisma.boardColumn.findMany({
      where: { boardId: targetBoardId },
      select: { id: true, name: true, type: true },
    });
    const targetByKey = new Map(targetCols.map((c) => [`${c.name}::${c.type}`, c.id]));
    const sourceColById = new Map(sourceCols.map((c) => [c.id, c]));

    const keep: { fieldValueId: string; newColumnId: string }[] = [];
    const dropFieldValueIds: string[] = [];
    const columnsDropped: string[] = [];
    for (const fv of project.fieldValues) {
      const col = sourceColById.get(fv.columnId);
      const targetColId = col ? targetByKey.get(`${col.name}::${col.type}`) : undefined;
      if (col && targetColId) keep.push({ fieldValueId: fv.id, newColumnId: targetColId });
      else {
        dropFieldValueIds.push(fv.id);
        if (col) columnsDropped.push(col.name);
      }
    }

    const row = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.project.update({
        where: { id: projectId },
        data: {
          boardId: targetBoardId,
          groupId: targetGroupId,
          ...(order !== undefined && { order }),
          statusId: targetStatus?.id ?? null,
          ...(project.ownerId && { ownerId: targetOwnerId }),
        },
      });
      for (const k of keep) {
        await tx.projectFieldValue.update({
          where: { id: k.fieldValueId },
          data: { columnId: k.newColumnId },
        });
      }
      if (dropFieldValueIds.length) {
        await tx.projectFieldValue.deleteMany({ where: { id: { in: dropFieldValueIds } } });
      }
      return updated;
    });

    return {
      project: mapToProject(row),
      dropped: { ownerCleared, statusReset, columnsDropped },
    };
  }
}


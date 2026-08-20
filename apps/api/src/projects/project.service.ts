import type { PrismaClient } from "@deckgauge/db";
import { ProjectSchema, ProjectStatusEnum, CostClassificationEnum, DURATION_RE, type Project } from "@deckgauge/shared";
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
  resetOwnerToAssignee: z.boolean().optional(),
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

    // When only statusId is provided (custom board-status change), derive the canonical
    // enum status from the board status label so automations and filters work correctly.
    let derivedStatus: string | undefined;
    if (input.statusId !== undefined && input.statusId !== null && input.status === undefined) {
      const boardStatus = await this.prisma.boardStatus.findUnique({
        where: { id: input.statusId },
      });
      if (boardStatus) {
        derivedStatus = BOARD_STATUS_LABEL_TO_ENUM[boardStatus.label];
      }
    }

    // Resolve the status to write: explicit input wins, then derived, then omit.
    // Cast derivedStatus to the same type as input.status (a Zod-validated enum literal).
    // BOARD_STATUS_LABEL_TO_ENUM only ever returns valid ProjectStatus values.
    const statusToWrite = input.status ?? (derivedStatus as typeof input.status);

    // Owner is a manual system field that defaults to the synced assignee.
    // Resetting re-links it to assignee; any explicit edit breaks the link so
    // future syncs stop overwriting it (see the promote services).
    const ownerData: { owner?: string; ownerOverridden?: boolean } = {};
    if (input.resetOwnerToAssignee) {
      ownerData.owner = existing.assignee;
      ownerData.ownerOverridden = false;
    } else if (input.owner !== undefined) {
      ownerData.owner = input.owner;
      ownerData.ownerOverridden = true;
    }

    const row = await this.prisma.project.update({
      where: { id },
      data: {
        ...(input.name !== undefined && { name: input.name }),
        ...ownerData,
        ...(statusToWrite !== undefined && { status: statusToWrite }),
        ...(input.description !== undefined && { description: input.description }),
        ...(input.order !== undefined && { order: input.order }),
        ...(input.groupId !== undefined && { groupId: input.groupId }),
        ...(input.ownerId !== undefined && { ownerId: input.ownerId }),
        ...(input.statusId !== undefined && { statusId: input.statusId }),
        ...(input.startDate !== undefined && { startDate: input.startDate }),
        ...(input.endDate !== undefined && { endDate: input.endDate }),
        ...(input.dueDate !== undefined && { dueDate: input.dueDate }),
        ...(input.durationCode !== undefined && { durationCode: input.durationCode }),
        ...(input.costClassification !== undefined && { costClassification: input.costClassification }),
      },
    });

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


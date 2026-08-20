import type { PrismaClient, Group } from "@deckgauge/db";
import { z } from "zod";
import {
  SYNC_EXCLUSION_SELECT,
  recordSyncExclusions,
  toSyncExclusions,
} from "../board-sync/sync-exclusion.js";

export const CreateGroupInputSchema = z.object({
  name: z.string().trim().min(1),
  boardId: z.string().uuid(),
});
export type CreateGroupInput = z.infer<typeof CreateGroupInputSchema>;

export const UpdateGroupInputSchema = z.object({
  name: z.string().trim().min(1).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
});
export type UpdateGroupInput = z.infer<typeof UpdateGroupInputSchema>;

export const ReorderGroupsInputSchema = z.array(
  z.object({
    id: z.string().uuid(),
    position: z.number().int().min(0),
  }),
);
export type ReorderGroupsInput = z.infer<typeof ReorderGroupsInputSchema>;

// A group here can hold thousands of rows (one board carries 4,000+ in a single
// group), and deleting it cascades through every child of every row. Prisma's
// 5s interactive-transaction default is not enough for that, and timing out
// would abort the delete entirely — so this one transaction gets its own budget.
const DELETE_TIMEOUT_MS = 120_000;
const DELETE_MAX_WAIT_MS = 10_000;

export class GroupService {
  constructor(private readonly prisma: PrismaClient) {}

  async listByBoard(boardId: string): Promise<Group[]> {
    return await this.prisma.group.findMany({
      where: { boardId },
      orderBy: { position: "asc" },
    });
  }

  // Per-group totals and status distribution via a single groupBy. Lets the
  // board render group headers/status bars for large boards without shipping
  // every project row to the client.
  async summariesByBoard(
    boardId: string,
  ): Promise<
    { groupId: string; total: number; statusCounts: Record<string, number> }[]
  > {
    const rows = await this.prisma.project.groupBy({
      by: ["groupId", "status"],
      where: { boardId, groupId: { not: null } },
      _count: { _all: true },
    });
    const map = new Map<
      string,
      { groupId: string; total: number; statusCounts: Record<string, number> }
    >();
    for (const r of rows) {
      if (!r.groupId) continue;
      const entry = map.get(r.groupId) ?? {
        groupId: r.groupId,
        total: 0,
        statusCounts: {},
      };
      const count = r._count._all;
      entry.statusCounts[r.status] = (entry.statusCounts[r.status] ?? 0) + count;
      entry.total += count;
      map.set(r.groupId, entry);
    }
    return [...map.values()];
  }

  async getById(id: string): Promise<Group | null> {
    return await this.prisma.group.findUnique({ where: { id } });
  }

  async create(input: CreateGroupInput): Promise<Group | null> {
    const validated = CreateGroupInputSchema.parse(input);

    const board = await this.prisma.board.findUnique({
      where: { id: validated.boardId },
    });
    if (!board) return null;

    const position = await this.prisma.group.count({
      where: { boardId: validated.boardId },
    });

    return await this.prisma.group.create({
      data: {
        name: validated.name,
        boardId: validated.boardId,
        position,
      },
    });
  }

  async update(id: string, input: UpdateGroupInput): Promise<Group | null> {
    const validated = UpdateGroupInputSchema.parse(input);

    const existing = await this.prisma.group.findUnique({ where: { id } });
    if (!existing) return null;

    const data: Record<string, unknown> = {};
    if (validated.name !== undefined) data.name = validated.name;
    if (validated.color !== undefined) data.color = validated.color;

    return await this.prisma.group.update({ where: { id }, data });
  }

  // Deleting a group takes its rows with it — `Project.group` is
  // `onDelete: Cascade`, so Postgres removes them without the project service
  // ever seeing them. Record their sync exclusions here, in the same
  // transaction, or a group delete silently un-deletes itself on the next sync.
  async delete(id: string, userId?: string): Promise<{ deleted: boolean; reason?: string }> {
    const existing = await this.prisma.group.findUnique({ where: { id } });
    if (!existing) return { deleted: false, reason: "not_found" };

    await this.prisma.$transaction(
      async (tx) => {
        const rows = await tx.project.findMany({
          where: { groupId: id },
          select: SYNC_EXCLUSION_SELECT,
        });
        await recordSyncExclusions(tx, toSyncExclusions(rows, userId));
        await tx.group.delete({ where: { id } });
      },
      { timeout: DELETE_TIMEOUT_MS, maxWait: DELETE_MAX_WAIT_MS },
    );
    return { deleted: true };
  }

  async reorderGroups(
    updates: ReorderGroupsInput,
  ): Promise<Group[]> {
    const validated = ReorderGroupsInputSchema.parse(updates);

    const results = await this.prisma.$transaction(
      validated.map((update) =>
        this.prisma.group.update({
          where: { id: update.id },
          data: { position: update.position },
        }),
      ),
    );

    return results;
  }
}

import type { PrismaClient, Board, Prisma } from '@deckgauge/db';
import { z } from 'zod';
import {
  DEFAULT_BOARD_STATUSES,
  SIZE_COLUMN_NAME,
  SIZE_COLUMN_CONFIG,
  DEFAULT_SIZE_DURATIONS,
  DEFAULT_SIZE_WEEKS,
  getBoardTemplate,
  BOARD_KINDS,
  DEFAULT_BOARD_KIND,
  type ColumnLayout,
} from '@deckgauge/shared';
import { ENGINEERING_INTELLIGENCE_PRESET_V1 } from '../widgets/presets.service.js';

export const CreateBoardInputSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().max(500).optional(),
  // Which template to seed the board from. Defaults to the standard project board.
  template: z.enum(BOARD_KINDS).optional(),
});
export type CreateBoardInput = z.infer<typeof CreateBoardInputSchema>;

export const UpdateBoardInputSchema = z.object({
  name: z.string().trim().min(1).optional(),
  description: z.string().max(500).nullish(),
});
export type UpdateBoardInput = z.infer<typeof UpdateBoardInputSchema>;

export class BoardService {
  constructor(private readonly prisma: PrismaClient) {}

  async list(userId: string): Promise<Board[]> {
    return await this.prisma.board.findMany({
      where: { accessEntries: { some: { userId } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  async getById(id: string, userId: string): Promise<Board | null> {
    const board = await this.prisma.board.findUnique({ where: { id } });
    if (!board) return null;

    const access = await this.prisma.boardAccess.findUnique({
      where: { boardId_userId: { boardId: id, userId } },
    });
    if (!access) return null;

    return board;
  }

  async create(
    organizationId: string,
    input: CreateBoardInput,
    createdByUserId?: string,
  ): Promise<Board> {
    const validated = CreateBoardInputSchema.parse(input);
    const template = getBoardTemplate(validated.template ?? DEFAULT_BOARD_KIND);

    return this.prisma.$transaction(async (tx) => {
      const board = await tx.board.create({
        data: {
          organizationId,
          name: validated.name,
          kind: template.kind,
          ...(validated.description !== undefined && { description: validated.description }),
        },
      });

      await tx.boardStatus.createMany({
        data: DEFAULT_BOARD_STATUSES.map((s) => ({
          boardId: board.id,
          label: s.label,
          color: s.color,
          icon: s.icon,
          order: s.order,
          isDefault: s.isDefault,
        })),
      });

      // The Size status column (roadmap's size source) — only for templates that use it.
      if (template.includeSizeColumn) {
        await tx.boardColumn.create({
          data: {
            boardId: board.id,
            name: SIZE_COLUMN_NAME,
            type: 'STATUS',
            order: 0,
            config: SIZE_COLUMN_CONFIG as unknown as Prisma.InputJsonValue,
          },
        });
      }

      // Template-seeded custom columns, ordered after the Size column when present.
      if (template.extraColumns.length > 0) {
        const baseOrder = template.includeSizeColumn ? 1 : 0;
        await tx.boardColumn.createMany({
          data: template.extraColumns.map((col, i) => ({
            boardId: board.id,
            name: col.name,
            type: col.type,
            order: baseOrder + i,
            config: (col.config ?? {}) as unknown as Prisma.InputJsonValue,
          })),
        });
      }

      // Template-seeded pipeline groups (e.g. the recruitment stages).
      if (template.groups.length > 0) {
        await tx.group.createMany({
          data: template.groups.map((g, i) => ({
            boardId: board.id,
            name: g.name,
            color: g.color,
            position: i,
          })),
        });
      }

      if (createdByUserId) {
        await tx.boardAccess.create({
          data: { boardId: board.id, userId: createdByUserId, role: 'OWNER' },
        });
      }

      await tx.boardView.create({
        data: {
          boardId: board.id,
          type: 'BOARD',
          name: 'Main Board',
          position: 0,
        },
      });

      // Statistics dashboard — only for templates that request a dashboard preset.
      if (template.views.dashboard === 'engineering-intelligence') {
        const dashView = await tx.boardView.create({
          data: {
            boardId: board.id,
            type: 'DASHBOARD',
            name: ENGINEERING_INTELLIGENCE_PRESET_V1.viewName,
            position: 1,
            presetKey: ENGINEERING_INTELLIGENCE_PRESET_V1.presetKey,
          },
        });

        await tx.dashboardWidget.createMany({
          data: ENGINEERING_INTELLIGENCE_PRESET_V1.widgets.map((w) => ({
            boardViewId: dashView.id,
            widgetType: w.type,
            title: w.title,
            config: w.config as Prisma.InputJsonValue,
            layout: w.layout as unknown as Prisma.InputJsonValue,
          })),
        });
      }

      // Roadmap view + config — only for templates that are time-phased (needs the Size column).
      if (template.views.roadmap) {
        const roadmapView = await tx.boardView.create({
          data: {
            boardId: board.id,
            type: 'ROADMAP',
            name: 'Roadmap',
            position: 99,
          },
        });
        await tx.roadmapConfig.create({
          data: {
            boardViewId: roadmapView.id,
            startDate: new Date(),
            visibleQuarters: 4,
            sizeDurations: DEFAULT_SIZE_DURATIONS as unknown as Prisma.InputJsonValue,
            defaultSizeWeeks: DEFAULT_SIZE_WEEKS,
          },
        });
      }

      return board;
    });
  }

  async update(id: string, input: UpdateBoardInput): Promise<Board | null> {
    const validated = UpdateBoardInputSchema.parse(input);

    const existing = await this.prisma.board.findUnique({ where: { id } });
    if (!existing) return null;

    const data: Record<string, unknown> = {};
    if (validated.name !== undefined) data.name = validated.name;
    if (validated.description !== undefined) data.description = validated.description;

    return await this.prisma.board.update({ where: { id }, data });
  }

  async delete(id: string): Promise<boolean> {
    const existing = await this.prisma.board.findUnique({ where: { id } });
    if (!existing) return false;

    await this.prisma.board.delete({ where: { id } });
    return true;
  }

  async setHiddenSystemFields(
    boardId: string,
    fields: string[],
  ): Promise<{ id: string; hiddenSystemFields: string[] }> {
    const updated = await this.prisma.board.update({
      where: { id: boardId },
      data: { hiddenSystemFields: fields },
      select: { id: true, hiddenSystemFields: true },
    });
    return updated;
  }

  async setColumnLayout(
    boardId: string,
    layout: ColumnLayout,
  ): Promise<{ id: string; columnLayout: ColumnLayout }> {
    const updated = await this.prisma.board.update({
      where: { id: boardId },
      data: { columnLayout: layout },
      select: { id: true, columnLayout: true },
    });
    return { id: updated.id, columnLayout: updated.columnLayout as ColumnLayout };
  }
}

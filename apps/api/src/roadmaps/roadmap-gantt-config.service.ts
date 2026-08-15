import type { PrismaClient } from '@deckgauge/db';
import {
  type RoadmapConfigPayload,
  type UpdateRoadmapConfigInput,
  type SizeDurations,
  DEFAULT_SIZE_DURATIONS,
  DEFAULT_SIZE_WEEKS,
} from '@deckgauge/shared';

interface GanttConfigRow {
  id: string;
  startDate: Date;
  visibleQuarters: number;
  sizeDurations: unknown;
  defaultSizeWeeks: number;
  hiddenGroupIds: unknown;
}

export class RoadmapGanttConfigService {
  constructor(private readonly prisma: PrismaClient) {}

  /** Ensure a GANTT view + config row exist; return the config as a full payload. */
  async ensure(roadmapId: string): Promise<RoadmapConfigPayload> {
    let view = await this.prisma.roadmapView.findFirst({
      where: { roadmapId, type: 'GANTT' },
      select: { id: true, ganttConfig: true },
    });

    if (!view) {
      view = await this.prisma.roadmapView.create({
        data: {
          roadmapId,
          type: 'GANTT',
          name: 'Timeline',
          position: 1,
          ganttConfig: {
            create: {
              startDate: this.firstOfThisMonth(),
              visibleQuarters: 4,
              sizeDurations: {},
              defaultSizeWeeks: DEFAULT_SIZE_WEEKS,
              hiddenGroupIds: [],
            },
          },
        },
        select: { id: true, ganttConfig: true },
      });
    } else if (!view.ganttConfig) {
      const created = await this.prisma.roadmapGanttConfig.create({
        data: {
          roadmapViewId: view.id,
          startDate: this.firstOfThisMonth(),
          visibleQuarters: 4,
          sizeDurations: {},
          defaultSizeWeeks: DEFAULT_SIZE_WEEKS,
          hiddenGroupIds: [],
        },
      });
      view = { id: view.id, ganttConfig: created } as typeof view;
    }

    return this.toPayload(view.id, view.ganttConfig as unknown as GanttConfigRow);
  }

  /**
   * Read-only companion to `ensure`: returns the current GANTT config if a
   * row already exists, or the same defaults `ensure` would persist —
   * without ever creating a view or a config row. For callers that must
   * never write (the Advisor's page-state reads); callers that need the
   * config to durably exist keep using `ensure`. `id`/`boardViewId` come
   * back empty in the not-yet-materialized case since there is no real row
   * to point at.
   */
  async peek(roadmapId: string): Promise<RoadmapConfigPayload> {
    const view = await this.prisma.roadmapView.findFirst({
      where: { roadmapId, type: 'GANTT' },
      select: { id: true, ganttConfig: true },
    });
    if (view?.ganttConfig) {
      return this.toPayload(view.id, view.ganttConfig as unknown as GanttConfigRow);
    }
    return this.toPayload('', {
      id: '',
      startDate: this.firstOfThisMonth(),
      visibleQuarters: 4,
      sizeDurations: {},
      defaultSizeWeeks: DEFAULT_SIZE_WEEKS,
      hiddenGroupIds: [],
    });
  }

  async update(
    roadmapId: string,
    patch: UpdateRoadmapConfigInput,
  ): Promise<RoadmapConfigPayload> {
    const current = await this.ensure(roadmapId);
    const updated = await this.prisma.roadmapGanttConfig.update({
      where: { id: current.id },
      data: {
        ...(patch.startDate !== undefined && { startDate: new Date(patch.startDate) }),
        ...(patch.visibleQuarters !== undefined && { visibleQuarters: patch.visibleQuarters }),
        ...(patch.sizeDurations !== undefined && { sizeDurations: patch.sizeDurations }),
        ...(patch.defaultSizeWeeks !== undefined && { defaultSizeWeeks: patch.defaultSizeWeeks }),
        ...(patch.hiddenGroupIds !== undefined && { hiddenGroupIds: patch.hiddenGroupIds }),
      },
    });
    return this.toPayload(current.boardViewId, updated as unknown as GanttConfigRow);
  }

  private firstOfThisMonth(): Date {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  }

  private toPayload(viewId: string, row: GanttConfigRow): RoadmapConfigPayload {
    const stored = (row.sizeDurations ?? {}) as Partial<SizeDurations>;
    const sizeDurations = { ...DEFAULT_SIZE_DURATIONS, ...stored } as SizeDurations;
    return {
      id: row.id,
      boardViewId: viewId,
      startDate: row.startDate.toISOString(),
      visibleQuarters: row.visibleQuarters,
      sizeDurations,
      defaultSizeWeeks: row.defaultSizeWeeks ?? DEFAULT_SIZE_WEEKS,
      hiddenGroupIds: (row.hiddenGroupIds as string[]) ?? [],
    };
  }
}

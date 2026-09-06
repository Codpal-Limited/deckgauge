import type { PrismaClient } from '@deckgauge/db';
import {
  sizeWeeksFromLabel,
  type RoadmapConfigPayload,
  type SizeDurations,
} from '@deckgauge/shared';
import { RoadmapConfigService } from './roadmap-config.service.js';

export interface RoadmapProjectPayload {
  id: string;
  name: string;
  status: string;
  groupId: string | null;
  order: number | null;
  /** partition key for parallel tracks: BoardOwner id, else the owner string */
  assigneeId: string | null;
  /** display owner (the project's `owner` string) */
  owner: string;
  sizeLabel: string | null;
  sizeWeeks: number | null;
  startDate: string | null;
  endDate: string | null;
  durationCode: string | null;
}

export interface RoadmapGroupPayload {
  id: string;
  name: string;
  color: string;
  position: number;
}

export interface RoadmapViewPayload {
  config: RoadmapConfigPayload;
  groups: RoadmapGroupPayload[];
  projects: RoadmapProjectPayload[];
}

export class RoadmapService {
  private readonly configService: RoadmapConfigService;
  constructor(private readonly prisma: PrismaClient) {
    this.configService = new RoadmapConfigService(prisma);
  }

  /**
   * `viewId` is OPTIONAL, and that is the whole point.
   *
   * A direct visit, bookmark or shared link to `/boards/<id>/roadmap` carries
   * no `viewId`. This used to take it as required and pass it straight to
   * `findUnique`, so an absent one became `where: { id: undefined }` — which
   * Prisma rejects, surfacing as a 500 and Next's "Application error: a
   * server-side exception has occurred". The in-board Roadmap TAB supplies a
   * viewId and always worked, which is what kept it hidden.
   *
   * With none supplied, fall back to the board's first roadmap view; a board
   * with no roadmap view at all is a 404, not a 500.
   */
  async loadView(boardId: string, viewId?: string): Promise<RoadmapViewPayload> {
    const view = viewId
      ? await this.prisma.boardView.findUnique({ where: { id: viewId } })
      : await this.prisma.boardView.findFirst({
          where: { boardId, type: 'ROADMAP' },
          // `position` defaults to 0 and nothing enforces uniqueness, so
          // `createdAt` breaks a tie deterministically. `position asc` is the
          // ordering `board-views.service.ts` already uses, so a deep link
          // lands on the same view the tab strip shows first.
          orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
        });
    if (!view || view.boardId !== boardId) throw new Error('VIEW_NOT_FOUND');

    // `view.id`, NOT the `viewId` parameter — which is undefined on exactly the
    // deep-link path this method now supports, and would have reproduced the
    // same `id: undefined` failure one line further down.
    const config = await this.configService.getOrCreate(view.id);

    const groups = await this.prisma.group.findMany({
      where: { boardId },
      orderBy: { position: 'asc' },
      select: { id: true, name: true, color: true, position: true },
    });

    const sizeColumn = await this.prisma.boardColumn.findFirst({
      where: { boardId, name: 'Size', type: 'STATUS' },
      select: { id: true },
    });

    const projects = await this.prisma.project.findMany({
      where: { boardId },
      select: {
        id: true,
        name: true,
        status: true,
        groupId: true,
        order: true,
        ownerId: true,
        owner: true,
        startDate: true,
        endDate: true,
        durationCode: true,
        fieldValues: sizeColumn
          ? { where: { columnId: sizeColumn.id }, select: { columnId: true, value: true } }
          : false,
      },
    });

    const durations = config.sizeDurations as SizeDurations;

    return {
      config,
      groups,
      projects: projects.map((p) => {
        const fv = (p as { fieldValues?: Array<{ value: string }> }).fieldValues;
        const sizeLabel = fv && fv.length > 0 ? fv[0]!.value : null;
        const ownerStr = (p as { owner?: string }).owner ?? '';
        const ownerTrimmed = ownerStr.trim();
        return {
          id: p.id,
          name: p.name,
          status: String(p.status),
          groupId: p.groupId,
          order: p.order,
          // Parallel tracks key off the structured BoardOwner when set, else
          // fall back to the free-text owner so distinct owners run in parallel.
          assigneeId: p.ownerId ?? (ownerTrimmed.length > 0 ? ownerTrimmed : null),
          owner: ownerStr,
          sizeLabel,
          sizeWeeks: sizeWeeksFromLabel(sizeLabel, durations),
          startDate: p.startDate ? p.startDate.toISOString() : null,
          endDate: p.endDate ? p.endDate.toISOString() : null,
          durationCode: p.durationCode ?? null,
        };
      }),
    };
  }

  async setSchedule(
    boardId: string,
    projectId: string,
    input: { startDate?: string | null; endDate?: string | null; durationCode?: string | null },
  ): Promise<{ id: string; startDate: string | null; endDate: string | null; durationCode: string | null }> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, boardId },
      select: { id: true },
    });
    if (!project) throw new Error('PROJECT_NOT_FOUND');

    const data: { startDate?: Date | null; endDate?: Date | null; durationCode?: string | null } = {};
    if ('startDate' in input) data.startDate = input.startDate ? new Date(input.startDate) : null;
    if ('endDate' in input) data.endDate = input.endDate ? new Date(input.endDate) : null;
    if ('durationCode' in input) data.durationCode = input.durationCode ?? null;

    const updated = await this.prisma.project.update({
      where: { id: projectId },
      data,
      select: { id: true, startDate: true, endDate: true, durationCode: true },
    });
    return {
      id: updated.id,
      startDate: updated.startDate ? updated.startDate.toISOString() : null,
      endDate: updated.endDate ? updated.endDate.toISOString() : null,
      durationCode: updated.durationCode ?? null,
    };
  }
}

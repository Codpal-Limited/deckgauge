import type { PrismaClient } from '@deckgauge/db';
import { RoadmapService } from '../roadmap/roadmap.service.js';
import { ProjectService, type UpdateProjectInput } from '../projects/project.service.js';
import { ColumnService } from '../columns/column.service.js';
import { RoadmapMembershipService } from './roadmap-membership.service.js';
import { forbiddenBoardIds, type BoardAccessLog } from '../auth/board-access.js';

const BUILT_IN_FIELDS = new Set(['name', 'description', 'status', 'owner']);

export class RoadmapItemService {
  // These can be replaced in tests to inject mocks without rewriting constructors.
  /** @internal */
  _setSchedule: (
    boardId: string,
    projectId: string,
    input: { startDate?: string | null; endDate?: string | null; durationCode?: string | null },
  ) => Promise<{ id: string; startDate: string | null; endDate: string | null; durationCode: string | null }>;

  /** @internal */
  _projectUpdate: (id: string, input: UpdateProjectInput) => Promise<unknown>;

  /** @internal */
  _upsertFieldValues: (projectId: string, inputs: { columnId: string; value: string }[]) => Promise<unknown>;

  /** @internal */
  _reorder: (items: { id: string; order?: number; groupId?: string }[]) => Promise<unknown>;

  /** @internal */
  _reconcile: (roadmapId: string) => Promise<void>;

  constructor(private readonly prisma: PrismaClient) {
    const boardRoadmapSvc = new RoadmapService(prisma);
    const projectSvc = new ProjectService(prisma);
    const columnSvc = new ColumnService(prisma);
    const membershipSvc = new RoadmapMembershipService(prisma);

    this._setSchedule = boardRoadmapSvc.setSchedule.bind(boardRoadmapSvc);
    this._projectUpdate = (id, input) => projectSvc.update(id, input);
    this._upsertFieldValues = columnSvc.upsertFieldValues.bind(columnSvc);
    this._reorder = projectSvc.reorder.bind(projectSvc);
    this._reconcile = membershipSvc.reconcile.bind(membershipSvc);
  }

  /**
   * Verifies the project exists, its group belongs to the roadmap, and the
   * caller may edit the project's *board*. Materialises subscription-derived
   * groups first via reconcile().
   *
   * The board check is the point: these endpoints write to real board rows
   * (name, status, owner, schedule, custom fields), and RoadmapAccess is
   * granted independently of BoardAccess — a roadmap EDITOR who holds no role
   * on the board would otherwise edit its content through the roadmap.
   *
   * @throws Error('ROADMAP_ITEM_NOT_FOUND') if project is missing
   * @throws Error('ROADMAP_ITEM_FORBIDDEN') if project's group is not in the
   *   roadmap, or the caller lacks EDITOR on its board
   */
  private async assertItemInRoadmap(
    roadmapId: string,
    projectId: string,
    userId: string,
    log?: BoardAccessLog,
  ): Promise<{ boardId: string; groupId: string }> {
    await this._reconcile(roadmapId);

    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, groupId: true, boardId: true },
    });
    if (!project) throw new Error('ROADMAP_ITEM_NOT_FOUND');
    if (!project.boardId || !project.groupId) throw new Error('ROADMAP_ITEM_NOT_FOUND');

    const membership = await this.prisma.roadmapGroup.findUnique({
      where: { roadmapId_groupId: { roadmapId, groupId: project.groupId } },
    });
    if (!membership) throw new Error('ROADMAP_ITEM_FORBIDDEN');

    const forbidden = await forbiddenBoardIds(this.prisma, userId, [project.boardId], 'EDITOR', log);
    if (forbidden.length > 0) throw new Error('ROADMAP_ITEM_FORBIDDEN');

    return { boardId: project.boardId, groupId: project.groupId };
  }

  /**
   * Updates the roadmap schedule (startDate / endDate / durationCode) for an item.
   * Delegates the actual write to the board-level RoadmapService so logic stays DRY.
   */
  async setSchedule(
    roadmapId: string,
    projectId: string,
    patch: { startDate?: string | null; endDate?: string | null; durationCode?: string | null },
    userId: string,
    log?: BoardAccessLog,
  ): Promise<{ id: string; startDate: string | null; endDate: string | null; durationCode: string | null }> {
    const { boardId } = await this.assertItemInRoadmap(roadmapId, projectId, userId, log);
    return this._setSchedule(boardId, projectId, patch);
  }

  /**
   * Updates a single field on a roadmap item.
   * Built-in fields (name / description / status / owner) route to ProjectService.update.
   * Custom fields (column IDs) route to ColumnService.upsertFieldValues.
   */
  async updateField(
    roadmapId: string,
    projectId: string,
    field: string,
    value: string,
    userId: string,
    log?: BoardAccessLog,
  ): Promise<void> {
    await this.assertItemInRoadmap(roadmapId, projectId, userId, log);

    if (BUILT_IN_FIELDS.has(field)) {
      await this._projectUpdate(projectId, { [field]: value } as UpdateProjectInput);
    } else {
      await this._upsertFieldValues(projectId, [{ columnId: field, value }]);
    }
  }

  /**
   * Moves (reorders / changes group) a roadmap item.
   * When a target groupId is provided it must also be on the roadmap.
   */
  async move(
    roadmapId: string,
    projectId: string,
    patch: { groupId?: string; order?: number },
    userId: string,
    log?: BoardAccessLog,
  ): Promise<void> {
    await this.assertItemInRoadmap(roadmapId, projectId, userId, log);

    if (patch.groupId !== undefined) {
      const tgt = await this.prisma.roadmapGroup.findUnique({
        where: { roadmapId_groupId: { roadmapId, groupId: patch.groupId } },
      });
      if (!tgt) throw new Error('ROADMAP_ITEM_FORBIDDEN');
    }

    const item: { id: string; order?: number; groupId?: string } = { id: projectId };
    if (patch.groupId !== undefined) item.groupId = patch.groupId;
    if (patch.order !== undefined) item.order = patch.order;

    await this._reorder([item]);
  }
}

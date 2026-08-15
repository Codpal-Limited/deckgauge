import type { PrismaClient } from '@deckgauge/db';
import {
  type CreateRoadmapInput,
  type UpdateRoadmapInput,
  type RoadmapSummary,
  type RoadmapAccessRoleValue,
  type RoadmapDetail,
  type SystemColumnKey,
  type SizeDurations,
  sizeWeeksFromLabel,
} from '@deckgauge/shared';
import { RoadmapMembershipService } from './roadmap-membership.service.js';
import { RoadmapGanttConfigService } from './roadmap-gantt-config.service.js';
import { accessibleBoardIds, type BoardAccessLog } from '../auth/board-access.js';

export class RoadmapService {
  constructor(private readonly prisma: PrismaClient) {}

  async create(userId: string, input: CreateRoadmapInput): Promise<RoadmapSummary> {
    return this.prisma.$transaction(async (tx) => {
      const roadmap = await tx.roadmap.create({
        data: { name: input.name, description: input.description ?? null, createdBy: userId },
        select: { id: true, name: true },
      });
      await tx.roadmapAccess.create({
        data: { roadmapId: roadmap.id, userId, role: 'OWNER' },
      });
      await tx.roadmapView.create({
        data: { roadmapId: roadmap.id, type: 'GRID', name: 'Grid', position: 0 },
      });
      await tx.roadmapView.create({
        data: {
          roadmapId: roadmap.id,
          type: 'GANTT',
          name: 'Timeline',
          position: 1,
          ganttConfig: {
            create: { startDate: new Date(), sizeDurations: {}, visibleQuarters: 4 },
          },
        },
      });
      return roadmap;
    });
  }

  async listForUser(userId: string): Promise<RoadmapSummary[]> {
    const rows = await this.prisma.roadmap.findMany({
      where: { accessEntries: { some: { userId } } },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
    return rows;
  }

  async update(roadmapId: string, input: UpdateRoadmapInput): Promise<void> {
    await this.prisma.roadmap.update({
      where: { id: roadmapId },
      data: {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.description !== undefined && { description: input.description }),
        ...(input.hiddenSystemColumns !== undefined && {
          hiddenSystemColumns: input.hiddenSystemColumns,
        }),
      },
    });
  }

  async remove(roadmapId: string): Promise<void> {
    await this.prisma.roadmap.delete({ where: { id: roadmapId } });
  }

  async getRole(roadmapId: string, userId: string): Promise<RoadmapAccessRoleValue | null> {
    const a = await this.prisma.roadmapAccess.findUnique({
      where: { roadmapId_userId: { roadmapId, userId } },
      select: { role: true },
    });
    return a ? (a.role as RoadmapAccessRoleValue) : null;
  }

  async setAccess(roadmapId: string, userId: string, role: RoadmapAccessRoleValue): Promise<void> {
    await this.prisma.roadmapAccess.upsert({
      where: { roadmapId_userId: { roadmapId, userId } },
      create: { roadmapId, userId, role },
      update: { role },
    });
  }

  async listAccess(roadmapId: string) {
    return this.prisma.roadmapAccess.findMany({
      where: { roadmapId },
      include: { user: { select: { id: true, name: true, email: true, avatarUrl: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  async revokeAccess(roadmapId: string, userId: string): Promise<void> {
    const access = await this.prisma.roadmapAccess.findUnique({
      where: { roadmapId_userId: { roadmapId, userId } },
    });
    if (!access) return;
    if (access.role === 'OWNER') {
      const owners = await this.prisma.roadmapAccess.count({ where: { roadmapId, role: 'OWNER' } });
      if (owners <= 1) throw new Error('Cannot remove the last roadmap owner');
    }
    await this.prisma.roadmapAccess.delete({
      where: { roadmapId_userId: { roadmapId, userId } },
    });
  }

  /**
   * The roadmap with its groups and their project rows.
   *
   * `userId` is not decoration: RoadmapAccess is granted independently of
   * BoardAccess, so a roadmap VIEWER would otherwise read every subscribed
   * board's full project rows — name, status, owner, dates and every custom
   * field value — for boards they hold no role on at all. Each group's board
   * is re-checked for VIEWER on every read, which is also what makes access
   * revoked *after* the group was added take effect.
   *
   * Groups on boards the caller cannot see are omitted rather than 403ing the
   * whole roadmap: a cross-board roadmap is routinely shared wider than any one
   * of its boards, so showing the readable part is the useful, and still safe,
   * behaviour. Attaching a board remains gated on the *adder* holding VIEWER
   * (see RoadmapMembershipService).
   */
  async getDetail(
    roadmapId: string,
    role: RoadmapAccessRoleValue,
    userId: string,
    log?: BoardAccessLog,
  ): Promise<RoadmapDetail> {
    await new RoadmapMembershipService(this.prisma).reconcile(roadmapId);
    // Restores `readDetail`'s pre-split behaviour exactly: before the split,
    // this method's only path to the GANTT config was `ensure`, which
    // materializes a default row the first time a roadmap is read with none
    // yet. `readDetail` itself now reads via the non-writing `peek` (see its
    // doc comment), so that auto-create is preserved HERE instead, keeping
    // this method's observable behaviour — including its side effects,
    // not just its return value — identical to before this task. One extra
    // query; buys exact parity.
    await new RoadmapGanttConfigService(this.prisma).ensure(roadmapId);
    return this.readDetail(roadmapId, role, userId, log);
  }

  /**
   * Everything `getDetail` does EXCEPT `reconcile` and the GANTT-config
   * `ensure` — the fully read-only half of the assembly, split out so a
   * caller that must never write (the Advisor's page-state resolver) can
   * read a roadmap directly without mutating anything. `getDetail` calls
   * this immediately after reconciling and ensuring the GANTT config, so
   * its behaviour for existing callers is unchanged, side effects included.
   *
   * A caller that calls this directly instead of `getDetail` (the Advisor)
   * accepts two documented, deliberate trades against what the live page
   * shows:
   *  - subscribed boards' groups may be marginally stale — `reconcile` is
   *    what adds/removes groups as board subscriptions change, and this
   *    method never runs it;
   *  - the roadmap's GANTT config comes from `RoadmapGanttConfigService.peek`,
   *    which returns in-memory defaults instead of a persisted row when
   *    none exists yet, rather than creating one on a read.
   * Both are the correct trade for a caller that must never write, and this
   * method — unlike `getDetail` — never writes: no `create`, `update`,
   * `delete`, `upsert`, or `$transaction` anywhere in its call graph
   * (including `peek`, which only ever reads).
   *
   * `userId` is as load-bearing here as it is on `getDetail`, and for the same
   * reason: the per-group board re-check lives in THIS method, so it governs
   * both callers. Reading a roadmap without it would hand the caller project
   * rows from boards they hold no role on — the exact leak the re-check closes
   * — and a read-only caller leaks just as effectively as a writing one. It is
   * the authenticated caller's id, never a value from the model or the request
   * body.
   */
  async readDetail(
    roadmapId: string,
    role: RoadmapAccessRoleValue,
    userId: string,
    log?: BoardAccessLog,
  ): Promise<RoadmapDetail> {
    const roadmap = await this.prisma.roadmap.findUnique({
      where: { id: roadmapId },
      select: { id: true, name: true, description: true, hiddenSystemColumns: true },
    });
    if (!roadmap) throw new Error('ROADMAP_NOT_FOUND');

    const allRows = await this.prisma.roadmapGroup.findMany({
      where: { roadmapId },
      orderBy: { position: 'asc' },
      select: {
        groupId: true,
        position: true,
        group: {
          select: {
            id: true,
            name: true,
            color: true,
            boardId: true,
            board: { select: { id: true, name: true } },
            projects: {
              orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
              select: {
                id: true, name: true, status: true, statusId: true, ownerId: true,
                owner: true, order: true, groupId: true, boardId: true,
                startDate: true, endDate: true, durationCode: true,
                fieldValues: { select: { columnId: true, value: true } },
              },
            },
          },
        },
      },
    });

    // Drop every group whose board the caller cannot view. A group with no
    // board at all is dropped too — unresolvable is never "no check needed".
    const visibleBoardIds = await accessibleBoardIds(
      this.prisma,
      userId,
      allRows.map((r) => r.group.boardId).filter(Boolean) as string[],
      'VIEWER',
      log,
    );
    const rows = allRows.filter((r) => r.group.boardId && visibleBoardIds.has(r.group.boardId));

    // Resolve the per-board "Size" column so we can read each item's size label.
    const boardIds = Array.from(
      new Set(rows.map((r) => r.group.boardId).filter(Boolean) as string[]),
    );
    const sizeCols = boardIds.length
      ? await this.prisma.boardColumn.findMany({
          where: { boardId: { in: boardIds }, name: 'Size', type: 'STATUS' },
          select: { id: true, boardId: true },
        })
      : [];
    const sizeColByBoard = new Map(sizeCols.map((c) => [c.boardId, c.id]));

    // Size durations are roadmap-wide: read from the GANTT view's config (defaults if absent).
    const ganttView = await this.prisma.roadmapView.findFirst({
      where: { roadmapId, type: 'GANTT' },
      select: { ganttConfig: { select: { sizeDurations: true } } },
    });
    const durations = (ganttView?.ganttConfig?.sizeDurations ?? {}) as SizeDurations;

    const groups = rows.map((r) => {
      const g = r.group;
      const sizeColId = g.boardId ? sizeColByBoard.get(g.boardId) : undefined;
      return {
        groupId: g.id,
        name: g.name,
        color: g.color,
        position: r.position,
        boardId: g.boardId ?? '',
        boardName: g.board?.name ?? '(unknown board)',
        items: g.projects.map((p) => {
          const sizeLabel = sizeColId
            ? (p.fieldValues.find((fv) => fv.columnId === sizeColId)?.value ?? null)
            : null;
          return {
            id: p.id, name: p.name, boardId: p.boardId ?? '', groupId: p.groupId ?? '',
            status: String(p.status), statusId: p.statusId, ownerId: p.ownerId,
            owner: p.owner, order: p.order,
            sizeLabel, sizeWeeks: sizeWeeksFromLabel(sizeLabel, durations),
            startDate: p.startDate ? (p.startDate as Date).toISOString() : null,
            endDate: p.endDate ? (p.endDate as Date).toISOString() : null,
            durationCode: p.durationCode ?? null,
          };
        }),
      };
    });

    // `peek`, not `ensure`: this method must never write (see the doc
    // comment above). `peek` returns the same shape `ensure` would persist
    // when no GANTT config exists yet, just without creating the row.
    const ganttConfig = await new RoadmapGanttConfigService(this.prisma).peek(roadmapId);

    return {
      id: roadmap.id,
      name: roadmap.name,
      description: roadmap.description,
      hiddenSystemColumns: (roadmap.hiddenSystemColumns as SystemColumnKey[]) ?? [],
      role,
      groups,
      ganttConfig,
    };
  }
}

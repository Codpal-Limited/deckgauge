import type { PrismaClient } from '@deckgauge/db';
import { reconcileRoadmapGroups } from '@deckgauge/shared';
import {
  BoardAccessDeniedError,
  forbiddenBoardIds,
  type BoardAccessLog,
} from '../auth/board-access.js';
import type { CallerMembership } from '../auth/board-access.js';

export class RoadmapMembershipService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Refuse unless the caller holds VIEWER on every board named. Creating a
   * roadmap grants the creator RoadmapAccess.OWNER, so `roadmap(EDITOR)` on
   * these routes is satisfied by anyone who just made one — it says nothing
   * about the boards being attached. Without this, attaching a victim board
   * hands the attacker its full project rows back through `GET /roadmaps/:id`.
   *
   * A group id that resolves to no board (missing row, board-less group) is
   * refused too rather than skipped: unresolvable never means "no check
   * needed", the same rule the policy evaluator follows.
   */
  private async assertBoardsVisible(
    boardIds: ReadonlyArray<string | null | undefined>,
    userId: string,
    log?: BoardAccessLog,
    membership: CallerMembership = null,
  ): Promise<void> {
    if (boardIds.some((b) => !b)) throw new BoardAccessDeniedError(['<unresolved>']);
    const forbidden = await forbiddenBoardIds(this.prisma, userId, boardIds as string[], 'VIEWER', log, membership);
    if (forbidden.length > 0) throw new BoardAccessDeniedError(forbidden);
  }

  async addGroups(
    roadmapId: string,
    groupIds: string[],
    userId: string,
    log?: BoardAccessLog,
  ): Promise<void> {
    const groups = await this.prisma.group.findMany({
      where: { id: { in: groupIds } },
      select: { id: true, boardId: true },
    });
    // A missing group row yields no entry here, so the length check below is
    // what catches ids that don't exist at all.
    if (groups.length !== new Set(groupIds).size) throw new BoardAccessDeniedError(['<unresolved>']);
    await this.assertBoardsVisible(groups.map((g) => g.boardId), userId, log);

    const max = await this.prisma.roadmapGroup.aggregate({
      where: { roadmapId },
      _max: { position: true },
    });
    let pos = (max._max.position ?? -1) + 1;
    await this.prisma.roadmapGroup.createMany({
      data: groupIds.map((groupId) => ({ roadmapId, groupId, position: pos++, source: 'MANUAL' as const })),
      skipDuplicates: true,
    });
  }

  async removeGroup(roadmapId: string, groupId: string): Promise<void> {
    await this.prisma.roadmapGroup.deleteMany({ where: { roadmapId, groupId } });
  }

  async addSubscription(
    roadmapId: string,
    boardId: string,
    userId: string,
    log?: BoardAccessLog,
  ): Promise<void> {
    await this.assertBoardsVisible([boardId], userId, log);
    await this.prisma.roadmapBoardSubscription.upsert({
      where: { roadmapId_boardId: { roadmapId, boardId } },
      create: { roadmapId, boardId },
      update: {},
    });
    await this.reconcile(roadmapId);
  }

  async removeSubscription(roadmapId: string, boardId: string): Promise<void> {
    await this.prisma.roadmapBoardSubscription.deleteMany({ where: { roadmapId, boardId } });
    await this.reconcile(roadmapId);
  }

  async reorder(roadmapId: string, orderedGroupIds: string[]): Promise<void> {
    const ops = orderedGroupIds.map((groupId, i) =>
      this.prisma.roadmapGroup.update({
        where: { roadmapId_groupId: { roadmapId, groupId } },
        data: { position: i },
      }),
    );
    await this.prisma.$transaction(ops);
  }

  async reconcile(roadmapId: string): Promise<void> {
    const [existing, subs] = await Promise.all([
      this.prisma.roadmapGroup.findMany({
        where: { roadmapId },
        select: { groupId: true, position: true, source: true },
      }),
      this.prisma.roadmapBoardSubscription.findMany({
        where: { roadmapId },
        select: { boardId: true },
      }),
    ]);
    const subscribedBoardIds = subs.map((s) => s.boardId);
    const subscribedGroups =
      subscribedBoardIds.length > 0
        ? await this.prisma.group.findMany({
            where: { boardId: { in: subscribedBoardIds } },
            orderBy: [{ boardId: 'asc' }, { position: 'asc' }],
            select: { id: true, boardId: true },
          })
        : [];

    const referencedIds = Array.from(
      new Set([...existing.map((e) => e.groupId), ...subscribedGroups.map((g) => g.id)]),
    );
    const liveRows =
      referencedIds.length > 0
        ? await this.prisma.group.findMany({
            where: { id: { in: referencedIds } },
            select: { id: true },
          })
        : [];

    const result = reconcileRoadmapGroups({
      existing: existing.map((e) => ({
        groupId: e.groupId,
        position: e.position,
        source: e.source as 'MANUAL' | 'BOARD_SUB',
      })),
      subscribedBoardIds,
      subscribedGroups: subscribedGroups.map((g) => ({ groupId: g.id, boardId: g.boardId })),
      liveGroupIds: new Set(liveRows.map((r) => r.id)),
    });

    if (result.toCreate.length > 0) {
      await this.prisma.roadmapGroup.createMany({
        data: result.toCreate.map((c) => ({ roadmapId, ...c })),
        skipDuplicates: true,
      });
    }
    if (result.toDelete.length > 0) {
      await this.prisma.roadmapGroup.deleteMany({
        where: { roadmapId, groupId: { in: result.toDelete } },
      });
    }
  }
}

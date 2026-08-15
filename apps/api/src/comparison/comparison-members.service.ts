import type { PrismaClient } from '@deckgauge/db';
import {
  BoardAccessDeniedError,
  accessibleBoardIds,
  forbiddenBoardIds,
  type BoardAccessLog,
} from '../auth/board-access.js';

export interface ComparisonMemberEntry {
  boardId: string;
  boardName: string;
  position: number;
}

// Persists the board set for a Comparison via the comparison_members join table
// (mirrors RoadmapBoardSubscription). The comparison widgets fan the existing
// single-board builders out across this set — see WidgetDataService.
export class ComparisonMembersService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * The comparison's member boards, **restricted to the ones `userId` can
   * still see**. Being the comparison's creator is not by itself permission to
   * read a board: membership is stored, so a board the creator has since lost
   * access to would otherwise keep leaking its name here (and its analytics
   * through the comparison widgets) forever. Re-checking on every read is what
   * makes revocation take effect.
   *
   * Inaccessible members are omitted rather than 403ing the whole request: the
   * picker reads this list to repopulate itself, so filtering leaves the
   * creator able to save a corrected set, where a hard denial would strand the
   * comparison unreadable and un-editable.
   */
  async list(comparisonId: string, userId: string, log?: BoardAccessLog): Promise<ComparisonMemberEntry[]> {
    const members = await this.prisma.comparisonMember.findMany({
      where: { comparisonId },
      orderBy: { position: 'asc' },
      select: { boardId: true, position: true, board: { select: { name: true } } },
    });
    const visible = await accessibleBoardIds(
      this.prisma,
      userId,
      members.map((m) => m.boardId),
      'VIEWER',
      log,
    );
    return members
      .filter((m) => visible.has(m.boardId))
      .map((m) => ({
        boardId: m.boardId,
        boardName: m.board?.name ?? m.boardId,
        position: m.position,
      }));
  }

  // Replaces the full member set in one transaction: the picker sends the whole
  // ordered board list, so a clear-and-recreate keeps positions dense and the
  // stored order matching what the user sees. Duplicate ids collapse to the
  // first occurrence.
  //
  // Every incoming board id is checked for VIEWER access first. Creating a
  // comparison is open to any signed-in user and its widgets read the member
  // set, so without this an attacker could name any board id here and read that
  // board's analytics back through `GET /boards/:comparisonId/widgets/…/data`
  // — the comparisonCreator arm correctly allows them, because they really are
  // the creator. The whole request is refused (never partially applied) so the
  // attempt is visible rather than silently trimmed.
  async replace(
    comparisonId: string,
    boardIds: string[],
    userId: string,
    log?: BoardAccessLog,
  ): Promise<void> {
    const unique = boardIds.filter((id, i) => boardIds.indexOf(id) === i);
    const forbidden = await forbiddenBoardIds(this.prisma, userId, unique, 'VIEWER', log);
    if (forbidden.length > 0) throw new BoardAccessDeniedError(forbidden);

    await this.prisma.$transaction(async (tx) => {
      await tx.comparisonMember.deleteMany({ where: { comparisonId } });
      for (let position = 0; position < unique.length; position++) {
        const boardId = unique[position]!;
        await tx.comparisonMember.create({
          data: { comparisonId, boardId, position },
        });
      }
    });
  }
}

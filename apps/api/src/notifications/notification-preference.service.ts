import type { PrismaClient } from '@deckgauge/db';
import {
  DEFAULT_NOTIFICATION_MODES,
  NotificationKindSchema,
  type BoardNotificationLevel,
  type NotificationKindValue,
  type NotificationMode,
  type NotificationPreference,
} from '@deckgauge/shared';

/** Absent means ALL — the same sparse rule the per-kind table uses. */
const DEFAULT_BOARD_LEVEL: BoardNotificationLevel = 'ALL';

export class NotificationPreferenceService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Every kind, defaults filled in. The settings screen therefore renders from
   * one response and never needs its own copy of the default table — which is
   * how the two would drift.
   */
  async list(userId: string, organizationId: string): Promise<NotificationPreference[]> {
    const stored = await this.prisma.notificationPreference.findMany({
      where: { userId, organizationId },
      select: { kind: true, mode: true },
    });
    const modeOf = new Map(
      stored.map((p) => [p.kind as NotificationKindValue, p.mode as NotificationMode]),
    );

    return NotificationKindSchema.options.map((kind) => ({
      kind,
      mode: modeOf.get(kind) ?? DEFAULT_NOTIFICATION_MODES[kind],
    }));
  }

  /**
   * Sparse writes: a choice equal to the default DELETES the row. Storing it
   * would freeze today's default into the user's account, so a later change to
   * the default would silently skip everyone who once opened this screen.
   */
  async update(
    userId: string,
    organizationId: string,
    preferences: readonly NotificationPreference[],
  ): Promise<NotificationPreference[]> {
    for (const { kind, mode } of preferences) {
      if (mode === DEFAULT_NOTIFICATION_MODES[kind]) {
        await this.prisma.notificationPreference.deleteMany({
          where: { userId, organizationId, kind },
        });
        continue;
      }
      await this.prisma.notificationPreference.upsert({
        where: { userId_organizationId_kind: { userId, organizationId, kind } },
        create: { userId, organizationId, kind, mode },
        update: { mode },
      });
    }
    return this.list(userId, organizationId);
  }

  /**
   * Whether the board is one this caller's organization actually owns.
   *
   * These routes carry no board policy — a notification level is a personal
   * setting, so a VIEWER may set one on any board they can see. But the tenant
   * boundary still holds: without this, naming another tenant's board id would
   * write a row that is pure dead weight, and the FK would happily accept it.
   */
  async boardIsInOrganization(boardId: string, organizationId: string): Promise<boolean> {
    const board = await this.prisma.board.findFirst({
      where: { id: boardId, organizationId },
      select: { id: true },
    });
    return board !== null;
  }

  async boardLevel(userId: string, boardId: string): Promise<BoardNotificationLevel> {
    const row = await this.prisma.boardNotificationSetting.findUnique({
      where: { userId_boardId: { userId, boardId } },
      select: { level: true },
    });
    return (row?.level as BoardNotificationLevel | undefined) ?? DEFAULT_BOARD_LEVEL;
  }

  async setBoardLevel(
    userId: string,
    boardId: string,
    level: BoardNotificationLevel,
  ): Promise<BoardNotificationLevel> {
    if (level === DEFAULT_BOARD_LEVEL) {
      await this.prisma.boardNotificationSetting.deleteMany({ where: { userId, boardId } });
      return level;
    }
    await this.prisma.boardNotificationSetting.upsert({
      where: { userId_boardId: { userId, boardId } },
      create: { userId, boardId, level },
      update: { level },
    });
    return level;
  }
}

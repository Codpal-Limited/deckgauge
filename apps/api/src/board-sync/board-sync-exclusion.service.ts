// Read + undo for `board_sync_exclusions`.
//
// Deleting a synced row records an exclusion (see `ProjectService.delete`), and
// every promote service filters those keys out of all future syncs. That is
// deliberate — a row the user deleted must not silently reappear — but until
// now there was no way to list or undo one, so a bulk delete blacklisted work
// items permanently with no UI path back. This service backs the "Excluded
// items" block on the board Sources page.

import type { PrismaClient } from '@deckgauge/db';
import type {
  BoardSyncExclusion,
  RestoreBoardSyncExclusionsResponse,
  SyncExclusionSource,
} from '@deckgauge/shared';

/**
 * Compares provider ids the way a human reads them: the trailing number
 * numerically, everything before it as text. A plain string sort puts SOE-10
 * before SOE-9, which makes a 60-key list very hard to scan.
 */
function compareExternalId(a: string, b: string): number {
  const split = (s: string): [string, number | null] => {
    const m = /^(.*?)(\d+)$/.exec(s);
    if (!m) return [s, null];
    return [m[1] as string, Number(m[2])];
  };
  const [aPrefix, aNum] = split(a);
  const [bPrefix, bNum] = split(b);
  if (aPrefix !== bPrefix) return aPrefix.localeCompare(bPrefix);
  if (aNum === null || bNum === null) return a.localeCompare(b);
  return aNum - bNum;
}

export class BoardSyncExclusionService {
  constructor(private readonly prisma: PrismaClient) {}

  async list(boardId: string): Promise<BoardSyncExclusion[]> {
    const rows = await this.prisma.boardSyncExclusion.findMany({
      where: { boardId },
      select: {
        id: true,
        source: true,
        externalId: true,
        excludedAt: true,
        excludedBy: true,
      },
    });

    return rows
      .map((r) => ({
        id: r.id,
        source: r.source as SyncExclusionSource,
        externalId: r.externalId,
        excludedAt: r.excludedAt.toISOString(),
        excludedBy: r.excludedBy,
      }))
      .sort(
        (a, b) =>
          a.source.localeCompare(b.source) ||
          compareExternalId(a.externalId, b.externalId),
      );
  }

  /**
   * Drops the named exclusions so the next sync re-creates their rows.
   *
   * Scoped by `boardId` as well as by id: route auth already proves the caller
   * may edit this board, but an id from another board must not be actionable
   * just because the caller knows it. Ids that do not match are silently no-ops
   * — a concurrent restore of the same list is not an error worth surfacing.
   */
  async restore(
    boardId: string,
    ids: string[],
  ): Promise<RestoreBoardSyncExclusionsResponse> {
    if (ids.length === 0) return { restored: 0 };
    const result = await this.prisma.boardSyncExclusion.deleteMany({
      where: { boardId, id: { in: ids } },
    });
    return { restored: result.count };
  }
}

// Read + undo for `board_sync_exclusions`.
//
// Deleting a synced row records an exclusion (see `ProjectService.delete`), and
// every promote service filters those keys out of all future syncs. That is
// deliberate — a row the user deleted must not silently reappear — but until
// now there was no way to list or undo one, so a bulk delete blacklisted work
// items permanently with no UI path back. This service backs the "Excluded
// items" block on the board Sources page.
//
// `list` is paginated and source-scoped rather than a bare `findMany`: one
// real board wrote 20,607 exclusion rows in a single bulk action, and neither
// the API nor the browser can afford to move all of them on every page load.
// `restore` (by id) and `restoreAll` (by board+source, no id list) are two
// distinct ways to undo — see each method's doc comment for why they are not
// the same shape.

import type { PrismaClient } from '@deckgauge/db';
import type {
  BoardSyncExclusion,
  BoardSyncExclusionPage,
  RestoreBoardSyncExclusionsResponse,
  SyncExclusionSource,
} from '@deckgauge/shared';

/**
 * Hard ceiling on how many rows a single `list` call can return, independent
 * of the caller's requested `limit`. One real board wrote 20,607 exclusion
 * rows in a bulk action — without this an "unbounded" limit could still ship
 * every one of them to the browser on every Sources page load.
 */
const MAX_PAGE = 200;

export interface ListExclusionsOptions {
  source?: SyncExclusionSource;
  limit: number;
  offset: number;
}

/**
 * Compares provider ids the way a human reads them: the trailing number
 * numerically, everything before it as text. A plain string sort puts PROJ-10
 * before PROJ-9, which makes a page of keys very hard to scan.
 *
 * This now sorts only WITHIN the page `list` returns — the database orders by
 * `source`/`externalId` (a plain text sort) to select which rows land on which
 * page, and this comparator re-sorts just that page for readability. It is not
 * a global ordering: two ids differing only in their numeric suffix can land on
 * different pages under the text sort (e.g. "PROJ-9" and "PROJ-10" are adjacent
 * to a human but not to `ORDER BY externalId`), and this function cannot undo
 * that once the split has already happened at the database.
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

  /**
   * Paginated read of a board's exclusions, optionally scoped to one source.
   * `limit` is capped at {@link MAX_PAGE} regardless of what the caller asks
   * for — see that constant's doc comment. `source` reaches the `where`
   * clause directly rather than being filtered after the fact: the caller
   * (the Sources page, one provider at a time) must not receive rows for
   * providers it isn't rendering, or a board with 20k ADO exclusions would
   * still ship all of them to render a Jira source's page.
   */
  async list(
    boardId: string,
    { source, limit, offset }: ListExclusionsOptions,
  ): Promise<BoardSyncExclusionPage> {
    const where = source ? { boardId, source } : { boardId };
    const take = Math.min(Math.max(limit, 0), MAX_PAGE);

    const [rows, total] = await Promise.all([
      this.prisma.boardSyncExclusion.findMany({
        where,
        select: {
          id: true,
          source: true,
          externalId: true,
          excludedAt: true,
          excludedBy: true,
        },
        // Plain text order at the database — see `compareExternalId`'s doc
        // comment for why the numeric-suffix sort cannot be global.
        orderBy: [{ source: 'asc' }, { externalId: 'asc' }],
        take,
        skip: offset,
      }),
      this.prisma.boardSyncExclusion.count({ where }),
    ]);

    const mapped: BoardSyncExclusion[] = rows.map((r) => ({
      id: r.id,
      source: r.source as SyncExclusionSource,
      externalId: r.externalId,
      excludedAt: r.excludedAt.toISOString(),
      excludedBy: r.excludedBy,
    }));

    mapped.sort(
      (a, b) =>
        a.source.localeCompare(b.source) || compareExternalId(a.externalId, b.externalId),
    );

    return { rows: mapped, total };
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

  /**
   * Restores every exclusion for one board+source — "restore all N" on the
   * Sources page. Deliberately takes no id list: a board can carry tens of
   * thousands of exclusions, and requiring the browser to hold and repost
   * every id would defeat the pagination `list` exists for, and risks the
   * Postgres 65,535 bind-parameter ceiling (`sync-exclusion.ts`'s
   * `CHUNK_SIZE` works around the same limit on the write side). Scoped by
   * `boardId` for the same tenancy reason as {@link restore}: route auth
   * proves the caller may edit THIS board, and `source` alone must not be
   * enough to act on another board's rows.
   */
  async restoreAll(
    boardId: string,
    source: SyncExclusionSource,
  ): Promise<RestoreBoardSyncExclusionsResponse> {
    const result = await this.prisma.boardSyncExclusion.deleteMany({
      where: { boardId, source },
    });
    return { restored: result.count };
  }
}

import type { PrismaClient } from '@deckgauge/db';
import { forbiddenBoardIds, type BoardAccessLog } from '../auth/board-access.js';
import type { CallerMembership } from '../auth/board-access.js';

export type SyncKind = 'jira' | 'github' | 'ado' | 'gitlab';

/**
 * Every `Board*Source` row cascade-deletes with its sync (see the `onDelete:
 * Cascade` relations in schema.prisma), so deleting a sync silently detaches
 * the integration from every board wired to it. These reads name those boards.
 */
const BOARDS_USING: Record<
  SyncKind,
  (prisma: PrismaClient, syncId: string) => Promise<Array<{ boardId: string }>>
> = {
  jira: (prisma, id) =>
    prisma.boardJiraSource.findMany({ where: { jiraProjectSyncId: id }, select: { boardId: true } }),
  github: (prisma, id) =>
    prisma.boardGitHubSource.findMany({ where: { gitHubRepoSyncId: id }, select: { boardId: true } }),
  ado: (prisma, id) =>
    prisma.boardAdoSource.findMany({
      where: { azureDevOpsProjectSyncId: id },
      select: { boardId: true },
    }),
  gitlab: (prisma, id) =>
    prisma.boardGitLabSource.findMany({
      where: { gitlabProjectSyncId: id },
      select: { boardId: true },
    }),
};

export interface SyncDetachDenial {
  boardIds: string[];
  message: string;
}

/**
 * Guards `DELETE /project-syncs/{kind}/:id` (and the duplicate
 * `DELETE /gitlab/project-syncs/:id`).
 *
 * A sync row carries no boardId of its own, which is why these routes were
 * only `authenticated` — but deleting one cascade-deletes the `Board*Source`
 * row of every board using it, so any signed-in user with no board role at all
 * could detach another board's integration. The gate is therefore **EDITOR on
 * every affected board**, not connection ownership: the harm is to those
 * boards' configuration, and the sync's parent connection may still be
 * unclaimed (created_by_id NULL), which grants everyone — so an ownership
 * check would not actually close this.
 *
 * A sync attached to no board is left open to any signed-in user: nothing
 * cascades, and orphan rows must stay cleanable.
 *
 * `singleUser` mirrors the flag threaded into `buildPolicyPlugin` (see
 * server.ts) rather than this module reading `DECKGAUGE_SINGLE_USER` itself —
 * one source of truth for "is auth off", passed down explicitly. When true,
 * this bypasses entirely, before `userId` is even inspected: single-user mode
 * leaves `request.user` unset (see keycloak-auth.plugin.ts), so requiring a
 * userId here would make every board-attached sync undeletable in the one
 * mode `evaluatePolicy` already allows outright.
 *
 * Returns `null` when the delete may proceed. Fails closed on a lookup error.
 */
export async function denySyncDetach(
  prisma: PrismaClient,
  kind: SyncKind,
  syncId: string,
  userId: string | undefined,
  singleUser: boolean,
  log?: BoardAccessLog,
  membership: CallerMembership = null,
): Promise<SyncDetachDenial | null> {
  if (singleUser) return null;
  if (!userId) return { boardIds: [], message: 'Forbidden' };

  let rows: Array<{ boardId: string }>;
  try {
    rows = await BOARDS_USING[kind](prisma, syncId);
  } catch (err) {
    log?.error(err, `sync-detach-guard: failed to resolve boards for ${kind} sync "${syncId}" — denying`);
    return { boardIds: [], message: 'Forbidden' };
  }

  const boardIds = rows.map((r) => r.boardId);
  if (boardIds.length === 0) return null;

  const forbidden = await forbiddenBoardIds(prisma, userId, boardIds, 'EDITOR', log, membership);
  if (forbidden.length === 0) return null;

  return {
    boardIds: forbidden,
    message:
      `Forbidden: deleting this sync would detach it from board(s) ${forbidden.join(', ')}, ` +
      'which you cannot edit.',
  };
}

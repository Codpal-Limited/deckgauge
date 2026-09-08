import { selectDefaultBoard } from './select-default-board';
import { isCredentialRefused } from './credential-refused';

/**
 * What `/` should do with the outcome of its `GET /boards` call.
 *
 * `unauthenticated` exists because the previous code had nowhere to put it:
 * `ensureDefaultBoard` returned `null` for "this organization has no boards"
 * AND for "the API refused our credential", and the page's no-boards branch
 * then rendered a dead session as a plausible empty board — empty sidebar,
 * "No groups yet", "Not synced yet", `boardId=""`.
 */
export type DefaultBoardOutcome =
  | { status: 'ok'; boardId: string }
  | { status: 'none' }
  | { status: 'unauthenticated' };

/**
 * @param response Just the two fields we branch on, so callers can pass a real
 *   `Response` and tests need not construct one.
 * @param boards Parsed body, or null when the request did not succeed.
 */
export function resolveDefaultBoard(
  response: { ok: boolean; status: number },
  boards: Array<{ id: string }> | null,
  lastBoardCookieValue: string | undefined,
): DefaultBoardOutcome {
  // Shared with the board's own fetches via `isCredentialRefused`, so the two
  // entry points into this page cannot disagree about what a dead session is.
  if (isCredentialRefused(response.status)) return { status: 'unauthenticated' };
  if (!response.ok || boards === null) return { status: 'none' };

  const boardId = selectDefaultBoard(boards, lastBoardCookieValue);
  return boardId ? { status: 'ok', boardId } : { status: 'none' };
}

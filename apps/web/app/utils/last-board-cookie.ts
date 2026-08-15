export const LAST_BOARD_COOKIE = 'vpc_last_board';

// 1 year in seconds — matches the spec's lifetime for "last viewed board"
export const LAST_BOARD_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/**
 * Client-side cookie write. Used from "use client" components.
 * The cookie carries no auth, so a non-HttpOnly client write is fine.
 */
export function setLastBoardCookie(boardId: string): void {
  if (typeof document === 'undefined') return;
  document.cookie = `${LAST_BOARD_COOKIE}=${encodeURIComponent(boardId)}; Path=/; Max-Age=${LAST_BOARD_COOKIE_MAX_AGE}; SameSite=Lax`;
}

/**
 * Client-side read of the same cookie the root layout reads server-side.
 *
 * Needed by components above the page tree (the advisor, mounted in the root
 * layout) that must know which board is on screen at `/`, where the board id
 * is often implied by this cookie rather than present in the URL.
 */
export function readLastBoardCookie(): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie
    .split('; ')
    .find((entry) => entry.startsWith(`${LAST_BOARD_COOKIE}=`));
  if (!match) return null;
  const raw = match.slice(LAST_BOARD_COOKIE.length + 1);
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    // A cookie value we did not write (or a truncated one) is not a board id.
    return null;
  }
}

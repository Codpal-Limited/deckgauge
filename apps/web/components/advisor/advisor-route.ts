/**
 * Which board, if any, the current route is showing.
 *
 * The advisor is mounted once in the root layout, above every page, so it has
 * to work this out for itself. Two things depend on the answer: the panel and
 * dock must not overlay pages that aren't a board (the panel is
 * `fixed inset-y-0 right-0 z-50`), and navigating between boards has to rebind
 * the conversation — otherwise the panel keeps saying "reading b1" and keeps
 * answering about board A while the user is looking at board B.
 *
 * The board's canonical URL is `/?boardId=<id>` — a QUERY parameter, not a
 * path segment; `/boards/<id>` has no index page. Bare `/` is a board page
 * too: `app/page.tsx` falls back to the last-viewed board cookie (and then to
 * a default board) when the parameter is absent, and this mirrors exactly that
 * order so the advisor binds to the board actually on screen. Every other
 * route (settings, sources, org, timesheet, roadmap, comparison, the
 * per-board insight pages) is not a board view and yields `null`.
 */
export function resolveAdvisorBoardId(
  pathname: string | null,
  boardIdParam: string | null,
  lastBoardId: string | null,
): string | null {
  if (pathname !== '/') return null;
  return boardIdParam || lastBoardId || null;
}

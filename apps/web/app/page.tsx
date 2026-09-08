import { Suspense } from "react";
import type { Group, BoardColumn, BoardOwner, BoardStatus } from "@deckgauge/shared";
import { canEditEntity } from "@deckgauge/shared";
import type { JiraSourceLinks } from "@deckgauge/shared";
import { BoardView } from "./components/BoardView";
import BoardPageContent from "./components/BoardPageContent";
import { authFetch } from "./actions/api";
import { fetchMyRole, fetchAccess } from "./actions/access";
import { getBootstrapState } from "./actions/organization";
import { isOrganizationAdmin } from "./lib/org-role";
import { boardsListTag, boardTag, commentsTag } from "./utils/cache-tags";
import { bucketProjectsIntoGroups } from "./utils/bucket-projects";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { resolveDefaultBoard } from "./utils/resolve-default-board";
import type { DefaultBoardOutcome } from "./utils/resolve-default-board";
import { isCredentialRefused } from "./utils/credential-refused";
import { MissingSessionError } from "./lib/api-server";
import { LAST_BOARD_COOKIE } from "./utils/last-board-cookie";
import { SESSION_EXPIRED_REDIRECT } from "./utils/session-expired-redirect";

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams?: Promise<Record<string, string | string[]>>;
}

// SSR fetches only the FIRST page of a board's projects (plus the total count).
// The remaining rows stream in client-side via the board's progressive loader
// (BoardPageContent), so initial paint and board-switch stay bounded instead of
// shipping every row through the RSC payload. Small boards fit in one page, so
// the client loads nothing further.
const INITIAL_PAGE_SIZE = 200;

async function fetchGroups(
  boardId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ groups: (Group & { projects: any[] })[]; total: number }> {
  try {
    const [groupsRes, firstPageRes] = await Promise.all([
      authFetch(`/boards/${boardId}/groups`, { tags: [boardTag(boardId)] }),
      authFetch(
        `/projects?boardId=${boardId}&page=1&pageSize=${INITIAL_PAGE_SIZE}`,
        { tags: [boardTag(boardId)] },
      ),
    ]);

    if (!groupsRes.ok) return { groups: [], total: 0 };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawGroups = (await groupsRes.json()) as (Group & { projects?: any[] })[];
    const groups = rawGroups.map((g) => ({ ...g, projects: g.projects ?? [] }));

    const firstPage = firstPageRes.ok
      ? await firstPageRes.json()
      : { items: [], total: 0 };
    const items = Array.isArray(firstPage?.items) ? firstPage.items : [];
    const total = typeof firstPage?.total === "number" ? firstPage.total : 0;

    return { groups: bucketProjectsIntoGroups(groups, items), total };
  } catch {
    return { groups: [], total: 0 };
  }
}

async function fetchColumns(boardId: string): Promise<BoardColumn[]> {
  try {
    const res = await authFetch(`/boards/${boardId}/columns`, {
      tags: [boardTag(boardId)],
    });
    if (!res.ok) return [];
    return res.json() as Promise<BoardColumn[]>;
  } catch {
    return [];
  }
}

// Returns an OUTCOME for the same reason `ensureDefaultBoard` does, but for the
// OTHER way this page is reached. `?boardId=` short-circuits the boards-list
// fetch entirely — and that is the URL the app itself navigates to
// (`BoardSidebar` pushes `/?boardId=<id>` on every board click, and
// `LastLocationTracker` restores the same shape), so without this a dead session
// on any board the user actually opened still rendered the empty board.
type BoardOutcome =
  | { status: "ok"; board: unknown }
  | { status: "none" }
  | { status: "unauthenticated" };

async function fetchBoard(boardId: string): Promise<BoardOutcome> {
  try {
    const res = await authFetch(`/boards/${boardId}`, {
      tags: [boardTag(boardId)],
    });
    if (isCredentialRefused(res.status)) return { status: "unauthenticated" };
    if (!res.ok) return { status: "none" };
    return { status: "ok", board: await res.json() };
  } catch (err) {
    // "No session at all" is a refused credential, not a transport failure —
    // the last place this page conflated the two.
    if (err instanceof MissingSessionError) return { status: "unauthenticated" };
    return { status: "none" };
  }
}

// Keyed by the row's own `jiraProjectKey`, scoped to this board — a board can attach
// Jira sources from more than one site. Previously this took the first row of the
// global `/jira/instances` list, so every board's Jira links pointed at whichever
// instance was listed first, regardless of where the board actually synced from.
// `no-store` for the same reason as the ADO map: board-source attach/detach
// revalidates no cache tag, so a tagged entry here would never be invalidated.
async function fetchJiraLinks(boardId: string): Promise<JiraSourceLinks> {
  const empty: JiraSourceLinks = { byProjectKey: {}, fallback: null };
  try {
    const res = await authFetch(`/boards/${boardId}/sources/jira/atlassian-urls`, {
      cache: 'no-store',
    });
    if (!res.ok) return empty;
    return res.json();
  } catch {
    return empty;
  }
}

async function fetchHasGitHubIntegration(): Promise<boolean> {
  try {
    const res = await authFetch('/github/sync-configs', { cache: 'no-store' });
    if (!res.ok) return false;
    const configs = await res.json();
    return configs.length > 0;
  } catch {
    return false;
  }
}

// Keyed by ADO project name — a board's items can come from more than one ADO
// org/connection (BoardAdoSource is board <-> AzureDevOpsProjectSync, not 1:1),
// so the org URL must be resolved per project, scoped to this board. Previously
// this grabbed the first row of the global `/azure-devops/instances` list, which
// pointed every board's Source links at whichever ADO connection was created
// first — regardless of which connection a given board actually synced from.
// `no-store`, matching the sibling Jira/GitHub connection fetchers: attaching or
// detaching a board source (apps/web/app/actions/board-sources.ts) revalidates
// nothing, so a `boardTag` cache entry here would never be invalidated — a newly
// attached source's rows would render "—" instead of a link, and an edited org URL
// would stay stale. Only board *content* mutations revalidate boardTag.
async function fetchAdoOrgUrlsByProject(boardId: string): Promise<Record<string, string>> {
  try {
    const res = await authFetch(`/boards/${boardId}/sources/ado/org-urls`, {
      cache: 'no-store',
    });
    if (!res.ok) return {};
    return res.json();
  } catch {
    return {};
  }
}

async function fetchBoardOwners(boardId: string): Promise<BoardOwner[]> {
  try {
    const res = await authFetch(`/boards/${boardId}/owners`, {
      tags: [boardTag(boardId)],
    });
    if (!res.ok) return [];
    return res.json();
  } catch {
    return [];
  }
}

async function fetchBoardStatuses(boardId: string): Promise<BoardStatus[]> {
  try {
    const res = await authFetch(`/boards/${boardId}/statuses`, {
      tags: [boardTag(boardId)],
    });
    if (!res.ok) return [];
    return res.json();
  } catch {
    return [];
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchBoardViews(boardId: string): Promise<any[]> {
  try {
    const res = await authFetch(`/boards/${boardId}/views`, {
      tags: [boardTag(boardId)],
    });
    if (!res.ok) return [];
    return res.json();
  } catch {
    return [];
  }
}

async function fetchCommentCounts(
  projectIds: string[],
): Promise<Record<string, number>> {
  if (projectIds.length === 0) return {};
  try {
    const res = await authFetch(
      `/projects/comment-counts?projectIds=${projectIds.join(",")}`,
      { tags: projectIds.map((id) => commentsTag(id)) },
    );
    if (!res.ok) return {};
    return res.json();
  } catch {
    return {};
  }
}

// Returns an OUTCOME rather than `string | null` so a refused credential stops
// being indistinguishable from "this organization has no boards". Both used to
// be `null`, and the caller's no-boards branch rendered a dead session as an
// empty board — the reported "broken screen".
async function ensureDefaultBoard(boardId?: string): Promise<DefaultBoardOutcome> {
  if (boardId) return { status: "ok", boardId };

  try {
    const res = await authFetch("/boards", { tags: [boardsListTag()] });
    const boards = res.ok
      ? ((await res.json()) as Array<{ id: string }>)
      : null;
    const lastBoardId = (await cookies()).get(LAST_BOARD_COOKIE)?.value;
    return resolveDefaultBoard(res, boards, lastBoardId);
  } catch (err) {
    if (err instanceof MissingSessionError) return { status: "unauthenticated" };
    // Transport failure, not a verdict on the credential — keep degrading to
    // the no-boards view rather than bouncing the caller to Keycloak.
    return { status: "none" };
  }
}


export default async function BoardPage(props: PageProps) {
  const searchParams = await props.searchParams;
  const boardId = searchParams?.boardId as string | undefined;
  // A notification's deep link. Consumed and cleared client-side by GroupList,
  // so closing the panel does not reopen it and a refresh does not replay it.
  const itemId = searchParams?.itemId as string | undefined;
  const commentId = searchParams?.commentId as string | undefined;
  const defaultBoard = await ensureDefaultBoard(boardId);

  // Outside any try/catch on purpose: `redirect()` unwinds the render by
  // throwing, and this page is full of helpers whose bare `catch` would swallow
  // that and carry on rendering the empty board this exists to prevent.
  if (defaultBoard.status === "unauthenticated") {
    redirect(SESSION_EXPIRED_REDIRECT);
  }

  if (defaultBoard.status === "none") {
    return (
      <Suspense fallback={<div>Loading...</div>}>
        <BoardView
          board={null}
          groups={[]}
          columns={[]}
          boardId=""
          jiraLinks={{ byProjectKey: {}, fallback: null }}
          hasGitHubIntegration={false}
          adoOrgUrls={{}}
          hasAdoIntegration={false}
          commentCounts={{}}
          boardOwners={[]}
          boardStatuses={[]}
          userRole="OWNER"
        />
      </Suspense>
    );
  }

  const selectedBoardId = defaultBoard.boardId;

  const [groupsResult, columns, boardOutcome, jiraLinks, hasGitHubIntegration, adoOrgUrls, boardOwners, boardStatuses, views] = await Promise.all([
    fetchGroups(selectedBoardId),
    fetchColumns(selectedBoardId),
    fetchBoard(selectedBoardId),
    fetchJiraLinks(selectedBoardId),
    fetchHasGitHubIntegration(),
    fetchAdoOrgUrlsByProject(selectedBoardId),
    fetchBoardOwners(selectedBoardId),
    fetchBoardStatuses(selectedBoardId),
    fetchBoardViews(selectedBoardId),
  ]);
  // Same placement rule as the redirect above: this sits in `BoardPage`'s own
  // body, after `Promise.all` has resolved, so it is outside every helper's
  // `catch` and nothing can swallow the `NEXT_REDIRECT` throw.
  if (boardOutcome.status === "unauthenticated") {
    redirect(SESSION_EXPIRED_REDIRECT);
  }

  const board = boardOutcome.status === "ok" ? boardOutcome.board : null;
  const { groups, total: projectTotal } = groupsResult;
  const hasAdoIntegration = Object.keys(adoOrgUrls).length > 0;

  // Comment counts for the first (SSR) page only; the progressive loader fetches
  // counts for later pages client-side as they load.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allProjectIds = groups.flatMap((g) => (g.projects ?? []).map((p: any) => p.id));
  const commentCounts = await fetchCommentCounts(allProjectIds);

  // The caller's real effective role, resolved by the API through the org-role
  // ceiling. This replaced `session ? 'OWNER' : 'VIEWER'`, whose comment claimed
  // SSR tokens might not reach the API — every other fetch on this page is
  // board(VIEWER)-gated and succeeds, so they demonstrably do. fetchMyRole fails
  // closed, so a genuine failure renders the board read-only rather than
  // granting phantom ownership.
  // Task 13: the Intelligence tab opens the SQL console, which the API now
  // gates at `ADMIN` — its rewrite-and-assert scoping has three known
  // privilege-escalation bypasses (see intelligence-query/routes.ts's
  // file-header comment); this is a mitigation, not a fix. `isOrganizationAdmin`
  // is the existing presentation-only admin signal this app already uses to
  // hide the Members/Connections settings tabs from non-admins — reused here
  // rather than inventing a second one, same as `boards/[boardId]/layout.tsx`.
  const [{ role: userRole, userId: currentUserId }, boardAccess, orgState] = await Promise.all([
    fetchMyRole('board', selectedBoardId),
    fetchAccess('board', selectedBoardId),
    getBootstrapState(),
  ]);
  const isAdmin = isOrganizationAdmin(orgState);

  return (
    <Suspense fallback={<div>Loading...</div>}>
      <BoardPageContent
        boardId={selectedBoardId}
        views={views}
        deepLink={itemId ? { itemId, commentId } : undefined}
        canEdit={canEditEntity(userRole)}
        isAdmin={isAdmin}
        projectTotal={projectTotal}
        boardViewProps={{
          board,
          groups,
          columns,
          boardId: selectedBoardId,
          jiraLinks,
          hasGitHubIntegration,
          adoOrgUrls,
          hasAdoIntegration,
          commentCounts,
          boardOwners,
          boardStatuses,
          userRole,
          currentUserId,
          boardAccess,
        }}
      />
    </Suspense>
  );
}

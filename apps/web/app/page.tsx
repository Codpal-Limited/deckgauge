import { Suspense } from "react";
import type { Group, BoardColumn, BoardOwner, BoardStatus } from "@deckgauge/shared";
import type { JiraSourceLinks } from "@deckgauge/shared";
import { BoardView } from "./components/BoardView";
import BoardPageContent from "./components/BoardPageContent";
import { auth } from "@/auth";
import { authFetch } from "./actions/api";
import { boardsListTag, boardTag, commentsTag } from "./utils/cache-tags";
import { bucketProjectsIntoGroups } from "./utils/bucket-projects";
import { cookies } from "next/headers";
import { selectDefaultBoard } from "./utils/select-default-board";
import { LAST_BOARD_COOKIE } from "./utils/last-board-cookie";

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams?: Record<string, string | string[]>;
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

async function fetchBoard(boardId: string) {
  try {
    const res = await authFetch(`/boards/${boardId}`, {
      tags: [boardTag(boardId)],
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
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

async function ensureDefaultBoard(boardId?: string): Promise<string | null> {
  if (boardId) return boardId;

  try {
    const res = await authFetch("/boards", { tags: [boardsListTag()] });
    if (!res.ok) return null;
    const boards = (await res.json()) as Array<{ id: string }>;
    const lastBoardId = cookies().get(LAST_BOARD_COOKIE)?.value;
    return selectDefaultBoard(boards, lastBoardId);
  } catch {
    return null;
  }
}


export default async function BoardPage({ searchParams }: PageProps) {
  const boardId = searchParams?.boardId as string | undefined;
  const selectedBoardId = await ensureDefaultBoard(boardId);

  if (!selectedBoardId) {
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

  const [groupsResult, columns, board, jiraLinks, hasGitHubIntegration, adoOrgUrls, boardOwners, boardStatuses, views] = await Promise.all([
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
  const { groups, total: projectTotal } = groupsResult;
  const hasAdoIntegration = Object.keys(adoOrgUrls).length > 0;

  // Comment counts for the first (SSR) page only; the progressive loader fetches
  // counts for later pages client-side as they load.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allProjectIds = groups.flatMap((g) => (g.projects ?? []).map((p: any) => p.id));
  const commentCounts = await fetchCommentCounts(allProjectIds);

  // Determine user role. Default to OWNER if logged in — V1 is single-user mode
  // and the my-role API may fail when SSR auth tokens aren't forwarded in Docker.
  const session = await auth();
  const userRole: 'OWNER' | 'EDITOR' | 'VIEWER' = session ? 'OWNER' : 'VIEWER';

  return (
    <Suspense fallback={<div>Loading...</div>}>
      <BoardPageContent
        boardId={selectedBoardId}
        views={views}
        canEdit={userRole !== 'VIEWER'}
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
        }}
      />
    </Suspense>
  );
}

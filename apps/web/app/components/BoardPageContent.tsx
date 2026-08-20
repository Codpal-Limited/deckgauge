'use client';

import { useEffect, useRef, useState } from 'react';
import type { AccessEntry, JiraSourceLinks } from '@deckgauge/shared';
import { BoardUnifiedTabs } from './tabs/BoardUnifiedTabs';
import { BoardView } from './BoardView';
import { fetchProjectsPage, fetchCommentCounts } from '../actions/projects';
import { mergeProjectsIntoGroups } from '../utils/bucket-projects';
import DashboardCanvas from './dashboard/DashboardCanvas';
import ApplyPresetBanner from './dashboard/ApplyPresetBanner';
import RoadmapTab from './roadmap/RoadmapTab';
import { setLastBoardCookie } from '../utils/last-board-cookie';
import { isTempId } from '../utils/optimistic-mutators';

interface BoardPageContentProps {
  boardId: string;
  views: Array<{
    id: string;
    type: 'BOARD' | 'DASHBOARD' | 'ROADMAP';
    name: string;
    position: number;
    presetKey?: string | null;
  }>;
  canEdit: boolean;
  // Total project count for the board (from SSR). When it exceeds the rows the
  // SSR shipped (first page), the client progressively streams the rest.
  projectTotal: number;
  boardViewProps: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    board: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    groups: any[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    columns: any[];
    boardId: string;
    jiraLinks: JiraSourceLinks;
    hasGitHubIntegration: boolean;
    adoOrgUrls: Record<string, string>;
    hasAdoIntegration: boolean;
    commentCounts: Record<string, number>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    boardOwners: any[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    boardStatuses: any[];
    userRole: 'OWNER' | 'EDITOR' | 'VIEWER' | null;
    currentUserId?: string | null;
    boardAccess?: AccessEntry[];
  };
}

// Server re-renders are authoritative for rows they include. Preserve previously
// streamed rows that are still missing from the SSR page, but drop temp ids so
// optimistic placeholders are replaced by real server entities.
function reconcileServerGroups(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  previousGroups: any[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  serverGroups: any[],
  deletedProjectIds: Set<string>,
) {
  const previousById = new Map(previousGroups.map((group) => [group.id, group]));
  const seenProjectIds = new Set<string>();

  // Server payload is authoritative for placement. Track every server project id
  // globally so we don't carry the same row into another group from previous state.
  for (const group of serverGroups) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const project of (group.projects ?? []) as any[]) {
      seenProjectIds.add(project.id);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return serverGroups.map((serverGroup: any) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const previousGroup: any = previousById.get(serverGroup.id);
    if (!previousGroup) return serverGroup;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const serverProjects: any[] = serverGroup.projects ?? [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const carriedProjects: any[] = (previousGroup.projects ?? []).filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (project: any) =>
        !seenProjectIds.has(project.id) &&
        !isTempId(project.id) &&
        !deletedProjectIds.has(project.id),
    );

    if (carriedProjects.length === 0) return serverGroup;

    for (const project of carriedProjects) {
      seenProjectIds.add(project.id);
    }

    return {
      ...serverGroup,
      projects: [...serverProjects, ...carriedProjects].sort(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (a: any, b: any) => (a.order ?? 0) - (b.order ?? 0),
      ),
    };
  });
}

export default function BoardPageContent({
  boardId,
  views,
  canEdit,
  projectTotal,
  boardViewProps,
}: BoardPageContentProps) {
  const [activeViewId, setActiveViewId] = useState(
    () => views.find((v) => v.type === 'BOARD')?.id ?? views[0]?.id ?? ''
  );
  // Progressive board loading: SSR ships only the first page of rows; the rest
  // stream in here after first paint, merged into these states which feed
  // BoardView. Server re-renders are reconciled for the current board so
  // server actions can replace optimistic temp ids and authoritative edits.
  const [groups, setGroups] = useState(boardViewProps.groups);
  const [commentCounts, setCommentCounts] = useState(boardViewProps.commentCounts);
  const [deletedProjectIds, setDeletedProjectIds] = useState<Set<string>>(new Set());
  const lastSeededBoardIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!boardId) return;
    setLastBoardCookie(boardId);
  }, [boardId]);

  useEffect(() => {
    const isNewBoard = lastSeededBoardIdRef.current !== boardId;
    lastSeededBoardIdRef.current = boardId;

    if (isNewBoard) {
      // Board switch: seed local state from this board's SSR page.
      setGroups(boardViewProps.groups);
      setCommentCounts(boardViewProps.commentCounts);
      setDeletedProjectIds(new Set());
      return;
    }

    // Same board: fold fresh SSR data into existing local state so streamed rows
    // remain visible while server mutations reconcile authoritative changes.
    setGroups((previous) =>
      reconcileServerGroups(previous, boardViewProps.groups, deletedProjectIds),
    );
    setCommentCounts((previous) => ({ ...previous, ...boardViewProps.commentCounts }));
  }, [boardId, boardViewProps.groups, boardViewProps.commentCounts, deletedProjectIds]);

  useEffect(() => {
    // Progressive loading runs once per board and appends missing pages.
    // Subsequent server re-renders reconcile via the effect above.
    if (!boardId) return;

    const loaded = boardViewProps.groups.reduce(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (n: number, g: any) => n + (g.projects?.length ?? 0),
      0,
    );
    if (loaded >= projectTotal) return; // small board: SSR shipped everything

    let cancelled = false;
    const LOAD_PAGE_SIZE = 500;
    (async () => {
      // Accumulate every remaining page, then merge ONCE. A single state update
      // (vs one per page) avoids 40+ re-renders and shrinks the window in which
      // a streamed update could transiently override an optimistic edit to an
      // already-visible row. (The server already has the edit, so it reappears
      // on the next interaction — single-user V1, acceptable transient.)
      // Start at page 1: re-fetching the first rows is cheap and the merge
      // dedups them by id, so we avoid page/pageSize skip-alignment math.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const collected: any[] = [];
      let page = 1;
      let hasMore = true;
      while (hasMore && !cancelled) {
        const res = await fetchProjectsPage(boardId, page, LOAD_PAGE_SIZE);
        if (cancelled) return;
        collected.push(...res.items);
        hasMore = res.hasMore;
        page++;
      }
      if (cancelled || collected.length === 0) return;
      const filtered = collected.filter(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (project: any) => !deletedProjectIds.has(String(project.id)),
      );
      if (filtered.length === 0) return;
      setGroups((prev) => mergeProjectsIntoGroups(prev, filtered));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const counts = await fetchCommentCounts(filtered.map((p: any) => p.id));
      if (cancelled) return;
      if (Object.keys(counts).length > 0) {
        setCommentCounts((prev) => ({ ...prev, ...counts }));
      }
    })();
    return () => {
      cancelled = true;
    };
    // Runs once per board.
  }, [boardId, deletedProjectIds]);

  const activeView = views.find((v) => v.id === activeViewId);

  return (
    <div className="space-y-4">
      <BoardUnifiedTabs
        boardId={boardId}
        views={views}
        activeViewId={activeViewId}
        activeSection={null}
        onViewChange={setActiveViewId}
        canEdit={canEdit}
      />
      {activeView?.type === 'ROADMAP' ? (
        <RoadmapTab boardId={boardId} viewId={activeViewId} canEdit={canEdit} />
      ) : activeView?.type === 'DASHBOARD' ? (
        <>
          <ApplyPresetBanner
            boardId={boardId}
            alreadyApplied={views.some((v) => v.presetKey === 'engineering-intelligence-v1')}
            onApplied={(viewId) => setActiveViewId(viewId)}
          />
          <DashboardCanvas boardId={boardId} viewId={activeViewId} canEdit={canEdit} />
        </>
      ) : (
        <BoardView
          {...boardViewProps}
          groups={groups}
          commentCounts={commentCounts}
          onGroupsChange={setGroups}
          onProjectDeleted={(projectId) => {
            setDeletedProjectIds((previous) => {
              if (previous.has(projectId)) return previous;
              const next = new Set(previous);
              next.add(projectId);
              return next;
            });
            setCommentCounts((previous) => {
              if (!(projectId in previous)) return previous;
              const next = { ...previous };
              delete next[projectId];
              return next;
            });
          }}
        />
      )}
    </div>
  );
}

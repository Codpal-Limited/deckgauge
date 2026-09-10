'use client';

import { useCallback, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type {
  BoardTree,
  BoardNodeData,
  FolderNodeData,
  SidebarNode,
  OrgTreeDto,
  RoadmapNodeData,
} from '@deckgauge/shared';
import { setLastBoardCookie } from '../../utils/last-board-cookie';
import { useSidebarUiState, type SidebarType } from '../../hooks/useSidebarUiState';
import { useIsMobile } from '../../hooks/useIsMobile';
import { SidebarSearch } from './SidebarSearch';
import { SidebarRail } from './SidebarRail';
import { SidebarPanelHeader } from './SidebarPanelHeader';
import { SidebarNewMenu, type NewMenuItem } from './SidebarNewMenu';
import { BoardsPanel } from './panels/BoardsPanel';
import { RoadmapsPanel } from './panels/RoadmapsPanel';
import { TimesheetsPanel } from './panels/TimesheetsPanel';
import { OrgTreesPanel } from './panels/OrgTreesPanel';
import { ComparisonsPanel } from './panels/ComparisonsPanel';
import { FavoritesPanel } from './panels/FavoritesPanel';
import { boardsOnlyTree, collectRoadmaps, isBoardNode, isRoadmapNode, matchesQuery } from './tree-filter';
import { updateBoardPref, updateFolder, deleteFolder, createFolder, createBoard } from '../../actions/board-tree';
import { createOrgTree } from '../../actions/org-trees';
import { createComparison, type ComparisonSummary } from '../../actions/comparison';
import {
  BOARD_TEMPLATES,
  getBoardTemplate,
  boardCapabilities,
  type BoardKind,
} from '@deckgauge/shared';
import { CreateEntityDialog } from './CreateEntityDialog';
import { createRoadmap, updateRoadmapPref, deleteRoadmap } from '../../actions/roadmap';
import type { FolderHandlers } from './FolderNode';

/** Recursive name-filter over the board tree, keeping folders that still match. */
function filterNodes(nodes: SidebarNode[], q: string): SidebarNode[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return nodes;
  const walk = (list: SidebarNode[]): SidebarNode[] => {
    const out: SidebarNode[] = [];
    for (const n of list) {
      if (n.kind === 'board' || n.kind === 'roadmap') {
        if (n.name.toLowerCase().includes(needle)) out.push(n);
      } else {
        const kids = walk(n.children);
        if (n.name.toLowerCase().includes(needle) || kids.length > 0) {
          out.push({ ...n, isExpanded: true, children: kids });
        }
      }
    }
    return out;
  };
  return walk(nodes);
}

function countBoards(nodes: SidebarNode[]): number {
  let n = 0;
  for (const node of nodes) {
    if (node.kind === 'board') n += 1;
    else if (node.kind === 'folder') n += countBoards(node.children);
  }
  return n;
}

const PLACEHOLDERS: Record<SidebarType, string> = {
  favorites: 'Search favorites…',
  boards: 'Search boards…',
  roadmaps: 'Search roadmaps…',
  timesheets: 'Search timesheets…',
  orgTrees: 'Search org trees…',
  comparisons: 'Search comparisons…',
};

const TITLES: Record<SidebarType, string> = {
  favorites: 'Favorites',
  boards: 'Boards',
  roadmaps: 'Roadmaps',
  timesheets: 'Timesheets',
  orgTrees: 'Org Trees',
  comparisons: 'Comparisons',
};

// Small inline icons for the New menu (15px, currentColor).
const MENU_ICONS = {
  board: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-[15px] w-[15px]">
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
    </svg>
  ),
  folder: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-[15px] w-[15px]">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
    </svg>
  ),
  roadmap: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-[15px] w-[15px]">
      <path d="M4 6h11M4 12h16M4 18h8" />
    </svg>
  ),
  orgTree: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-[15px] w-[15px]">
      <rect x="9" y="2.5" width="6" height="5" rx="1.4" />
      <rect x="2.5" y="16.5" width="6" height="5" rx="1.4" />
      <rect x="15.5" y="16.5" width="6" height="5" rx="1.4" />
      <path d="M12 7.5V12m0 0H5.5v4.5M12 12h6.5v4.5" />
    </svg>
  ),
  comparison: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-[15px] w-[15px]">
      <path d="M6 4v6a3 3 0 0 0 3 3h9" />
      <path d="M15 10l3 3-3 3" />
    </svg>
  ),
};

/** What the Create dialog is currently creating. */
type CreateTarget =
  | { type: 'board'; kind: BoardKind }
  | { type: 'roadmap' }
  | { type: 'orgTree' }
  | { type: 'comparison' };

/** Dialog copy for the non-board entities (boards derive theirs from the template). */
const ENTITY_COPY: Record<
  'roadmap' | 'orgTree' | 'comparison',
  { title: string; summary: string; highlights: string[]; nameLabel: string; namePlaceholder: string }
> = {
  roadmap: {
    title: 'Roadmap',
    summary: 'A quarter-by-quarter timeline of initiatives, sized and scheduled.',
    highlights: [
      'Drag initiatives across quarters',
      'Sizes roll up from linked boards',
      'Share a delivery view with stakeholders',
    ],
    nameLabel: 'Roadmap name',
    namePlaceholder: 'e.g. Q3 Delivery',
  },
  orgTree: {
    title: 'Org / employees',
    summary: 'An org chart of your team with per-engineer workload, timesheets, and analytics.',
    highlights: [
      'Build your reporting hierarchy',
      'Per-engineer workload & timesheets',
      'Connect a directory source (Graph or CSV)',
    ],
    nameLabel: 'Org tree name',
    namePlaceholder: 'e.g. Engineering Org',
  },
  comparison: {
    title: 'Comparison',
    summary: 'Put several boards side by side to compare delivery metrics.',
    highlights: [
      'Pick any set of boards',
      'Compare velocity, DORA, and more',
      'Spot outliers across teams',
    ],
    nameLabel: 'Comparison name',
    namePlaceholder: 'e.g. Squad A vs B',
  },
};

type TreeHandlers = FolderHandlers & {
  onMoveBoard: (boardId: string, folderId: string | null) => void;
  onMoveRoadmap: (roadmapId: string, folderId: string | null) => void;
  onToggleRoadmapFavorite: (node: RoadmapNodeData) => void;
  onHideRoadmap: (node: RoadmapNodeData) => void;
  onUnhideRoadmap: (node: RoadmapNodeData) => void;
  onDeleteRoadmap: (node: RoadmapNodeData) => void;
};

export function BoardSidebar({
  tree,
  activeBoardId,
  orgTrees = [],
  comparisons = [],
}: {
  tree: BoardTree;
  activeBoardId: string | null;
  orgTrees?: OrgTreeDto[];
  comparisons?: ComparisonSummary[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { collapsed, toggleCollapsed, activeType, setActiveType, isSectionOpen, toggleSection } =
    useSidebarUiState();
  // Inside the mobile drawer the panel is ALWAYS shown. `collapsed` is persisted
  // desktop preference, so a user who collapsed the sidebar on their laptop
  // would otherwise open the drawer to a bare 56px rail in an 88vw panel.
  const isMobile = useIsMobile();
  const showPanel = isMobile || !collapsed;
  const [query, setQuery] = useState('');
  const [createTarget, setCreateTarget] = useState<CreateTarget | null>(null);
  const [creating, setCreating] = useState(false);

  // Roadmaps render at /roadmap/<id>. Mirror page.tsx's resolution so the
  // highlighted node always matches what's on screen.
  const activeRoadmapId = pathname?.match(/^\/roadmap\/([^/]+)/)?.[1] ?? null;
  // Board sub-views (Sources, Intelligence, Insights, board-scoped Roadmap) render at
  // /boards/<id>/... with no ?boardId. Read the board from the path so the sidebar
  // highlights it, instead of falling back to the last-board cookie (activeBoardId).
  const activeBoardPathId = pathname?.match(/^\/boards\/([^/]+)/)?.[1] ?? null;
  const effectiveActiveId =
    activeRoadmapId ?? activeBoardPathId ?? searchParams.get('boardId') ?? activeBoardId;
  const activeOrgTreeId = pathname === '/timesheet' ? searchParams.get('orgTreeId') : null;

  const openBoard = useCallback(
    (id: string) => {
      setLastBoardCookie(id);
      router.push(`/?boardId=${id}`);
    },
    [router],
  );

  const after = useCallback(() => router.refresh(), [router]);

  const onToggleRoadmapFavorite = useCallback(
    async (n: RoadmapNodeData) => {
      await updateRoadmapPref(n.id, { isFavorite: !n.isFavorite });
      after();
    },
    [after],
  );
  const onHideRoadmap = useCallback(
    async (n: RoadmapNodeData) => {
      await updateRoadmapPref(n.id, { isHidden: true });
      after();
    },
    [after],
  );
  const onUnhideRoadmap = useCallback(
    async (n: RoadmapNodeData) => {
      await updateRoadmapPref(n.id, { isHidden: false });
      after();
    },
    [after],
  );
  const onDeleteRoadmap = useCallback(
    async (n: RoadmapNodeData) => {
      if (window.confirm(`Delete roadmap "${n.name}"? This cannot be undone.`)) {
        await deleteRoadmap(n.id);
        if (activeRoadmapId === n.id) router.push('/');
        else after();
      }
    },
    [after, activeRoadmapId, router],
  );

  const handlers: TreeHandlers = useMemo(
    () => ({
      activeBoardId: effectiveActiveId,
      onOpenBoard: openBoard,
      onToggleExpand: async (f: FolderNodeData) => {
        await updateFolder(f.id, { isExpanded: !f.isExpanded });
        after();
      },
      onRenameFolder: async (f: FolderNodeData) => {
        const name = window.prompt('Rename folder', f.name);
        if (name && name.trim()) {
          await updateFolder(f.id, { name: name.trim() });
          after();
        }
      },
      onRecolorFolder: async (f: FolderNodeData) => {
        const color = window.prompt('Folder color hex (e.g. #10B981)', f.color);
        if (color && /^#[0-9A-Fa-f]{6}$/.test(color)) {
          await updateFolder(f.id, { color });
          after();
        }
      },
      onDeleteFolder: async (f: FolderNodeData) => {
        if (window.confirm(`Delete folder "${f.name}"? Boards inside it move to the top level.`)) {
          await deleteFolder(f.id);
          after();
        }
      },
      onToggleFavorite: async (b: BoardNodeData) => {
        await updateBoardPref(b.id, { isFavorite: !b.isFavorite });
        after();
      },
      onHideBoard: async (b: BoardNodeData) => {
        await updateBoardPref(b.id, { isHidden: true });
        after();
      },
      onUnhideBoard: async (b: BoardNodeData) => {
        await updateBoardPref(b.id, { isHidden: false });
        after();
      },
      onMoveBoard: async (boardId: string, folderId: string | null) => {
        await updateBoardPref(boardId, { folderId });
        after();
      },
      onMoveRoadmap: async (roadmapId: string, folderId: string | null) => {
        await updateRoadmapPref(roadmapId, { folderId });
        after();
      },
      onToggleRoadmapFavorite,
      onHideRoadmap,
      onUnhideRoadmap,
      onDeleteRoadmap,
    }),
    [effectiveActiveId, openBoard, after, onToggleRoadmapFavorite, onHideRoadmap, onUnhideRoadmap, onDeleteRoadmap],
  );

  // ---- Per-type derived data ----
  const boardTree = useMemo(() => boardsOnlyTree(tree.tree), [tree.tree]);
  const visibleBoardTree = useMemo(() => filterNodes(boardTree, query), [boardTree, query]);
  const boardFavorites = useMemo(
    () => tree.favorites.filter(isBoardNode).filter((b) => matchesQuery(b.name, query)),
    [tree.favorites, query],
  );
  const boardHidden = useMemo(() => tree.hidden.filter(isBoardNode), [tree.hidden]);

  const allRoadmaps = useMemo(
    () => collectRoadmaps(tree.tree).filter((r) => matchesQuery(r.name, query)),
    [tree.tree, query],
  );
  const hiddenRoadmaps = useMemo(() => tree.hidden.filter(isRoadmapNode), [tree.hidden]);

  const favoriteItems = useMemo(
    () => tree.favorites.filter((n) => matchesQuery(n.name, query)),
    [tree.favorites, query],
  );

  const visibleOrgTrees = useMemo(
    () => orgTrees.filter((ot) => matchesQuery(ot.name, query)),
    [orgTrees, query],
  );

  const visibleComparisons = useMemo(
    () => comparisons.filter((c) => matchesQuery(c.name, query)),
    [comparisons, query],
  );

  const counts: Record<SidebarType, number | undefined> = {
    favorites: tree.favorites.length,
    boards: countBoards(boardTree),
    roadmaps: collectRoadmaps(tree.tree).length,
    timesheets: orgTrees.length,
    orgTrees: orgTrees.length,
    comparisons: comparisons.length,
  };

  // ---- New menu ----
  const handleNewBoard = useCallback((template: BoardKind) => {
    setCreateTarget({ type: 'board', kind: template });
  }, []);
  const handleNewRoadmap = useCallback(() => setCreateTarget({ type: 'roadmap' }), []);
  const handleNewOrgTree = useCallback(() => setCreateTarget({ type: 'orgTree' }), []);
  const handleNewComparison = useCallback(() => setCreateTarget({ type: 'comparison' }), []);

  const handleNewFolder = useCallback(async () => {
    const name = window.prompt('New folder name');
    if (name && name.trim()) {
      await createFolder({ name: name.trim(), color: '#6366F1' });
      after();
    }
  }, [after]);

  // The dialog collects + trims the name; each target creates its entity and routes.
  const confirmCreate = useCallback(
    async (name: string) => {
      if (!createTarget) return;
      setCreating(true);
      try {
        switch (createTarget.type) {
          case 'board': {
            const board = await createBoard(name, createTarget.kind);
            if (boardCapabilities(createTarget.kind).sourceOnboarding) {
              setLastBoardCookie(board.id);
              router.push(`/boards/${board.id}/sources`);
            } else {
              openBoard(board.id);
            }
            break;
          }
          case 'roadmap': {
            const created = await createRoadmap(name);
            router.push(`/roadmap/${created.id}`);
            break;
          }
          case 'orgTree': {
            const created = await createOrgTree(name);
            router.push(`/org/${created.id}`);
            break;
          }
          case 'comparison': {
            const created = await createComparison(name);
            router.push(`/comparison/${created.id}`);
            break;
          }
        }
        setCreateTarget(null);
      } finally {
        setCreating(false);
      }
    },
    [createTarget, router, openBoard],
  );

  // Display copy for the create dialog, derived from the current target.
  const createDialogProps = !createTarget
    ? null
    : createTarget.type === 'board'
      ? {
          title: getBoardTemplate(createTarget.kind).label,
          icon: MENU_ICONS.board,
          summary: getBoardTemplate(createTarget.kind).explainer.summary,
          highlights: getBoardTemplate(createTarget.kind).explainer.highlights as readonly string[],
          footnote: boardCapabilities(createTarget.kind).sourceOnboarding
            ? 'Next: connect Jira, GitHub, Azure DevOps, or GitLab.'
            : undefined,
          nameLabel: 'Board name',
          namePlaceholder: 'e.g. Platform Team',
        }
      : {
          title: ENTITY_COPY[createTarget.type].title,
          icon:
            createTarget.type === 'roadmap'
              ? MENU_ICONS.roadmap
              : createTarget.type === 'orgTree'
                ? MENU_ICONS.orgTree
                : MENU_ICONS.comparison,
          summary: ENTITY_COPY[createTarget.type].summary,
          highlights: ENTITY_COPY[createTarget.type].highlights as readonly string[],
          footnote: undefined as string | undefined,
          nameLabel: ENTITY_COPY[createTarget.type].nameLabel,
          namePlaceholder: ENTITY_COPY[createTarget.type].namePlaceholder,
        };

  // Board-type picker: one entry per template (auto-extends as templates are added),
  // grouped under "Boards". Each carries the template's own one-line description.
  const boardTemplateItems: NewMenuItem[] = BOARD_TEMPLATES.map((t) => ({
    label: t.label,
    description: t.description,
    section: 'Boards',
    icon: MENU_ICONS.board,
    onSelect: () => handleNewBoard(t.kind),
  }));

  const newItems: NewMenuItem[] = [
    ...boardTemplateItems,
    {
      label: 'Roadmap',
      description: 'A quarter-by-quarter timeline of initiatives, sized and scheduled.',
      section: 'Plan & analyze',
      icon: MENU_ICONS.roadmap,
      onSelect: handleNewRoadmap,
    },
    {
      label: 'Org / employees',
      description: 'An org chart with per-engineer workload, timesheets, and analytics.',
      section: 'Plan & analyze',
      icon: MENU_ICONS.orgTree,
      onSelect: handleNewOrgTree,
    },
    {
      label: 'Comparison',
      description: 'Put several boards side by side to compare delivery metrics.',
      section: 'Plan & analyze',
      icon: MENU_ICONS.comparison,
      onSelect: handleNewComparison,
    },
    {
      label: 'Folder',
      description: 'A container to group boards and roadmaps in the sidebar.',
      section: 'Organize',
      icon: MENU_ICONS.folder,
      onSelect: handleNewFolder,
    },
  ];

  return (
    // Desktop: a sticky column beside `<main>`, offset by the 3.5rem header.
    // Below `md` it is inside a fixed, full-height drawer, so the sticky
    // offset and the viewport-minus-header height are both wrong there.
    <aside className="sticky top-14 flex h-[calc(100vh-3.5rem)] shrink-0 border-r border-slate-200 bg-slate-50 max-md:static max-md:h-full max-md:w-full max-md:border-r-0">
      <SidebarRail activeType={activeType} onSelect={setActiveType} />

      {showPanel && (
        <div className="flex w-60 flex-col max-md:w-auto max-md:min-w-0 max-md:flex-1">
          <SidebarPanelHeader
            title={TITLES[activeType]}
            count={counts[activeType]}
            onCollapse={isMobile ? undefined : toggleCollapsed}
          />

          <SidebarSearch value={query} onChange={setQuery} placeholder={PLACEHOLDERS[activeType]} />

          <div className="flex-1 overflow-y-auto px-2 pb-3">
            {activeType === 'favorites' && (
              <FavoritesPanel
                favorites={favoriteItems}
                activeId={effectiveActiveId}
                openBoard={openBoard}
                onToggleBoardFavorite={handlers.onToggleFavorite}
                onHideBoard={handlers.onHideBoard}
                onUnhideBoard={handlers.onUnhideBoard}
                onToggleRoadmapFavorite={onToggleRoadmapFavorite}
                onHideRoadmap={onHideRoadmap}
                onUnhideRoadmap={onUnhideRoadmap}
                onDeleteRoadmap={onDeleteRoadmap}
              />
            )}

            {activeType === 'boards' && (
              <BoardsPanel
                favorites={boardFavorites}
                tree={visibleBoardTree}
                hidden={boardHidden}
                activeBoardId={effectiveActiveId}
                openBoard={openBoard}
                handlers={handlers}
                isSectionOpen={isSectionOpen}
                toggleSection={toggleSection}
              />
            )}

            {activeType === 'roadmaps' && (
              <RoadmapsPanel
                roadmaps={allRoadmaps}
                hidden={hiddenRoadmaps}
                activeRoadmapId={activeRoadmapId}
                onToggleFavorite={onToggleRoadmapFavorite}
                onHide={onHideRoadmap}
                onUnhide={onUnhideRoadmap}
                onDelete={onDeleteRoadmap}
              />
            )}

            {activeType === 'timesheets' && (
              <TimesheetsPanel
                orgTrees={visibleOrgTrees}
                activeOrgTreeId={activeOrgTreeId}
                onNavigate={() => setQuery('')}
              />
            )}

            {activeType === 'orgTrees' && (
              <OrgTreesPanel orgTrees={visibleOrgTrees} activePath={pathname} />
            )}

            {activeType === 'comparisons' && (
              <ComparisonsPanel comparisons={visibleComparisons} activePath={pathname} />
            )}
          </div>

          <SidebarNewMenu items={newItems} />
        </div>
      )}

      {createDialogProps && (
        <CreateEntityDialog
          title={createDialogProps.title}
          icon={createDialogProps.icon}
          summary={createDialogProps.summary}
          highlights={createDialogProps.highlights}
          footnote={createDialogProps.footnote}
          nameLabel={createDialogProps.nameLabel}
          namePlaceholder={createDialogProps.namePlaceholder}
          isPending={creating}
          onCancel={() => setCreateTarget(null)}
          onCreate={confirmCreate}
        />
      )}
    </aside>
  );
}

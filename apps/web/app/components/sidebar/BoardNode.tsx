'use client';

import type { BoardNodeData } from '@deckgauge/shared';
import { RowMenu, type RowMenuItem } from './RowMenu';

export interface BoardNodeProps {
  board: BoardNodeData;
  depth: number;
  active: boolean;
  hidden?: boolean;
  onOpen: (boardId: string) => void;
  onToggleFavorite: (board: BoardNodeData) => void;
  onHide: (board: BoardNodeData) => void;
  onUnhide: (board: BoardNodeData) => void;
}

export function BoardNode({
  board, depth, active, hidden = false, onOpen, onToggleFavorite, onHide, onUnhide,
}: BoardNodeProps) {
  const items: RowMenuItem[] = [
    {
      label: board.isFavorite ? 'Remove from favorites' : 'Add to favorites',
      onSelect: () => onToggleFavorite(board),
    },
    hidden
      ? { label: 'Unhide', onSelect: () => onUnhide(board) }
      : { label: 'Hide', onSelect: () => onHide(board) },
  ];

  return (
    <div
      className={`group flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-sm transition ${
        active
          ? 'bg-gradient-to-r from-indigo-500 to-indigo-400 font-medium text-white shadow-sm'
          : 'text-slate-700 hover:bg-white hover:shadow-sm'
      }`}
      style={{ paddingLeft: 10 + depth * 14 }}
    >
      <button
        type="button"
        onClick={() => onOpen(board.id)}
        // A stable hook for e2e, because there is no robust generic locator for
        // this row: it is a `<button>` rather than a link, its only text is the
        // board name, and navigation is imperative
        // (`BoardSidebar.tsx` calls `router.push`). Four specs tried
        // `a[href^="/?boardId="]` instead and hard-failed on timeout — no
        // such anchor exists in the sidebar or on `/` (the only ones are on
        // `OrgEmployeeNode` and the two insights pages). See
        // `e2e/helpers/board.ts`.
        data-testid="sidebar-board-row"
        className="flex flex-1 items-center gap-2 text-left"
        aria-current={active ? 'page' : undefined}
      >
        <span className={`h-2 w-2 shrink-0 rounded-sm ${active ? 'bg-white/80' : 'bg-slate-400'}`} />
        <span className="truncate">{board.name}</span>
        {board.isFavorite && !hidden && (
          <span aria-label="favorite" className="ml-1 text-amber-400">★</span>
        )}
      </button>
      <RowMenu items={items} label={`Actions for ${board.name}`} />
    </div>
  );
}

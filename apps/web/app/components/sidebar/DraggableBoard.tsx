'use client';

import { useDraggable } from '@dnd-kit/core';
import type { BoardNodeData } from '@deckgauge/shared';
import { BoardNode } from './BoardNode';
import type { FolderHandlers } from './FolderNode';

/**
 * A board row wrapped in a dnd-kit draggable. Used at the top level AND for
 * boards nested inside a folder, so any board can be dragged into a folder or
 * back out to the top level (drop targets are resolved by id, not position).
 */
export function DraggableBoard({
  board,
  handlers,
  depth = 0,
}: {
  board: BoardNodeData;
  handlers: FolderHandlers;
  depth?: number;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `board:${board.id}` });
  return (
    // The DRAGGABLE is this wrapper, not the row inside it: `attributes` and
    // `listeners` are spread here, so dnd-kit's `aria-pressed` (set while
    // dragging, `useDraggable` → `:3433`) and the `opacity-40` drag affordance
    // both land on this element. `e2e/mobile-touch.spec.ts` asserts on it; the
    // row's own `sidebar-board-row` id is for navigation and is one level in.
    <div
      ref={setNodeRef}
      data-testid="sidebar-board-draggable"
      {...attributes}
      {...listeners}
      className={isDragging ? 'opacity-40' : ''}
    >
      <BoardNode
        board={board}
        depth={depth}
        active={board.id === handlers.activeBoardId}
        onOpen={handlers.onOpenBoard}
        onToggleFavorite={handlers.onToggleFavorite}
        onHide={handlers.onHideBoard}
        onUnhide={handlers.onUnhideBoard}
      />
    </div>
  );
}

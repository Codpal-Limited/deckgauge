import type { Collision } from '@dnd-kit/core';
import type { SidebarNode, BoardNodeData, RoadmapNodeData } from '@deckgauge/shared';

/** Droppable id for the "un-file to top level" target (spans the whole list). */
export const ROOT_DROPPABLE_ID = 'folder:root';

/** Find a board node anywhere in the tree — top level or nested in a folder. */
export function findBoardById(nodes: SidebarNode[], id: string): BoardNodeData | null {
  for (const node of nodes) {
    if (node.kind === 'board') {
      if (node.id === id) return node;
    } else if (node.kind === 'folder') {
      const found = findBoardById(node.children, id);
      if (found) return found;
    }
  }
  return null;
}

/** Find a roadmap node anywhere in the tree — top level or nested in a folder. */
export function findRoadmapById(nodes: SidebarNode[], id: string): RoadmapNodeData | null {
  for (const node of nodes) {
    if (node.kind === 'roadmap') {
      if (node.id === id) return node;
    } else if (node.kind === 'folder') {
      const found = findRoadmapById(node.children, id);
      if (found) return found;
    }
  }
  return null;
}

/**
 * The root droppable spans the entire list, so a folder row always shares the
 * pointer with it. When both are hit, prefer the folder — otherwise a drop onto
 * a folder would resolve to root and the board could never enter the folder.
 */
export function preferFolderCollision(collisions: Collision[]): Collision[] {
  const folder = collisions.find((c) => String(c.id) !== ROOT_DROPPABLE_ID);
  return folder ? [folder] : collisions;
}

export interface DropMove {
  kind: 'board' | 'roadmap';
  id: string;
  folderId: string | null; // null = un-file to the top level
}

/**
 * Resolve a drag-end into a move instruction, or null when it is a no-op.
 * Handles both `board:` and `roadmap:` draggables; the drop target is a folder
 * (`folder:<id>`) or the root droppable (un-file to top level).
 */
export function resolveDropTarget(
  activeId: string,
  overId: string | null,
  /**
   * The folder the dragged node currently sits in (`null` = top level).
   *
   * Required rather than optional on purpose: it is what makes a drop onto the
   * node's existing parent a no-op, and an optional parameter is one a call
   * site can quietly omit and lose the guard. Touch made this load-bearing — a
   * drag now activates on a 200ms hold and can end with the finger never
   * having moved, so "dropped where it started" went from rare to routine, and
   * every long press was firing a redundant persistence write.
   */
  currentFolderId: string | null
): DropMove | null {
  if (!overId) return null;
  const kind = activeId.startsWith('board:')
    ? 'board'
    : activeId.startsWith('roadmap:')
      ? 'roadmap'
      : null;
  if (!kind) return null;
  const id = activeId.slice(kind.length + 1); // strip "board:" / "roadmap:"

  const folderId =
    overId === ROOT_DROPPABLE_ID
      ? null
      : overId.startsWith('folder:')
        ? overId.slice('folder:'.length)
        : undefined;
  if (folderId === undefined) return null;

  if (folderId === currentFolderId) return null;
  return { kind, id, folderId };
}

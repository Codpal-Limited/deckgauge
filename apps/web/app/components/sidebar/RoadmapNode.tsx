'use client';

import Link from 'next/link';
import type { RoadmapNodeData } from '@deckgauge/shared';
import { RowMenu, type RowMenuItem } from './RowMenu';

export interface RoadmapNodeProps {
  node: RoadmapNodeData;
  depth?: number;
  active?: boolean;
  hidden?: boolean;
  onToggleFavorite?: (node: RoadmapNodeData) => void;
  onHide?: (node: RoadmapNodeData) => void;
  onUnhide?: (node: RoadmapNodeData) => void;
  onDelete?: (node: RoadmapNodeData) => void;
}

export function RoadmapNode({
  node,
  depth = 0,
  active = false,
  hidden = false,
  onToggleFavorite,
  onHide,
  onUnhide,
  onDelete,
}: RoadmapNodeProps) {
  const items: RowMenuItem[] = [
    {
      label: node.isFavorite ? 'Remove from favorites' : 'Add to favorites',
      onSelect: () => onToggleFavorite?.(node),
    },
    hidden
      ? { label: 'Unhide', onSelect: () => onUnhide?.(node) }
      : { label: 'Hide', onSelect: () => onHide?.(node) },
    { label: 'Delete', danger: true, onSelect: () => onDelete?.(node) },
  ];

  return (
    <div
      className={`group flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-sm transition ${
        active
          ? 'bg-gradient-to-r from-violet-500 to-violet-400 font-medium text-white shadow-sm'
          : 'text-slate-700 hover:bg-white hover:shadow-sm'
      }`}
      style={{ paddingLeft: 10 + depth * 14 }}
    >
      <Link
        href={`/roadmap/${node.id}`}
        className="flex flex-1 items-center gap-1.5 truncate text-left"
        aria-current={active ? 'page' : undefined}
        // Fills the row, which is itself the drag source — see BoardNode.
        data-dnd-handle="true"
      >
        <span
          aria-label="roadmap"
          className={`shrink-0 text-base leading-none ${active ? 'text-white/80' : 'text-violet-400'}`}
        >
          🗺
        </span>
        <span className="truncate">{node.name}</span>
        {node.isFavorite && !hidden && (
          <span aria-label="favorite" className="ml-1 text-amber-400">
            ★
          </span>
        )}
      </Link>
      <RowMenu items={items} label={`Actions for ${node.name}`} />
    </div>
  );
}

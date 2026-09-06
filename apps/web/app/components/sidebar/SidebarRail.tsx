'use client';

import type { JSX } from 'react';

import type { SidebarType } from '../../hooks/useSidebarUiState';
import { DeckgaugeMark } from '../DeckgaugeMark';

interface RailItem {
  type: SidebarType;
  label: string;
  icon: JSX.Element;
}

// Stroke icons inlined (the app has no icon dependency). 21px, currentColor.
const ICONS: Record<SidebarType, JSX.Element> = {
  favorites: (
    <path d="M12 2.5l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.8 6.2 20.9l1.1-6.5L2.6 9.8l6.5-.9L12 2.5z" />
  ),
  boards: (
    <>
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
    </>
  ),
  roadmaps: (
    <>
      <path d="M4 6h11M4 12h16M4 18h8" />
      <circle cx="18" cy="6" r="1.6" />
      <circle cx="14" cy="18" r="1.6" />
    </>
  ),
  timesheets: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </>
  ),
  orgTrees: (
    <>
      <rect x="9" y="2.5" width="6" height="5" rx="1.4" />
      <rect x="2.5" y="16.5" width="6" height="5" rx="1.4" />
      <rect x="15.5" y="16.5" width="6" height="5" rx="1.4" />
      <path d="M12 7.5V12m0 0H5.5v4.5M12 12h6.5v4.5" />
    </>
  ),
  comparisons: (
    <>
      <path d="M6 4v6a3 3 0 0 0 3 3h9" />
      <path d="M15 10l3 3-3 3" />
      <path d="M18 20v-6a3 3 0 0 0-3-3H6" />
      <path d="M9 14l-3-3 3-3" />
    </>
  ),
};

const PRIMARY: RailItem[] = [
  { type: 'boards', label: 'Boards', icon: ICONS.boards },
  { type: 'roadmaps', label: 'Roadmaps', icon: ICONS.roadmaps },
  { type: 'timesheets', label: 'Timesheets', icon: ICONS.timesheets },
  { type: 'orgTrees', label: 'Org Trees', icon: ICONS.orgTrees },
  { type: 'comparisons', label: 'Comparisons', icon: ICONS.comparisons },
];

interface SidebarRailProps {
  activeType: SidebarType;
  onSelect: (type: SidebarType) => void;
}

export function SidebarRail({ activeType, onSelect }: SidebarRailProps) {
  return (
    <nav
      aria-label="Workspace types"
      className="flex w-14 shrink-0 flex-col items-center gap-1 bg-[#0d3b34] py-3"
    >
      <div
        aria-hidden="true"
        className="mb-2 flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-500 text-white shadow-lg shadow-indigo-900/40"
      >
        <DeckgaugeMark className="h-6 w-6" />
      </div>

      <RailButton
        item={{ type: 'favorites', label: 'Favorites', icon: ICONS.favorites }}
        active={activeType === 'favorites'}
        onSelect={onSelect}
      />
      <div className="my-1 h-px w-6 bg-white/10" />

      {PRIMARY.map((item) => (
        <RailButton
          key={item.type}
          item={item}
          active={activeType === item.type}
          onSelect={onSelect}
        />
      ))}
    </nav>
  );
}

interface RailButtonProps {
  item: RailItem;
  active: boolean;
  onSelect: (type: SidebarType) => void;
}

function RailButton({ item, active, onSelect }: RailButtonProps) {
  return (
    <button
      type="button"
      aria-label={item.label}
      title={item.label}
      aria-current={active ? 'page' : undefined}
      onClick={() => onSelect(item.type)}
      className={`group relative flex h-10 w-10 items-center justify-center rounded-xl transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0d3b34] ${
        active
          ? 'bg-gradient-to-br from-indigo-500 to-violet-500 text-white shadow-lg shadow-indigo-900/40'
          : 'text-indigo-200/60 hover:bg-white/10 hover:text-indigo-100'
      }`}
    >
      {active && (
        <span
          aria-hidden="true"
          className="absolute -left-2 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-full bg-white"
        />
      )}
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-[21px] w-[21px]"
        aria-hidden="true"
      >
        {item.icon}
      </svg>
      {/* Hover tooltip */}
      <span
        role="tooltip"
        className="pointer-events-none absolute left-full top-1/2 z-40 ml-2 -translate-y-1/2 scale-95 whitespace-nowrap rounded-md bg-slate-900 px-2 py-1 text-xs font-semibold text-slate-50 opacity-0 shadow-lg transition group-hover:scale-100 group-hover:opacity-100"
      >
        {item.label}
      </span>
    </button>
  );
}

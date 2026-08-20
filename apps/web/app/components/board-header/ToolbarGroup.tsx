'use client';

import type { ReactNode } from 'react';

/**
 * Segmented shell for the board's view controls (search, filter, sort,
 * columns). One border around the set instead of one border per button: the
 * controls read as a single instrument, which is what takes the visual noise
 * out of the action bar without removing anything from it.
 */
export function ToolbarGroup({ children }: { children: ReactNode }) {
  return (
    <div className="inline-flex h-9 items-stretch divide-x divide-slate-200 rounded-lg border border-slate-200 bg-surface-1 shadow-sm">
      {children}
    </div>
  );
}

interface ToolbarSegmentProps {
  label: string;
  icon: ReactNode;
  onClick: () => void;
  /** Hides the text label, leaving the icon and the accessible name. */
  iconOnly?: boolean;
  /** Non-zero renders a count badge and puts the segment in its active tone. */
  count?: number;
  isActive?: boolean;
}

export function ToolbarSegment({
  label,
  icon,
  onClick,
  iconOnly,
  count = 0,
  isActive,
}: ToolbarSegmentProps) {
  const active = isActive || count > 0;

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={`inline-flex items-center gap-1.5 px-2.5 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-500/40 ${
        active
          ? 'bg-teal-500/10 text-teal-600 hover:bg-teal-500/20'
          : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
      }`}
    >
      <span aria-hidden="true" className="flex items-center">
        {icon}
      </span>
      {!iconOnly && <span>{label}</span>}
      {count > 0 && (
        <span className="ml-0.5 inline-flex min-w-[1.1rem] items-center justify-center rounded-full bg-teal-600 px-1 text-[10px] font-semibold leading-4 text-white">
          {count}
        </span>
      )}
    </button>
  );
}

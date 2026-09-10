'use client';

interface SidebarPanelHeaderProps {
  title: string;
  /** Item count shown as a subtle pill; omit to hide. */
  count?: number;
  /**
   * Collapse handler. Omit to hide the collapse control entirely — which is
   * what the mobile drawer does, because collapsing the panel there would leave
   * a 56px rail floating in an 88vw drawer. The drawer closes via its backdrop,
   * Escape, or its own close button instead.
   */
  onCollapse?: () => void;
}

export function SidebarPanelHeader({ title, count, onCollapse }: SidebarPanelHeaderProps) {
  return (
    <div className="flex items-center gap-2 border-b border-slate-200 px-3 py-3">
      <h2 className="flex flex-1 items-center gap-2 truncate text-sm font-bold tracking-tight text-slate-800">
        <span className="truncate">{title}</span>
        {count !== undefined && (
          <span className="rounded-full bg-slate-200 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-slate-500">
            {count}
          </span>
        )}
      </h2>
      {onCollapse && (
        <button
          type="button"
          aria-label="Collapse sidebar"
          onClick={onCollapse}
          className="flex h-6 w-6 items-center justify-center rounded-md text-slate-400 transition hover:bg-slate-200 hover:text-slate-700"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-4 w-4"
            aria-hidden="true"
          >
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
      )}
    </div>
  );
}

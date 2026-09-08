'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { createView, updateView, deleteView } from '../../actions/views';

interface BoardView {
  id: string;
  type: 'BOARD' | 'DASHBOARD' | 'ROADMAP' | 'FOCUS';
  name: string;
  position: number;
}

export type BoardSection = 'sources' | 'intelligence';

interface Props {
  boardId: string;
  views: BoardView[];
  activeViewId: string;
  activeSection: BoardSection | null;
  onViewChange: (viewId: string) => void;
  canEdit: boolean;
  onSettingsClick?: () => void;
  /**
   * Task 13 (intelligence-query mitigation): the SQL console behind this tab
   * is gated on the API at `ADMIN` (instance-wide `ctx.isAdmin`) pending a
   * ClickHouse row-policy fix — its rewrite-and-assert scoping has produced
   * three privilege-escalation bypasses, the last one (ARRAY JOIN clause text
   * re-spliced unexamined) still open. `isOrganizationAdmin(...)` is the
   * closest existing signal this app has to that flag (an org ADMIN's
   * `request.membership.role === 'ADMIN'` is one of the three sources
   * `keycloak-auth.plugin.ts` unions into `ctx.isAdmin`); it does not cover
   * the other two instance-level break-glass sources, so this is presentation
   * only, same as every other `isOrganizationAdmin` gate in this app — the API
   * enforces the real boundary regardless of what this tab shows.
   */
  isAdmin: boolean;
}

function TableIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M.99 5.24A2.25 2.25 0 0 1 3.25 3h13.5A2.25 2.25 0 0 1 19 5.25v9.5A2.25 2.25 0 0 1 16.75 17H3.25A2.25 2.25 0 0 1 1 14.75v-9.5Zm1.5 0v2.5h15v-2.5a.75.75 0 0 0-.75-.75H3.25a.75.75 0 0 0-.75.75Zm15 4h-15v5.5c0 .41.34.75.75.75h13.5a.75.75 0 0 0 .75-.75v-5.5Z" clipRule="evenodd" />
    </svg>
  );
}
function ChartIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="currentColor">
      <path d="M15.5 2A1.5 1.5 0 0 0 14 3.5v13a1.5 1.5 0 0 0 3 0v-13A1.5 1.5 0 0 0 15.5 2ZM9.5 6A1.5 1.5 0 0 0 8 7.5v9a1.5 1.5 0 0 0 3 0v-9A1.5 1.5 0 0 0 9.5 6ZM3.5 10A1.5 1.5 0 0 0 2 11.5v5a1.5 1.5 0 0 0 3 0v-5A1.5 1.5 0 0 0 3.5 10Z" />
    </svg>
  );
}
function SourcesIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M10 1a3 3 0 0 0-3 3v1H4.25A2.25 2.25 0 0 0 2 7.25v8.5A2.25 2.25 0 0 0 4.25 18h11.5A2.25 2.25 0 0 0 18 15.75v-8.5A2.25 2.25 0 0 0 15.75 5H13V4a3 3 0 0 0-3-3Zm1.5 4V4a1.5 1.5 0 0 0-3 0v1h3Z" clipRule="evenodd" />
    </svg>
  );
}
function IntelligenceIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="currentColor">
      <path d="M2.5 10a7.5 7.5 0 0 1 13.32-4.7l-1.18 1.18A5.83 5.83 0 1 0 15.83 10h-2.16l3-3 3 3H17.5A7.5 7.5 0 1 1 2.5 10Z" />
    </svg>
  );
}
function DotsIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="currentColor" viewBox="0 0 20 20">
      <path d="M10 6a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm0 5.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm0 5.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Z" />
    </svg>
  );
}
function RoadmapIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="currentColor">
      <path d="M3 5h8v2H3V5Zm0 4h12v2H3V9Zm0 4h6v2H3v-2Z" />
    </svg>
  );
}

function FocusIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="currentColor">
      <path d="M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm0 2.5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9ZM10 8a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z" />
    </svg>
  );
}

function iconFor(type: BoardView['type']) {
  if (type === 'DASHBOARD') return ChartIcon;
  if (type === 'ROADMAP') return RoadmapIcon;
  if (type === 'FOCUS') return FocusIcon;
  return TableIcon;
}

const TAB_BASE =
  'group relative flex items-center gap-1.5 pl-3 pr-2 py-2 text-[13px] cursor-pointer rounded-t-md border transition-colors';
const TAB_ACTIVE =
  'bg-white text-indigo-600 font-semibold border-slate-200 border-b-white -mb-px z-10';
const TAB_INACTIVE =
  'text-slate-500 hover:text-slate-700 hover:bg-slate-50 border-transparent';

export function BoardUnifiedTabs({
  boardId,
  views,
  activeViewId,
  activeSection,
  onViewChange,
  canEdit,
  onSettingsClick,
  isAdmin,
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [menuId, setMenuId] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuId(null);
    };
    const onClick = (e: MouseEvent) => {
      if (!menuRef.current) return;
      if (!menuRef.current.contains(e.target as Node)) setMenuId(null);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onClick);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onClick);
    };
  }, [menuId]);

  const handleAddDashboard = () =>
    startTransition(async () => {
      const view = await createView(boardId, { type: 'DASHBOARD', name: 'New Dashboard' });
      onViewChange(view.id);
    });

  const handleRenameSubmit = (viewId: string) => {
    if (!editName.trim()) return;
    startTransition(async () => {
      await updateView(boardId, viewId, { name: editName.trim() });
      setEditingId(null);
    });
  };

  const handleRenameStart = (view: BoardView) => {
    setMenuId(null);
    setEditingId(view.id);
    setEditName(view.name);
  };

  const handleDelete = (view: BoardView) => {
    setMenuId(null);
    const ok = confirm(`Delete "${view.name}" dashboard? Widgets will be permanently removed.`);
    if (!ok) return;
    startTransition(async () => {
      try {
        await deleteView(boardId, view.id);
        if (activeViewId === view.id) {
          const remaining = views.filter((v) => v.id !== view.id);
          if (remaining.length > 0) onViewChange(remaining[0].id);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        alert(`Could not delete dashboard: ${msg}`);
      }
    });
  };

  const isLastView = views.length <= 1;

  return (
    <div
      role="tablist"
      className="flex items-end gap-0 pl-4 pr-4 bg-white border-b border-slate-200"
    >
      {/* LEFT — view tabs */}
      <div className="flex items-end">
        {views.map((view) => {
          const isActive = activeSection === null && activeViewId === view.id;
          const Icon = iconFor(view.type);
          return (
            <div
              key={view.id}
              role="tab"
              aria-selected={isActive}
              tabIndex={0}
              className={`${TAB_BASE} ${isActive ? TAB_ACTIVE : TAB_INACTIVE}`}
              onClick={() => onViewChange(view.id)}
            >
              <Icon className={`w-3.5 h-3.5 flex-shrink-0 ${isActive ? 'text-indigo-500' : 'text-slate-400'}`} />
              {editingId === view.id ? (
                <input
                  className="text-[13px] bg-transparent border-b border-indigo-400 outline-none w-20 font-semibold"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  onBlur={() => handleRenameSubmit(view.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleRenameSubmit(view.id);
                    if (e.key === 'Escape') setEditingId(null);
                  }}
                  autoFocus
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <span
                  className="truncate max-w-[120px]"
                  onDoubleClick={() => {
                    if (canEdit) {
                      setEditingId(view.id);
                      setEditName(view.name);
                    }
                  }}
                >
                  {view.name}
                </span>
              )}

              {canEdit && view.type === 'DASHBOARD' && (
                <button
                  type="button"
                  aria-label="Dashboard menu"
                  className={`p-0.5 rounded transition-all ${
                    isActive
                      ? 'opacity-60 hover:opacity-100 hover:bg-indigo-50'
                      : 'opacity-0 group-hover:opacity-60 hover:!opacity-100 hover:bg-slate-100'
                  }`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenuId(menuId === view.id ? null : view.id);
                  }}
                >
                  <DotsIcon className="w-3.5 h-3.5" />
                </button>
              )}

              {menuId === view.id && (
                <div
                  ref={menuRef}
                  role="menu"
                  className="absolute left-0 top-full mt-1 w-36 bg-white rounded-lg shadow-lg border border-slate-200 py-1 z-50"
                >
                  <button
                    type="button"
                    role="menuitem"
                    className="w-full text-left px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleRenameStart(view);
                    }}
                  >
                    Rename
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    aria-disabled={isLastView || isPending}
                    disabled={isLastView || isPending}
                    title={isLastView ? "Can't delete the only view" : undefined}
                    className="w-full text-left px-3 py-1.5 text-xs text-red-600 hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDelete(view);
                    }}
                  >
                    Delete
                  </button>
                </div>
              )}
            </div>
          );
        })}
        {canEdit && (
          <button
            className="flex items-center justify-center w-7 h-7 mb-0.5 ml-1 text-slate-400 hover:text-indigo-500 hover:bg-indigo-50 rounded transition-all duration-150"
            onClick={handleAddDashboard}
            disabled={isPending}
            title="Add dashboard view"
            aria-label="Add view"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
          </button>
        )}
      </div>

      {/* SEPARATOR */}
      <div aria-hidden="true" className="w-px h-5 bg-slate-200 mx-3 mb-2.5" />

      {/* RIGHT — section tabs */}
      <div className="flex items-end">
        <Link
          href={`/boards/${boardId}/sources`}
          role="tab"
          aria-selected={activeSection === 'sources'}
          className={`${TAB_BASE} ${activeSection === 'sources' ? TAB_ACTIVE : TAB_INACTIVE}`}
        >
          <SourcesIcon className={`w-3.5 h-3.5 ${activeSection === 'sources' ? 'text-indigo-500' : 'text-slate-400'}`} />
          <span>Sources</span>
        </Link>
        {isAdmin && (
          <Link
            href={`/boards/${boardId}/intelligence`}
            role="tab"
            aria-selected={activeSection === 'intelligence'}
            className={`${TAB_BASE} ${activeSection === 'intelligence' ? TAB_ACTIVE : TAB_INACTIVE}`}
          >
            <IntelligenceIcon className={`w-3.5 h-3.5 ${activeSection === 'intelligence' ? 'text-indigo-500' : 'text-slate-400'}`} />
            <span>Intelligence</span>
          </Link>
        )}
      </div>

      {onSettingsClick && (
        <button
          type="button"
          aria-label="Board settings"
          onClick={onSettingsClick}
          className="ml-auto mb-1 flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-[13px] text-slate-600 hover:bg-slate-50"
        >
          <svg viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
            <path fillRule="evenodd" d="M10 3a1 1 0 0 1 .894.553l.382.764a1 1 0 0 0 .598.516l.832.277a1 1 0 0 1 .668.668l.277.832a1 1 0 0 0 .516.598l.764.382a1 1 0 0 1 0 1.788l-.764.382a1 1 0 0 0-.516.598l-.277.832a1 1 0 0 1-.668.668l-.832.277a1 1 0 0 0-.598.516l-.382.764a1 1 0 0 1-1.788 0l-.382-.764a1 1 0 0 0-.598-.516l-.832-.277a1 1 0 0 1-.668-.668l-.277-.832a1 1 0 0 0-.516-.598l-.764-.382a1 1 0 0 1 0-1.788l.764-.382a1 1 0 0 0 .516-.598l.277-.832a1 1 0 0 1 .668-.668l.832-.277a1 1 0 0 0 .598-.516l.382-.764A1 1 0 0 1 10 3Zm0 5a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z" clipRule="evenodd" />
          </svg>
          Settings
        </button>
      )}
    </div>
  );
}

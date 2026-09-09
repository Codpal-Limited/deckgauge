'use client';

import { useState, useRef, useEffect, useTransition } from 'react';
import Link from 'next/link';
import type { OrgEmployeeDto } from '@deckgauge/shared';
import { updateEmployee, deleteEmployee } from '../../actions/org-trees';
import { AddEmployeeDialog } from './AddEmployeeDialog';
import {
  avatarColor,
  buildDeleteConfirmMessage,
  deriveActivityStatus,
  formatActivityLabel,
  getInitials,
  rankBadgeView,
  splitBoardChips,
  type ActivityStatus,
} from './employee-presentation';

interface OrgEmployeeNodeProps {
  employee: OrgEmployeeDto;
  orgTreeId?: string;
  childrenNodes: React.ReactNode;
  /**
   * The tree's flat roster, needed only so the delete dialog can say who else
   * goes — deletion cascades to the whole branch. Optional: without it the
   * dialog degrades to naming just this employee, which is what a node
   * rendered outside the tree view (or in a unit test) gets.
   */
  employees?: OrgEmployeeDto[];
  onRefresh?: () => void;
  onSelectEmployee?: (id: string) => void;
  /** Collapse caret (or other control) rendered in a fixed slot before the avatar. */
  leading?: React.ReactNode;
  /** Injectable clock for deterministic tests; defaults to now. */
  now?: Date;
}

type MenuAction = 'add' | 'rename' | 'delete' | null;

// --- status → ring / dot styling -------------------------------------------

const RING_CLASS: Record<ActivityStatus, string> = {
  active: 'ring-2 ring-emerald-400',
  idle: 'ring-2 ring-amber-400',
  none: 'ring-2 ring-slate-300',
  departed: 'ring-0',
  vacancy: 'ring-0',
};

const DOT_CLASS: Record<ActivityStatus, string> = {
  active: 'bg-emerald-500',
  idle: 'bg-amber-500',
  none: 'bg-slate-400',
  departed: '',
  vacancy: '',
};

function StatusGlyph({ status }: { status: ActivityStatus }) {
  const common = {
    className: 'h-2.5 w-2.5',
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
  };
  if (status === 'active') {
    return (
      <svg {...common} strokeWidth={3.5} strokeLinecap="round" strokeLinejoin="round">
        <path d="M20 6L9 17l-5-5" />
      </svg>
    );
  }
  if (status === 'idle') {
    return (
      <svg {...common} strokeWidth={3} strokeLinecap="round">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8v4l3 2" />
      </svg>
    );
  }
  return (
    <svg {...common} strokeWidth={3.5} strokeLinecap="round">
      <path d="M6 12h12" />
    </svg>
  );
}

function Avatar({ employee, status }: { employee: OrgEmployeeDto; status: ActivityStatus }) {
  if (status === 'vacancy') {
    return (
      <span
        aria-hidden="true"
        className="grid h-9 w-9 flex-shrink-0 place-items-center rounded-full border border-dashed border-indigo-300 bg-indigo-50 text-indigo-500"
      >
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          <rect x="3" y="7" width="18" height="13" rx="2" />
          <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
        </svg>
      </span>
    );
  }
  const departed = status === 'departed';
  return (
    <span className="relative flex-shrink-0">
      <span
        aria-hidden="true"
        className={[
          'grid h-9 w-9 place-items-center rounded-full text-[13px] font-semibold text-white ring-offset-1 ring-offset-surface-1',
          RING_CLASS[status],
          departed ? 'opacity-50 grayscale' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        style={{ backgroundColor: avatarColor(employee.name) }}
      >
        {getInitials(employee.name)}
      </span>
      {!departed && (
        <span
          className={`absolute -bottom-0.5 -right-0.5 grid h-3.5 w-3.5 place-items-center rounded-full text-white ring-2 ring-surface-1 ${DOT_CLASS[status]}`}
        >
          <StatusGlyph status={status} />
        </span>
      )}
    </span>
  );
}

/** 8-week commit-heat sparkbar. Bar height scales to the person's own peak week;
 *  empty weeks render as a faint baseline tick so the cadence gap is visible. */
function Heat({ heat, status }: { heat: number[]; status: ActivityStatus }) {
  const peak = Math.max(1, ...heat);
  const barColor = status === 'idle' ? 'bg-amber-400' : 'bg-emerald-500';
  return (
    <span
      className="inline-flex h-3.5 items-end gap-[2px]"
      title={`Commits per week, last ${heat.length} weeks`}
      aria-label={`Commit activity, last ${heat.length} weeks`}
    >
      {heat.map((count, i) => {
        const h = count === 0 ? 3 : 4 + Math.round((count / peak) * 8);
        return (
          <span
            key={i}
            className={`w-[3px] rounded-sm ${count === 0 ? 'bg-slate-200' : barColor}`}
            style={{ height: `${h}px` }}
          />
        );
      })}
    </span>
  );
}

const CHIP_BASE =
  'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium';

/** Leaderboard rank badge: medal + #rank for the podium, percentile pills otherwise. */
function RankBadge({ ranking }: { ranking: NonNullable<OrgEmployeeDto['ranking']> }) {
  const view = rankBadgeView(ranking);
  return (
    <span
      className={`${CHIP_BASE} ${view.className}`}
      title={`Rank ${ranking.rank} of ${ranking.totalRanked} · score ${ranking.score}`}
      aria-label={`Contribution rank ${ranking.rank} of ${ranking.totalRanked}`}
    >
      {view.emoji && <span aria-hidden="true">{view.emoji}</span>}
      {view.label}
    </span>
  );
}

export function OrgEmployeeNode({
  employee,
  orgTreeId,
  childrenNodes,
  employees,
  onRefresh,
  onSelectEmployee,
  leading,
  now,
}: OrgEmployeeNodeProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeAction, setActiveAction] = useState<MenuAction>(null);
  const [renameValue, setRenameValue] = useState(employee.name);
  const [isPending, startTransition] = useTransition();
  const menuRef = useRef<HTMLDivElement>(null);

  const status = deriveActivityStatus(employee, now);
  const activityLabel = formatActivityLabel(status, employee.lastContributionAt, now);
  // Sparkbar only for real people with a signal, and only when some week is non-zero.
  const heat =
    (status === 'active' || status === 'idle') && (employee.stats?.heat?.some((c) => c > 0) ?? false)
      ? employee.stats!.heat!
      : null;

  const nameClass =
    status === 'departed'
      ? 'text-slate-400 line-through'
      : status === 'vacancy'
        ? 'italic text-indigo-700'
        : status === 'none'
          ? 'text-slate-500'
          : 'text-slate-800';

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  const handleRename = (e: React.FormEvent) => {
    e.preventDefault();
    const name = renameValue.trim();
    if (!name || name === employee.name) {
      setActiveAction(null);
      return;
    }
    startTransition(async () => {
      await updateEmployee(employee.id, { name });
      setActiveAction(null);
      onRefresh?.();
    });
  };

  const handleDelete = () => {
    if (!confirm(buildDeleteConfirmMessage(employees ?? [employee], employee.id))) return;
    startTransition(async () => {
      await deleteEmployee(employee.id);
      onRefresh?.();
    });
  };

  const boards = splitBoardChips(employee.isVacancy ? [] : (employee.stats?.boards ?? []));

  return (
    <div data-testid="org-node" className="mt-2">
      <div
        data-status={status}
        className="group flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2.5 shadow-sm transition-shadow hover:border-slate-300 hover:shadow-md"
      >
        <div className="flex w-4 flex-shrink-0 justify-center">{leading}</div>

        <Avatar employee={employee} status={status} />

        <div className="min-w-0 flex-1">
          {/* Name row — inline rename mode */}
          {activeAction === 'rename' ? (
            <form onSubmit={handleRename} className="flex items-center gap-1">
              <input
                autoFocus
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setActiveAction(null);
                }}
                className="rounded border border-indigo-300 px-1.5 py-0.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
              />
              <button
                type="submit"
                disabled={isPending}
                className="text-xs text-indigo-600 hover:underline disabled:opacity-50"
              >
                Save
              </button>
              <button
                type="button"
                onClick={() => setActiveAction(null)}
                className="text-xs text-gray-400 hover:underline"
              >
                Cancel
              </button>
            </form>
          ) : (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <button
                type="button"
                onClick={() => onSelectEmployee?.(employee.id)}
                className={`truncate text-left text-[14.5px] font-semibold tracking-tight hover:underline ${nameClass}`}
              >
                {employee.name}
              </button>
              {employee.role && <span className="text-[12.5px] text-slate-500">{employee.role}</span>}
            </div>
          )}

          {/* Meta line: location · activity */}
          {activeAction !== 'rename' && (
            <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs">
              {!employee.isVacancy && employee.location && (
                <span className="inline-flex items-center gap-1 text-slate-400">
                  <svg
                    className="h-3 w-3"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path d="M12 21s-6-5.3-6-10a6 6 0 0 1 12 0c0 4.7-6 10-6 10z" />
                    <circle cx="12" cy="11" r="2" />
                  </svg>
                  {employee.location}
                </span>
              )}
              {status === 'vacancy' ? (
                <span className="text-slate-400">Open role · not yet filled</span>
              ) : status === 'departed' ? (
                <span className="text-slate-400">Left the org · reports reassigned</span>
              ) : (
                activityLabel && (
                  <span className="inline-flex items-center gap-2">
                    <span
                      className={
                        status === 'idle'
                          ? 'font-medium text-amber-600'
                          : status === 'active'
                            ? 'font-medium text-slate-600'
                            : 'text-slate-400'
                      }
                    >
                      {activityLabel}
                    </span>
                    {heat && <Heat heat={heat} status={status} />}
                  </span>
                )
              )}
            </div>
          )}
        </div>

        {/* Chip rail. Must stay shrinkable and width-capped: it shares the row with the
            name/meta column, which indentation already narrows at depth. */}
        <div
          data-testid="node-chips"
          className="flex min-w-0 max-w-[55%] flex-wrap items-center justify-end gap-1.5"
        >
          {!employee.isVacancy && !employee.isDeparted && employee.ranking && (
            <RankBadge ranking={employee.ranking} />
          )}
          {employee.isVacancy && (
            <span className={`${CHIP_BASE} border-indigo-200 bg-indigo-50 italic text-indigo-700`}>
              open position
            </span>
          )}
          {employee.isDeparted && (
            <span className={`${CHIP_BASE} border-slate-200 bg-slate-50 text-slate-400`}>
              Departed
            </span>
          )}
          {!employee.isVacancy && employee.employeeType === 'CONTRACTOR' && (
            <span className={`${CHIP_BASE} border-amber-200 bg-amber-50 text-amber-700`}>
              Contractor
            </span>
          )}
          {employee.hasAssignment && (
            <span className={`${CHIP_BASE} border-emerald-200 bg-emerald-50 text-emerald-700`}>
              assigned
            </span>
          )}
          {boards.visible.map((b) => (
            <Link
              key={b.boardId}
              href={`/?boardId=${b.boardId}`}
              title={b.boardName}
              className={`${CHIP_BASE} max-w-[9rem] border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100`}
            >
              <svg
                className="h-3 w-3 flex-shrink-0"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
              >
                <rect x="3" y="4" width="18" height="16" rx="2" />
                <path d="M3 9h18" />
              </svg>
              <span className="truncate">{b.boardName}</span>
            </Link>
          ))}
          {boards.hiddenCount > 0 && (
            <span
              title={boards.hiddenLabel}
              className={`${CHIP_BASE} border-slate-200 bg-slate-50 text-slate-500`}
            >
              +{boards.hiddenCount}
            </span>
          )}
        </div>

        {/* Action menu */}
        <div ref={menuRef} className="relative flex-shrink-0">
          <button
            aria-label="Node actions"
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen((o) => !o);
            }}
            className="grid h-7 w-7 place-items-center rounded-lg text-slate-300 opacity-0 transition hover:bg-slate-100 hover:text-slate-600 focus:opacity-100 group-hover:opacity-100"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="5" cy="12" r="1.6" />
              <circle cx="12" cy="12" r="1.6" />
              <circle cx="19" cy="12" r="1.6" />
            </svg>
          </button>

          {menuOpen && (
            <div className="absolute right-0 top-8 z-20 w-36 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-lg">
              <button
                className="block w-full px-3 py-1.5 text-left text-sm text-gray-700 hover:bg-gray-50"
                onClick={() => {
                  setMenuOpen(false);
                  setActiveAction('add');
                }}
              >
                Add report
              </button>
              <button
                className="block w-full px-3 py-1.5 text-left text-sm text-gray-700 hover:bg-gray-50"
                onClick={() => {
                  setMenuOpen(false);
                  setRenameValue(employee.name);
                  setActiveAction('rename');
                }}
              >
                Rename
              </button>
              <button
                className="block w-full px-3 py-1.5 text-left text-sm text-red-600 hover:bg-red-50"
                onClick={() => {
                  setMenuOpen(false);
                  handleDelete();
                }}
              >
                Delete
              </button>
            </div>
          )}
        </div>
      </div>

      {childrenNodes}

      {activeAction === 'add' && orgTreeId && (
        <AddEmployeeDialog
          orgTreeId={orgTreeId}
          managerId={employee.id}
          onClose={() => setActiveAction(null)}
          onCreated={() => onRefresh?.()}
        />
      )}
    </div>
  );
}

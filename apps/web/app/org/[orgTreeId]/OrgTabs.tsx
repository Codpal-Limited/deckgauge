'use client';

import { useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type {
  AccessRoleValue,
  OrgTreeDto,
  EmployeeBoardSummaryDto,
  EmployeeBoardDetailDto,
} from '@deckgauge/shared';
import { canEditEntity, canManageEntity } from '@deckgauge/shared';
import { OrgTreeView } from './OrgTreeView';
import { EmployeeBoardCanvas } from './EmployeeBoardCanvas';
import { EmployeeDetailDrawer } from './EmployeeDetailDrawer';
import { createEmployeeBoard, getEmployeeBoard } from '../../actions/employee-boards';
import dynamic from 'next/dynamic';
import { SourceTab } from './SourceTab';
import { EmployeeBoardShareControls } from './EmployeeBoardShareControls';

// Lazy-loaded: the timesheet/report views pull in recharts, so defer that bundle
// until a user actually opens the Timesheet or Report tab (keeps the default
// Org Chart view light).
const OrgTimesheetTab = dynamic(
  () => import('./OrgTimesheetTab').then((m) => m.OrgTimesheetTab),
  { loading: () => <div className="py-8 text-center text-gray-400">Loading timesheet…</div> },
);

type OrgLevelTab = 'chart' | 'timesheet' | 'report' | 'source';

/** Tabs reachable via ?tab= deep links (e.g. the sidebar Timesheets shortcut). */
const DEEP_LINK_TABS: OrgLevelTab[] = ['timesheet', 'report', 'source'];

const TAB_BASE =
  'group relative flex items-center gap-1.5 pl-3 pr-3 py-2 text-[13px] cursor-pointer rounded-t-md border transition-colors';
const TAB_ACTIVE =
  'bg-white text-indigo-600 font-semibold border-slate-200 border-b-white -mb-px z-10';
const TAB_INACTIVE = 'text-slate-500 hover:text-slate-700 hover:bg-slate-50 border-transparent';

function TableIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="currentColor">
      <path
        fillRule="evenodd"
        d="M.99 5.24A2.25 2.25 0 0 1 3.25 3h13.5A2.25 2.25 0 0 1 19 5.25v9.5A2.25 2.25 0 0 1 16.75 17H3.25A2.25 2.25 0 0 1 1 14.75v-9.5Zm1.5 0v2.5h15v-2.5a.75.75 0 0 0-.75-.75H3.25a.75.75 0 0 0-.75.75Zm15 4h-15v5.5c0 .41.34.75.75.75h13.5a.75.75 0 0 0 .75-.75v-5.5Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

export function OrgTabs({
  tree,
  boards,
  treeRole = null,
}: {
  tree: OrgTreeDto;
  boards: EmployeeBoardSummaryDto[];
  /**
   * The caller's effective role on the TREE, which is a different question from
   * their role on any board inside it (design D12). `null` means they reached
   * this page through D14's second branch — a grant on a board, not the tree —
   * so the tree-level tabs are not theirs and rendering them would produce tabs
   * that 403 on click.
   */
  treeRole?: AccessRoleValue | null;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Open the Source tab directly when the URL requests it (?tab=source) — e.g. a
  // deep link into a tree's Source/connection settings.
  const requestedTab = searchParams.get('tab') as OrgLevelTab | null;
  const canSeeTree = treeRole !== null;
  // Source is OWNER-tier because GET /org-trees/:id/source is orgTree(OWNER);
  // creating a board is EDITOR-tier (POST /org-trees/:treeId/employee-boards).
  const canSeeSource = canManageEntity(treeRole);
  const canCreateBoard = canEditEntity(treeRole);

  const [orgTab, setOrgTab] = useState<OrgLevelTab>(
    requestedTab && DEEP_LINK_TABS.includes(requestedTab) && canSeeTree ? requestedTab : 'chart',
  );
  // A board-only grantee has no chart to land on, so the shell opens on the
  // first board they can actually see. Without this they would arrive at an
  // empty page with every tab hidden.
  const [activeBoardId, setActiveBoardId] = useState<string | null>(
    canSeeTree ? null : (boards[0]?.id ?? null),
  );
  const [boardDetail, setBoardDetail] = useState<EmployeeBoardDetailDto | null>(null);
  const [chartSelectedId, setChartSelectedId] = useState<string | null>(null);

  const canSeeSalary = tree.employees.some((e) => e.salaryCurrent !== undefined);

  useEffect(() => {
    if (!activeBoardId) {
      setBoardDetail(null);
      return;
    }
    let cancelled = false;
    getEmployeeBoard(activeBoardId).then((d) => {
      if (!cancelled) setBoardDetail(d);
    });
    return () => {
      cancelled = true;
    };
  }, [activeBoardId]);

  const reloadBoard = () => {
    router.refresh();
    if (activeBoardId) getEmployeeBoard(activeBoardId).then(setBoardDetail);
  };

  const newBoard = async () => {
    const name = window.prompt('New board name?');
    if (!name) return;
    const created = await createEmployeeBoard(tree.id, { name, scopeEmployeeId: null });
    if (created) {
      router.refresh();
      setActiveBoardId(created.id);
    }
  };

  const chartSelected = tree.employees.find((e) => e.id === chartSelectedId) ?? null;

  return (
    <div>
      <div
        role="tablist"
        className="mb-4 flex flex-wrap items-end gap-0 pl-4 pr-4 bg-white border-b border-slate-200"
      >
        {canSeeTree && (() => {
          const active = !activeBoardId && orgTab === 'chart';
          return (
            <div
              role="tab"
              aria-selected={active}
              tabIndex={0}
              className={`${TAB_BASE} ${active ? TAB_ACTIVE : TAB_INACTIVE}`}
              onClick={() => {
                setActiveBoardId(null);
                setOrgTab('chart');
              }}
            >
              <TableIcon
                className={`w-3.5 h-3.5 ${active ? 'text-indigo-500' : 'text-slate-400'}`}
              />
              <span>Org Chart</span>
            </div>
          );
        })()}

        {boards.map((b) => {
          const active = activeBoardId === b.id;
          return (
            <div
              key={b.id}
              role="tab"
              aria-selected={active}
              tabIndex={0}
              className={`${TAB_BASE} ${active ? TAB_ACTIVE : TAB_INACTIVE}`}
              onClick={() => setActiveBoardId(b.id)}
            >
              <TableIcon
                className={`w-3.5 h-3.5 ${active ? 'text-indigo-500' : 'text-slate-400'}`}
              />
              <span className="truncate max-w-[120px]">{b.name}</span>
            </div>
          );
        })}

        {canSeeTree && (['timesheet', 'report'] as const).map((t) => {
          const active = !activeBoardId && orgTab === t;
          return (
            <div
              key={t}
              role="tab"
              aria-selected={active}
              tabIndex={0}
              className={`${TAB_BASE} ${active ? TAB_ACTIVE : TAB_INACTIVE}`}
              onClick={() => {
                setActiveBoardId(null);
                setOrgTab(t);
              }}
            >
              <span>{t === 'timesheet' ? 'Timesheet' : 'Report'}</span>
            </div>
          );
        })}

        {canSeeTree && (
          <div
            role="tab"
            aria-selected={false}
            aria-disabled={true}
            className={`${TAB_BASE} ${TAB_INACTIVE} cursor-not-allowed opacity-40`}
            title="Coming soon"
          >
            <span>Vacation Planner</span>
          </div>
        )}
        {canSeeSource && (() => {
          const active = !activeBoardId && orgTab === 'source';
          return (
            <div
              role="tab"
              aria-selected={active}
              tabIndex={0}
              className={`${TAB_BASE} ${active ? TAB_ACTIVE : TAB_INACTIVE}`}
              onClick={() => {
                setActiveBoardId(null);
                setOrgTab('source');
              }}
            >
              <span>Source</span>
            </div>
          );
        })()}

        <div className="ml-auto mb-1 flex items-center gap-2">
          {/* Per-board sharing — a second, independent decision from the
              tree's (design D12). Only while a board is open: it is about
              THAT board, not the tree. */}
          {activeBoardId && (
            <EmployeeBoardShareControls
              key={activeBoardId}
              boardId={activeBoardId}
              boardName={boards.find((b) => b.id === activeBoardId)?.name ?? 'board'}
            />
          )}
          {canCreateBoard && (
            <button
              type="button"
              onClick={newBoard}
              className="flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-[13px] text-slate-600 hover:bg-slate-50"
            >
              ＋ New board
            </button>
          )}
        </div>
      </div>

      {activeBoardId ? (
        boardDetail ? (
          <EmployeeBoardCanvas
            key={activeBoardId}
            board={boardDetail}
            allEmployees={tree.employees}
            canSeeSalary={canSeeSalary}
            onChanged={reloadBoard}
          />
        ) : (
          <div className="py-8 text-center text-gray-400">Loading board…</div>
        )
      ) : orgTab === 'timesheet' ? (
        <OrgTimesheetTab treeId={tree.id} treeName={tree.name} variant="grid" />
      ) : orgTab === 'report' ? (
        <OrgTimesheetTab treeId={tree.id} treeName={tree.name} variant="report" />
      ) : orgTab === 'source' ? (
        <SourceTab treeId={tree.id} />
      ) : (
        <>
          <OrgTreeView tree={tree} onSelectEmployee={setChartSelectedId} />
          {chartSelected && (
            <EmployeeDetailDrawer
              employee={chartSelected}
              canEditSalary={canSeeSalary}
              onClose={() => setChartSelectedId(null)}
              onSaved={() => router.refresh()}
            />
          )}
        </>
      )}
    </div>
  );
}

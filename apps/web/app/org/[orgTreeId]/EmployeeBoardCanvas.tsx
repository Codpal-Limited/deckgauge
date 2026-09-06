'use client';

import { useState, useTransition, useMemo, useEffect, useRef, useCallback } from 'react';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GroupHeader, BoardShell, CommentBadge } from '@deckgauge/ui';
import type { ShellColumn } from '@deckgauge/ui';
import type {
  EmployeeBoardDetailDto,
  OrgEmployeeDto,
  UpdateEmployeeProfileInput,
  EmployeeColumnDto,
} from '@deckgauge/shared';
import {
  sortEmployeeRows,
  filterEmployeeRows,
  searchEmployeeRows,
  resolveColumns,
  type EmployeeSortConfig,
  type EmployeeFilterRule,
  type EmployeeBoardColumnKey,
} from '@deckgauge/shared';
import { SearchBar } from '../../components/SearchBar';
import { EmployeeSortPanel } from './EmployeeSortPanel';
import { EmployeeFilterPanel } from './EmployeeFilterPanel';
import { updateEmployee } from '../../actions/org-trees';
import { getEmployeeCommentCounts } from '../../actions/employee-comments';
import {
  moveBoardMember,
  removeBoardMember,
  reorderEmployeeGroups,
  createEmployeeGroup,
  updateEmployeeGroup,
  deleteEmployeeGroup,
  setEmployeeBoardColumns,
  setEmployeeFieldValue,
  setEmployeeManager,
} from '../../actions/employee-boards';
import { AddToBoardControls } from './AddToBoardControls';
import { EmployeeDetailDrawer } from './EmployeeDetailDrawer';
import { EmployeeColumnManager, COLUMN_LABELS } from './EmployeeColumnManager';
import { resolveEmployeeColumnWidth } from './employee-grid-template';
import { renderEmployeeCell, isBuiltInColumn } from './EmployeeBoardRow';
import { EmployeeColumnSummaryRow } from './EmployeeColumnSummaryRow';
import { makeEmployeeShellRow } from './EmployeeShellRow';
import { EmployeeBulkActionBar } from './EmployeeBulkActionBar';
import { resolveBulkTargets } from '../../utils/bulk-selection';

type BoardMember = EmployeeBoardDetailDto['groups'][number]['members'][number];

// ---------------------------------------------------------------------------
// Pure DnD helper (exported for testing)
// ---------------------------------------------------------------------------

export interface MemberDrop {
  memberId: string;
  employeeGroupId: string;
  position: number;
}

/**
 * Resolve a dnd-kit sortable drag-end into a member move with a precise target
 * position. `groups` carries each group's ordered member ids. The drag can end
 * over another member (`mem-…`) — insert at that member's slot — or over a group
 * zone (`grp-…`, e.g. an empty group) — append to the end. Returns null when the
 * active isn't a member or the target can't be resolved.
 *
 * `position` is the index among the target group's members EXCLUDING the moved
 * member, matching the server's moveMember (which re-inserts into siblings).
 */
export function resolveMemberSortDrop(
  groups: { id: string; memberIds: string[] }[],
  activeId: string,
  overId: string
): MemberDrop | null {
  if (!activeId.startsWith('mem-')) return null;
  const memberId = activeId.slice('mem-'.length);

  if (overId.startsWith('grp-')) {
    const employeeGroupId = overId.slice('grp-'.length);
    const group = groups.find((g) => g.id === employeeGroupId);
    if (!group) return null;
    const position = group.memberIds.filter((id) => id !== memberId).length; // append
    return { memberId, employeeGroupId, position };
  }

  if (overId.startsWith('mem-')) {
    const overMemberId = overId.slice('mem-'.length);
    if (overMemberId === memberId) return null;
    const group = groups.find((g) => g.memberIds.includes(overMemberId));
    if (!group) return null;
    const siblings = group.memberIds.filter((id) => id !== memberId);
    const position = siblings.indexOf(overMemberId); // insert before the over member
    return { memberId, employeeGroupId: group.id, position };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Collision strategy: closest-corners for both member and group sortable drags.
// A group-header drag is biased to the nearest group item (grpHdr-) so sibling
// groups animate as it reorders; member drags resolve to the nearest member/zone.
// ---------------------------------------------------------------------------

const collisionDetection: CollisionDetection = (args) => {
  const hits = closestCorners(args);
  if (String(args.active.id).startsWith('grpHdr-')) {
    const grpHdrHit = hits.find((c) => String(c.id).startsWith('grpHdr-'));
    if (grpHdrHit) return [grpHdrHit];
  }
  return hits;
};

// ---------------------------------------------------------------------------
// Droppable group container (grid card)
// ---------------------------------------------------------------------------

interface DroppableGroupProps {
  group: EmployeeBoardDetailDto['groups'][number];
  renderedMembers: EmployeeBoardDetailDto['groups'][number]['members'];
  visibleColumns: string[];
  allEmployees: OrgEmployeeDto[];
  dragDisabled: boolean;
  onOpen: (employeeId: string) => void;
  onBlur: (employeeId: string, key: string, value: string) => void;
  onSalaryBlur: (employeeId: string, value: string) => void;
  onChanged: () => void;
  onCustomSave: (employeeId: string, columnId: string, value: string) => void;
  dragHandleProps: Record<string, unknown>;
  columnsById: Map<string, EmployeeColumnDto>;
  sort: { key: string; direction: 'asc' | 'desc' } | null;
  onSort: (key: string) => void;
  collapsed: boolean;
  onToggleCollapse: (groupId: string) => void;
  selectedMembers: Set<string>;
  onSelect: (memberId: string, selected: boolean) => void;
  onToggleVisibleSelect: (memberIds: string[], select: boolean) => void;
  groupSelectionState: (memberIds: string[]) => 'none' | 'some' | 'all';
  commentCounts: Record<string, number>;
  onOpenComments: (employeeId: string) => void;
  onOpenRanking: (employeeId: string) => void;
  bulkNonce: number;
  onManagerChange: (employeeId: string, managerId: string | null) => void;
  columnWidths: Record<string, number>;
  onColumnResize: (key: string, width: number) => void;
}

function DroppableGroup({
  group,
  renderedMembers,
  visibleColumns,
  allEmployees,
  dragDisabled,
  onOpen,
  onBlur,
  onSalaryBlur,
  onChanged,
  onCustomSave,
  dragHandleProps,
  columnsById,
  columnWidths,
  onColumnResize,
  sort,
  onSort,
  collapsed,
  onToggleCollapse,
  selectedMembers,
  onSelect,
  onToggleVisibleSelect,
  groupSelectionState,
  commentCounts,
  onOpenComments,
  onOpenRanking,
  bulkNonce,
  onManagerChange,
}: DroppableGroupProps) {
  const { setNodeRef, isOver } = useDroppable({ id: `grp-${group.id}` });
  const [, startTransition] = useTransition();

  const visibleMemberIds = renderedMembers.map((m) => m.id);

  const shellColumns: ShellColumn[] = visibleColumns.map((key) => ({
    key,
    label: isBuiltInColumn(key)
      ? COLUMN_LABELS[key as EmployeeBoardColumnKey]
      : (columnsById.get(key)?.name ?? key),
    width: resolveEmployeeColumnWidth(key, columnWidths),
    sortable: true,
    ...(key === 'name' ? { flex: 1, pinned: true, align: 'left' as const } : {}),
  }));

  // Bake dragDisabled into the row wrapper; memoize so its identity is stable
  // (only changes when a sort toggles drag on/off).
  const RowComponent = useMemo(() => makeEmployeeShellRow(dragDisabled), [dragDisabled]);

  const renderCell = (m: BoardMember, key: string) => {
    if (key === 'name') {
      return (
        <div className="flex items-center gap-2 min-w-0">
          <button
            type="button"
            aria-label={`Open ${m.employee.name}`}
            onClick={() => onOpen(m.employee.id)}
            className="min-w-0 flex-1 truncate text-left font-medium text-slate-800 hover:text-indigo-600"
          >
            {m.employee.name}
          </button>
          <CommentBadge
            count={commentCounts[m.employee.id] ?? 0}
            onClick={() => onOpenComments(m.employee.id)}
          />
        </div>
      );
    }
    return renderEmployeeCell(
      key,
      m,
      allEmployees,
      onBlur,
      onSalaryBlur,
      onChanged,
      columnsById,
      onCustomSave,
      onManagerChange,
      onOpenRanking
    );
  };

  return (
    <div
      ref={setNodeRef}
      className={isOver ? 'ring-2 ring-indigo-300 ring-offset-1 rounded-md' : ''}
    >
      <div className="flex items-center gap-1 px-1 pb-1">
        <button
          type="button"
          className="flex items-center justify-center w-5 h-7 shrink-0 text-slate-300 hover:text-slate-500 cursor-grab active:cursor-grabbing transition-colors"
          aria-label="Drag to reorder group"
          {...dragHandleProps}
        >
          <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor">
            <circle cx="3" cy="2" r="1.2" />
            <circle cx="7" cy="2" r="1.2" />
            <circle cx="3" cy="7" r="1.2" />
            <circle cx="7" cy="7" r="1.2" />
            <circle cx="3" cy="12" r="1.2" />
            <circle cx="7" cy="12" r="1.2" />
          </svg>
        </button>
        <GroupHeader
          title={group.name}
          count={group.members.length}
          collapsed={collapsed}
          onToggle={() => onToggleCollapse(group.id)}
          color={group.color}
          onRename={(name) =>
            startTransition(async () => {
              await updateEmployeeGroup(group.id, { name });
              onChanged();
            })
          }
          onColorChange={(color) =>
            startTransition(async () => {
              await updateEmployeeGroup(group.id, { color });
              onChanged();
            })
          }
          onDelete={() =>
            startTransition(async () => {
              await deleteEmployeeGroup(group.id);
              onChanged();
            })
          }
        />
      </div>

      {!collapsed && (
        <SortableContext
          items={renderedMembers.map((m) => `mem-${m.id}`)}
          strategy={verticalListSortingStrategy}
        >
          <BoardShell<BoardMember>
            columns={shellColumns}
            rows={renderedMembers}
            rowKey={(m) => m.id}
            rowRenderKey={(m) => `${m.id}:${bulkNonce}`}
            renderCell={renderCell}
            RowComponent={RowComponent}
            groupColor={group.color}
            columnWidths={columnWidths}
            onColumnResize={onColumnResize}
            sort={sort}
            onSort={onSort}
            selection={{
              isSelected: (k) => selectedMembers.has(k),
              onToggle: (k, sel) => onSelect(k, sel),
              rowLabel: (k) =>
                `Select ${renderedMembers.find((m) => m.id === k)?.employee.name ?? k}`,
              selectAllState: groupSelectionState(visibleMemberIds),
              onSelectAll: (sel) => onToggleVisibleSelect(visibleMemberIds, sel),
            }}
            renderSummary={(members) => (
              <EmployeeColumnSummaryRow
                columns={visibleColumns}
                members={members}
                columnsById={columnsById}
                groupColor={group.color}
              />
            )}
            emptyLabel="No employees"
          />
        </SortableContext>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Draggable group header wrapper (for group reordering)
// ---------------------------------------------------------------------------

interface DraggableGroupProps {
  group: EmployeeBoardDetailDto['groups'][number];
  renderedMembers: EmployeeBoardDetailDto['groups'][number]['members'];
  visibleColumns: string[];
  allEmployees: OrgEmployeeDto[];
  boardId: string;
  dragDisabled: boolean;
  onOpen: (employeeId: string) => void;
  onBlur: (employeeId: string, key: string, value: string) => void;
  onSalaryBlur: (employeeId: string, value: string) => void;
  onChanged: () => void;
  onCustomSave: (employeeId: string, columnId: string, value: string) => void;
  columnsById: Map<string, EmployeeColumnDto>;
  sort: { key: string; direction: 'asc' | 'desc' } | null;
  onSort: (key: string) => void;
  collapsed: boolean;
  onToggleCollapse: (groupId: string) => void;
  selectedMembers: Set<string>;
  onSelect: (memberId: string, selected: boolean) => void;
  onToggleVisibleSelect: (memberIds: string[], select: boolean) => void;
  groupSelectionState: (memberIds: string[]) => 'none' | 'some' | 'all';
  commentCounts: Record<string, number>;
  onOpenComments: (employeeId: string) => void;
  onOpenRanking: (employeeId: string) => void;
  bulkNonce: number;
  onManagerChange: (employeeId: string, managerId: string | null) => void;
  columnWidths: Record<string, number>;
  onColumnResize: (key: string, width: number) => void;
}

function DraggableGroup({
  group,
  renderedMembers,
  visibleColumns,
  allEmployees,
  dragDisabled,
  onOpen,
  onBlur,
  onSalaryBlur,
  onChanged,
  onCustomSave,
  columnsById,
  sort,
  onSort,
  collapsed,
  onToggleCollapse,
  selectedMembers,
  onSelect,
  onToggleVisibleSelect,
  groupSelectionState,
  commentCounts,
  onOpenComments,
  onOpenRanking,
  bulkNonce,
  onManagerChange,
  columnWidths,
  onColumnResize,
}: DraggableGroupProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: `grpHdr-${group.id}`,
  });

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.4 : undefined,
      }}
    >
      <DroppableGroup
        group={group}
        renderedMembers={renderedMembers}
        visibleColumns={visibleColumns}
        allEmployees={allEmployees}
        dragDisabled={dragDisabled}
        onOpen={onOpen}
        onBlur={onBlur}
        onSalaryBlur={onSalaryBlur}
        onChanged={onChanged}
        onCustomSave={onCustomSave}
        dragHandleProps={{ ...attributes, ...listeners } as Record<string, unknown>}
        columnsById={columnsById}
        sort={sort}
        onSort={onSort}
        collapsed={collapsed}
        onToggleCollapse={onToggleCollapse}
        selectedMembers={selectedMembers}
        onSelect={onSelect}
        onToggleVisibleSelect={onToggleVisibleSelect}
        groupSelectionState={groupSelectionState}
        commentCounts={commentCounts}
        onOpenComments={onOpenComments}
        onOpenRanking={onOpenRanking}
        bulkNonce={bulkNonce}
        onManagerChange={onManagerChange}
        columnWidths={columnWidths}
        onColumnResize={onColumnResize}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bulk-edit constants
// ---------------------------------------------------------------------------

// Profile keys that fan out across a selection. Identity keys (email, phone,
// businessTitle) deliberately stay single-row — see the design spec.
const PROPAGATING_PROFILE_KEYS = new Set(['location', 'hireDate', 'employeeType', 'timeType']);

// ---------------------------------------------------------------------------
// Main canvas
// ---------------------------------------------------------------------------

interface Props {
  board: EmployeeBoardDetailDto;
  allEmployees: OrgEmployeeDto[];
  canSeeSalary: boolean;
  onChanged: () => void;
}

export function EmployeeBoardCanvas({ board, allEmployees, canSeeSalary, onChanged }: Props) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [commentCounts, setCommentCounts] = useState<Record<string, number>>({});
  const [openTab, setOpenTab] = useState<'updates' | 'profile' | 'activity' | 'ranking'>('profile');
  const [, startTransition] = useTransition();

  const memberEmployeeIds = useMemo(
    () => board.groups.flatMap((g) => g.members.map((m) => m.employee.id)),
    [board.groups]
  );

  useEffect(() => {
    let cancelled = false;
    getEmployeeCommentCounts(memberEmployeeIds)
      .then((c) => {
        if (!cancelled) setCommentCounts(c);
      })
      .catch(() => {
        if (!cancelled) setCommentCounts({});
      });
    return () => {
      cancelled = true;
    };
  }, [memberEmployeeIds]);

  const openProfile = (employeeId: string) => {
    setOpenTab('profile');
    setOpenId(employeeId);
  };
  const openComments = (employeeId: string) => {
    setOpenTab('updates');
    setOpenId(employeeId);
  };
  const openRanking = (employeeId: string) => {
    setOpenTab('ranking');
    setOpenId(employeeId);
  };

  // Query controls state (ephemeral — not persisted)
  const [sort, setSort] = useState<EmployeeSortConfig | null>(null);
  const [filterRules, setFilterRules] = useState<EmployeeFilterRule[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [openPanel, setOpenPanel] = useState<'sort' | 'filter' | 'columns' | null>(null);

  // Selection + collapse state
  const [selectedMembers, setSelectedMembers] = useState<Set<string>>(new Set());
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [bulkNonce, setBulkNonce] = useState(0);
  const [bulkNotice, setBulkNotice] = useState<string | null>(null);

  // Per-column widths (Monday-style resize). Seeded once from the persisted
  // config; the canvas is remounted per board (keyed in OrgTabs) so this never
  // leaks across boards. Live state drives the grid template; the server write
  // is debounced so one drag produces a single PATCH, not dozens.
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>(
    () => board.columnConfig?.widths ?? {}
  );
  const widthSaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingWidths = useRef<Record<string, number> | null>(null);

  const handleColumnResize = useCallback(
    (key: string, width: number) => {
      setColumnWidths((prev) => {
        const next = { ...prev, [key]: width };
        pendingWidths.current = next;
        return next;
      });
      clearTimeout(widthSaveTimer.current);
      widthSaveTimer.current = setTimeout(() => {
        if (!pendingWidths.current) return;
        void setEmployeeBoardColumns(board.id, {
          order: board.columnConfig?.order ?? [],
          hidden: board.columnConfig?.hidden ?? [],
          widths: pendingWidths.current,
        });
      }, 500);
    },
    [board.id, board.columnConfig]
  );

  useEffect(() => () => clearTimeout(widthSaveTimer.current), []);

  // Two id namespaces used in this component:
  //   member id   — board-membership row id (what selectedMembers / resolveBulkTargets use)
  //   employee id — org-employee id (what updateEmployee / the server takes)
  // Both maps are built once per board.groups change and shared by applyToSelection.
  const { employeeIdToMemberId, memberIdToEmployeeId } = useMemo(() => {
    const empToMem = new Map<string, string>();
    const memToEmp = new Map<string, string>();
    for (const g of board.groups)
      for (const mem of g.members) {
        empToMem.set(mem.employee.id, mem.id);
        memToEmp.set(mem.id, mem.employee.id);
      }
    return { employeeIdToMemberId: empToMem, memberIdToEmployeeId: memToEmp };
  }, [board.groups]);

  // Translate an edited employee id into the full list of employee ids to apply
  // a bulk edit to. Handles the member-id ↔ employee-id namespace translation.
  const resolveTargetEmployeeIds = (editedEmployeeId: string): string[] => {
    const editedMemberId = employeeIdToMemberId.get(editedEmployeeId) ?? editedEmployeeId;
    const memberIds = resolveBulkTargets(editedMemberId, selectedMembers);
    return memberIds.map((mid) => memberIdToEmployeeId.get(mid) ?? mid);
  };

  // Fan an inline edit out to the whole selection when the edited row is part of
  // a 2+ selection; otherwise apply to just that row. One refetch after the loop.
  // Bumps bulkNonce on a true multi-target apply so rows remount and uncontrolled
  // inputs (location/hireDate/salary) pick up the refetched values.
  const applyToSelection = (editedEmployeeId: string, run: (id: string) => Promise<unknown>) => {
    setBulkNotice(null);
    const employeeIds = resolveTargetEmployeeIds(editedEmployeeId);
    if (employeeIds.length === 0) return;
    startTransition(async () => {
      for (const id of employeeIds) await run(id);
      onChanged();
      if (employeeIds.length > 1) setBulkNonce((n) => n + 1);
    });
  };

  const toggleSelect = (memberId: string, selected: boolean) => {
    setSelectedMembers((prev) => {
      const next = new Set(prev);
      if (selected) next.add(memberId);
      else next.delete(memberId);
      return next;
    });
  };

  const toggleVisibleSelect = (memberIds: string[], select: boolean) => {
    setSelectedMembers((prev) => {
      const next = new Set(prev);
      for (const id of memberIds) {
        if (select) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  };

  const groupSelectionState = (memberIds: string[]): 'none' | 'some' | 'all' => {
    if (memberIds.length === 0) return 'none';
    const n = memberIds.filter((id) => selectedMembers.has(id)).length;
    if (n === 0) return 'none';
    return n === memberIds.length ? 'all' : 'some';
  };

  const toggleCollapse = (groupId: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

  const addGroup = () => {
    startTransition(async () => {
      await createEmployeeGroup(board.id, { name: 'New group' });
      onChanged();
    });
  };

  // Sort handler: builds EmployeeSortConfig shape; maps to { key, direction } at call site
  const handleColumnSort = (key: string) => {
    setSort((prev) => {
      if (prev?.column === key)
        return prev.direction === 'asc' ? { column: key, direction: 'desc' } : null;
      return { column: key, direction: 'asc' };
    });
  };

  const bulkRemove = () => {
    const ids = [...selectedMembers];
    if (ids.length === 0) return;
    if (!window.confirm(`Remove ${ids.length} employee(s) from this board?`)) return;
    startTransition(async () => {
      for (const id of ids) await removeBoardMember(id);
      setSelectedMembers(new Set());
      onChanged();
    });
  };

  const bulkMove = (groupId: string) => {
    const ids = [...selectedMembers];
    if (ids.length === 0) return;
    const target = board.groups.find((g) => g.id === groupId);
    let pos = target ? target.members.length : 0;
    startTransition(async () => {
      for (const id of ids) {
        await moveBoardMember(id, { employeeGroupId: groupId, position: pos });
        pos += 1;
      }
      setSelectedMembers(new Set());
      onChanged();
    });
  };

  // Config-driven visible columns
  const columnsById = useMemo(() => new Map(board.columns.map((c) => [c.id, c])), [board.columns]);
  const visibleColumns = useMemo(
    () =>
      resolveColumns(
        board.columnConfig,
        board.columns.map((c) => c.id)
      ).filter((k) => canSeeSalary || k !== 'salary'),
    [board.columnConfig, board.columns, canSeeSalary]
  );

  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of allEmployees) m.set(e.id, e.name);
    for (const g of board.groups)
      for (const mem of g.members) m.set(mem.employee.id, mem.employee.name);
    return m;
  }, [allEmployees, board.groups]);
  const resolveManager = (managerId: string | null) =>
    managerId ? (nameById.get(managerId) ?? '') : '';

  const queryRows = (members: EmployeeBoardDetailDto['groups'][number]['members']) =>
    sortEmployeeRows(
      searchEmployeeRows(
        filterEmployeeRows(members, filterRules, resolveManager),
        searchQuery,
        resolveManager
      ),
      sort,
      resolveManager
    );

  // Only built-in columns for sort/filter panels (they require EmployeeBoardColumnKey)
  const builtInPanelColumns = visibleColumns
    .filter(isBuiltInColumn)
    .map((key) => ({ key, label: COLUMN_LABELS[key] }));

  const open =
    board.groups.flatMap((g) => g.members).find((m) => m.employee.id === openId)?.employee ?? null;

  const saveField = (employeeId: string, key: string, value: string) => {
    const patch = { [key]: value === '' ? null : value } as UpdateEmployeeProfileInput;
    if (PROPAGATING_PROFILE_KEYS.has(key)) {
      applyToSelection(employeeId, (id) => updateEmployee(id, patch));
      return;
    }
    startTransition(async () => {
      await updateEmployee(employeeId, patch);
      onChanged();
    });
  };

  const saveCustomField = (employeeId: string, columnId: string, value: string) => {
    applyToSelection(employeeId, (id) => setEmployeeFieldValue(columnId, id, value));
  };

  const saveSalary = (employeeId: string, value: string) => {
    const salaryCurrent = value === '' ? null : Number(value);
    applyToSelection(employeeId, (id) => updateEmployee(id, { salaryCurrent }));
  };

  const saveManager = (employeeId: string, managerId: string | null) => {
    const employeeIds = resolveTargetEmployeeIds(employeeId);
    if (employeeIds.length === 0) return;
    setBulkNotice(null);
    startTransition(async () => {
      let okCount = 0;
      let cycleCount = 0;
      for (const id of employeeIds) {
        const res = await setEmployeeManager(id, managerId);
        if (res.ok) okCount += 1;
        else if (res.cycle) cycleCount += 1;
      }
      onChanged();
      if (employeeIds.length > 1) {
        setBulkNonce((n) => n + 1);
        setBulkNotice(
          cycleCount > 0
            ? `Updated ${okCount} of ${employeeIds.length} — ${cycleCount} skipped (reporting cycle)`
            : null
        );
      }
    });
  };

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor)
  );

  // Id of the member being dragged, for the DragOverlay ghost.
  const [activeMemberId, setActiveMemberId] = useState<string | null>(null);
  const activeMember = activeMemberId
    ? (board.groups.flatMap((g) => g.members).find((m) => m.id === activeMemberId) ?? null)
    : null;

  const onDragStart = (e: DragStartEvent) => {
    const id = String(e.active.id);
    setActiveMemberId(id.startsWith('mem-') ? id.slice('mem-'.length) : null);
  };

  const onDragEnd = (e: DragEndEvent) => {
    setActiveMemberId(null);
    const activeId = String(e.active.id);
    const overId = e.over ? String(e.over.id) : null;
    if (!overId) return;

    // Member row dropped onto another member (reorder) or a group zone
    if (activeId.startsWith('mem-')) {
      const groups = board.groups.map((g) => ({ id: g.id, memberIds: g.members.map((m) => m.id) }));
      const drop = resolveMemberSortDrop(groups, activeId, overId);
      if (!drop) return;
      startTransition(async () => {
        await moveBoardMember(drop.memberId, {
          employeeGroupId: drop.employeeGroupId,
          position: drop.position,
        });
        onChanged();
      });
      return;
    }

    // Group header dragged → reorder groups. The over target may be another group
    // (grpHdr-), a group zone (grp-), or a member row (mem-) — resolve all to the
    // owning group id so a group drop anywhere over another group reorders.
    if (activeId.startsWith('grpHdr-')) {
      const activeGroupId = activeId.slice('grpHdr-'.length);
      const overGroupId = overId.startsWith('grpHdr-')
        ? overId.slice('grpHdr-'.length)
        : overId.startsWith('grp-')
          ? overId.slice('grp-'.length)
          : overId.startsWith('mem-')
            ? (board.groups.find((g) => g.members.some((m) => m.id === overId.slice('mem-'.length)))
                ?.id ?? null)
            : null;
      if (!overGroupId || activeGroupId === overGroupId) return;

      const order = board.groups.map((g) => g.id);
      const fromIdx = order.indexOf(activeGroupId);
      const toIdx = order.indexOf(overGroupId);
      if (fromIdx === -1 || toIdx === -1) return;

      const reordered = [...order];
      reordered.splice(fromIdx, 1);
      reordered.splice(toIdx, 0, activeGroupId);

      startTransition(async () => {
        await reorderEmployeeGroups(
          board.id,
          reordered.map((id, idx) => ({ id, position: idx }))
        );
        onChanged();
      });
    }
  };

  // Map EmployeeSortConfig → { key, direction } for BoardShell's header
  const headerSort = sort ? { key: sort.column, direction: sort.direction } : null;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setActiveMemberId(null)}
    >
      {bulkNotice && (
        <div
          role="status"
          className="mb-2 flex items-center justify-between rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800"
        >
          <span>{bulkNotice}</span>
          <button
            type="button"
            onClick={() => setBulkNotice(null)}
            aria-label="Dismiss"
            className="ml-3 text-amber-600 hover:text-amber-800"
          >
            ×
          </button>
        </div>
      )}

      {/* Controls bar */}
      <div className="mb-4 flex items-center gap-2">
        <SearchBar onSearch={setSearchQuery} inputAriaLabel="Search employees" />

        <div className="relative">
          <button
            type="button"
            onClick={() => setOpenPanel((p) => (p === 'filter' ? null : 'filter'))}
            className={`btn-secondary text-xs py-1.5 px-3 ${filterRules.length > 0 ? 'border-indigo-500 text-indigo-500' : ''}`}
          >
            Filter {filterRules.length > 0 && `(${filterRules.length})`}
          </button>
          {openPanel === 'filter' && (
            <div className="absolute left-0 top-9 z-30 w-72">
              <EmployeeFilterPanel
                columns={builtInPanelColumns}
                rules={filterRules}
                onChange={setFilterRules}
                onClose={() => setOpenPanel(null)}
              />
            </div>
          )}
        </div>

        <div className="relative">
          <button
            type="button"
            onClick={() => setOpenPanel((p) => (p === 'sort' ? null : 'sort'))}
            className={`btn-secondary text-xs py-1.5 px-3 ${sort ? 'border-indigo-500 text-indigo-500' : ''}`}
          >
            Sort {sort ? '(1)' : ''}
          </button>
          {openPanel === 'sort' && (
            <div className="absolute left-0 top-9 z-30 w-48">
              <EmployeeSortPanel
                columns={builtInPanelColumns}
                sort={sort}
                onChange={setSort}
                onClose={() => setOpenPanel(null)}
              />
            </div>
          )}
        </div>

        <div className="relative">
          <button
            type="button"
            onClick={() => setOpenPanel((p) => (p === 'columns' ? null : 'columns'))}
            className="btn-secondary text-xs py-1.5 px-3"
          >
            Columns
          </button>
          {openPanel === 'columns' && (
            <div className="absolute left-0 top-9 z-30 w-56">
              <EmployeeColumnManager
                boardId={board.id}
                columnConfig={board.columnConfig}
                canSeeSalary={canSeeSalary}
                columns={board.columns}
                onSave={(config) => {
                  startTransition(async () => {
                    await setEmployeeBoardColumns(board.id, { ...config, widths: columnWidths });
                    onChanged();
                  });
                }}
                onClose={() => setOpenPanel(null)}
                onColumnsChanged={onChanged}
              />
            </div>
          )}
        </div>
      </div>

      {/* Horizontal scroll container, mirroring the project board's GroupList:
          BoardShell cards are `w-max`, so without a scroller they spill past the
          page container instead of scrolling. */}
      <div className="space-y-6 overflow-x-auto pb-2">
        <SortableContext
          items={board.groups.map((g) => `grpHdr-${g.id}`)}
          strategy={verticalListSortingStrategy}
        >
          {board.groups.map((group) => (
            <DraggableGroup
              key={group.id}
              group={group}
              renderedMembers={queryRows(group.members)}
              visibleColumns={visibleColumns}
              allEmployees={allEmployees}
              boardId={board.id}
              dragDisabled={sort !== null}
              onOpen={openProfile}
              onBlur={saveField}
              onSalaryBlur={saveSalary}
              onChanged={onChanged}
              onCustomSave={saveCustomField}
              columnsById={columnsById}
              sort={headerSort}
              onSort={handleColumnSort}
              collapsed={collapsedGroups.has(group.id)}
              onToggleCollapse={toggleCollapse}
              selectedMembers={selectedMembers}
              onSelect={toggleSelect}
              onToggleVisibleSelect={toggleVisibleSelect}
              groupSelectionState={groupSelectionState}
              commentCounts={commentCounts}
              onOpenComments={openComments}
              onOpenRanking={openRanking}
              bulkNonce={bulkNonce}
              onManagerChange={saveManager}
              columnWidths={columnWidths}
              onColumnResize={handleColumnResize}
            />
          ))}
        </SortableContext>
        <button
          type="button"
          onClick={addGroup}
          className="flex w-full items-center gap-3 rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-500 transition-all duration-200 hover:border-slate-300 hover:text-slate-600"
        >
          + Add new group
        </button>
        <AddToBoardControls
          boardId={board.id}
          allEmployees={allEmployees}
          memberEmployeeIds={board.groups.flatMap((g) => g.members.map((m) => m.employee.id))}
          onChanged={onChanged}
        />
      </div>

      {selectedMembers.size > 0 && (
        <EmployeeBulkActionBar
          count={selectedMembers.size}
          groups={board.groups.map((g) => ({ id: g.id, name: g.name }))}
          onMoveToGroup={bulkMove}
          onRemove={bulkRemove}
          onClear={() => setSelectedMembers(new Set())}
        />
      )}

      {open && (
        <EmployeeDetailDrawer
          employee={open}
          canEditSalary={canSeeSalary}
          onClose={() => setOpenId(null)}
          onSaved={onChanged}
          defaultTab={openTab}
        />
      )}

      <DragOverlay>
        {activeMember ? (
          <div className="rounded-md border border-indigo-300 bg-white px-3 py-2 text-sm font-medium text-slate-800 shadow-lg">
            {activeMember.employee.name}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

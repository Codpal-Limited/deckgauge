'use client';

import {
  useState,
  useCallback,
  useTransition,
  useMemo,
  useEffect,
  useRef,
  useDeferredValue,
  type PointerEvent as ReactPointerEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import {
  DndContext,
  closestCorners,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
  DragOverlay,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { toast } from 'sonner';
import {
  GroupHeader,
  ColumnHeaderRow,
  InlineAddRow,
  ColumnSummaryRow,
  computeBoardStatusDistribution,
  useKeyboardNavContext,
} from '@deckgauge/ui';
import type {
  Project,
  Group,
  BoardColumn,
  BoardOwner,
  BoardStatus,
  ProjectStatus,
} from '@deckgauge/shared';
import { hasAnyJiraLink, type JiraSourceLinks } from '@deckgauge/shared';
import { resolveColumnWidth, buildBoardGridTemplate, canEditEntity } from '@deckgauge/shared';
import type { GridColumnSpec } from '@deckgauge/shared';
import {
  reorderItems,
  reorderGroups,
  createProject,
  updateProject,
  patchProject,
  deleteProject,
  deleteProjects,
  updateFieldValue,
  updateGroup,
  deleteGroup,
  createGroup,
} from '../actions/projects';
import { DraggableProjectRow } from './DraggableProjectRow';
import { VirtualProjectRows } from './VirtualProjectRows';
import { VIRTUALIZE_THRESHOLD } from './board-constants';
import { ItemDetailPanel } from './ItemDetailPanel';
import { BulkActionBar } from './BulkActionBar';
import { StatusManagementPanel } from './StatusManagementPanel';
import { fetchProjectById } from '../actions/projects';
import { sortProjects } from '../utils/sort-projects';
import type { SortConfig } from '../utils/sort-projects';
import { applyFilterRules } from '../utils/filter-projects';
import { useCollapsedGroups } from '../hooks/useCollapsedGroups';
import { markMutation, measureMutation } from '../utils/perf-marks';
import {
  setProjectField,
  setProjectFieldValue,
  removeProject,
  addProject,
  moveProject,
  setGroupField,
  removeGroup,
  addGroup,
  applyBulkPatch,
  applyBulkFieldValue,
  removeProjects,
  reorderItemInTree,
  makeTempId,
  isTempId,
  type ProjectWithFields,
  type GroupTree,
} from '../utils/optimistic-mutators';
import { resolveBulkTargets } from '../utils/bulk-selection';

const DRAG_BLOCK_SELECTOR =
  'input,textarea,select,button,a,[contenteditable="true"],[data-no-dnd="true"]';

export function shouldStartPointerDrag(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return true;
  return target.closest(DRAG_BLOCK_SELECTOR) === null;
}

class BoardPointerSensor extends PointerSensor {
  static activators = [
    {
      eventName: 'onPointerDown' as const,
      handler: ({ nativeEvent }: ReactPointerEvent) => shouldStartPointerDrag(nativeEvent.target),
    },
  ];
}

// dnd-kit's KeyboardSensor normally refuses to start a drag unless the keydown
// fires on the draggable's activator node. We never set an activator node ref
// (only setNodeRef), so that guard is bypassed and Enter/Space inside the inline
// name <input> would start a keyboard drag. Refuse activation when the keydown
// comes from an editable/interactive element so Enter saves the edit instead.
export class BoardKeyboardSensor extends KeyboardSensor {
  static activators = [
    {
      eventName: 'onKeyDown' as const,
      handler: (
        event: ReactKeyboardEvent,
        options: Parameters<(typeof KeyboardSensor.activators)[0]['handler']>[1],
        context: Parameters<(typeof KeyboardSensor.activators)[0]['handler']>[2]
      ): boolean => {
        if (!shouldStartPointerDrag(event.target)) return false;
        return KeyboardSensor.activators[0].handler(event, options, context) ?? false;
      },
    },
  ];
}

// Fixed, non-resizable structural tracks.
const STRIPE_WIDTH = 6;
const CHECKBOX_WIDTH = 28;
const ACTION_WIDTH = 28;

interface GridVisibility {
  owner: boolean;
  assignee: boolean;
  status: boolean;
  startDate: boolean;
  endDate: boolean;
  dueDate: boolean;
  duration: boolean;
  source: boolean;
  updated: boolean;
  classification: boolean;
}

/**
 * Build the CSS `grid-template-columns` value plus the total minimum width of
 * the row. Every data column is a fixed px track sized from the persisted
 * `widths` map (Monday-style), EXCEPT the Item column which flexes to fill
 * spare horizontal space but never shrinks below its resolved width. The total
 * minWidth lets the board scroll horizontally once the columns outgrow the
 * viewport instead of squishing.
 */
function buildGridTemplate(
  columns: BoardColumn[] | undefined,
  vis: GridVisibility,
  widths: Record<string, number>
): { template: string; minWidth: number } {
  // Item column flexes (floor at its resolved width, fill spare room); every
  // other data column is a fixed px track sized from the persisted widths map.
  const specs: GridColumnSpec[] = [{ width: resolveColumnWidth('name', widths), flex: 1.6 }];
  const pushColumn = (key: string) => specs.push({ width: resolveColumnWidth(key, widths) });

  if (vis.owner) pushColumn('owner');
  if (vis.assignee) pushColumn('assignee');
  if (vis.status) pushColumn('status');
  if (columns) for (const col of columns) pushColumn(col.id);
  if (vis.startDate) pushColumn('startDate');
  if (vis.endDate) pushColumn('endDate');
  if (vis.dueDate) pushColumn('dueDate');
  if (vis.duration) pushColumn('duration');
  if (vis.source) pushColumn('source');
  if (vis.updated) pushColumn('updated');
  if (vis.classification) pushColumn('classification');

  // Leading: color stripe + checkbox. Trailing: action menu.
  return buildBoardGridTemplate(specs, {
    leading: [STRIPE_WIDTH, CHECKBOX_WIDTH],
    trailing: [ACTION_WIDTH],
  });
}

interface SortableGroupContainerProps {
  id: string;
  children: (props: {
    listeners: ReturnType<typeof useSortable>['listeners'];
    attributes: ReturnType<typeof useSortable>['attributes'];
  }) => React.ReactNode;
}

function SortableGroupContainer({ id, children }: SortableGroupContainerProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div ref={setNodeRef} style={style}>
      {children({ listeners: listeners ?? {}, attributes: attributes ?? {} })}
    </div>
  );
}

interface GroupListProps {
  groups: (Group & { projects: (Project & { fieldValues?: Record<string, string> })[] })[];
  boardId?: string;
  /** Board template kind — drives recruitment-only affordances (e.g. onboarding). */
  boardKind?: string;
  columns?: BoardColumn[];
  onProjectEdit?: (project: Project) => void;
  onProjectDelete?: (projectId: string) => void;
  searchQuery?: string;
  filterRules?: { column: string; condition: string; value: string }[];
  sortConfig?: SortConfig | null;
  onColumnSort?: (column: string) => void;
  commentCounts?: Record<string, number>;
  boardOwners?: BoardOwner[];
  boardStatuses?: BoardStatus[];
  jiraLinks?: JiraSourceLinks;
  hasGitHubIntegration?: boolean;
  adoOrgUrls?: Record<string, string>;
  hasAdoIntegration?: boolean;
  userRole?: 'OWNER' | 'EDITOR' | 'VIEWER' | null;
  onNavItemsChange?: (items: string[]) => void;
  visibleSystemFields?: {
    owner?: boolean;
    assignee?: boolean;
    status?: boolean;
    startDate?: boolean;
    endDate?: boolean;
    dueDate?: boolean;
    duration?: boolean;
    source?: boolean;
    updated?: boolean;
    classification?: boolean;
  };
  columnWidths?: Record<string, number>;
  onColumnResize?: (key: string, width: number) => void;
  /**
   * Lifts optimistic tree changes up to the owning layer (BoardPageContent) so
   * its server-reconciliation stays consistent. Without it, a moved row that
   * isn't on the SSR first page is "carried forward" into its old group and the
   * move visually reverts. See BoardPageContent.reconcileServerGroups.
   */
  onGroupsChange?: (
    groups: (Group & { projects: (Project & { fieldValues?: Record<string, string> })[] })[]
  ) => void;
  /**
   * Open one item — and optionally scroll to one comment inside it — straight
   * from the URL. This is what lets a notification land on what it is about:
   * `ItemDetailPanel` is otherwise reachable only by clicking a row, so before
   * this a notification could point no deeper than the board.
   */
  deepLink?: { itemId: string; commentId?: string };
}

export function GroupList({
  groups,
  boardId,
  boardKind,
  columns,
  onProjectEdit,
  onProjectDelete,
  searchQuery = '',
  filterRules = [],
  sortConfig,
  onColumnSort,
  commentCounts,
  boardOwners,
  boardStatuses,
  jiraLinks,
  hasGitHubIntegration,
  adoOrgUrls,
  hasAdoIntegration,
  userRole,
  onNavItemsChange,
  visibleSystemFields = {},
  columnWidths = {},
  onColumnResize,
  onGroupsChange,
  deepLink,
}: GroupListProps) {
  const [isPending, setIsPending] = useState(false);
  const [isCreating, startCreating] = useTransition();
  const [deletedProjectIds, setDeletedProjectIds] = useState<Set<string>>(new Set());
  const {
    collapsed: collapsedGroups,
    toggle: toggleCollapse,
    collapseAll: collapseAllInternal,
  } = useCollapsedGroups(boardId);
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
  const [detailProject, setDetailProject] = useState<
    (Project & { fieldValues?: Record<string, string> }) | null
  >(null);
  /**
   * The comment to scroll to once the panel is open. Held separately from
   * `deepLink` because the params are cleared from the URL immediately (see
   * below) while the panel may not have mounted its comment list yet.
   */
  const [targetCommentId, setTargetCommentId] = useState<string | undefined>(undefined);
  /**
   * Runs at most once per mount. Without the guard, clearing the search params
   * re-renders, the effect sees the same `deepLink` prop and re-opens the panel
   * the reader just closed.
   */
  const deepLinkHandled = useRef(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [showStatusManager, setShowStatusManager] = useState(false);

  // Allowlist via canEditEntity, not a `=== 'VIEWER'` denylist: a role fetch
  // that fails closed returns `null`, which must render read-only, not full
  // edit mode.
  const isViewer = !canEditEntity(userRole ?? null);

  // Keyboard navigation context
  const { state: navState, dispatch: navDispatch, cellCount } = useKeyboardNavContext();
  const gPendingRef = useRef(false);
  const gTimerRef = useRef<NodeJS.Timeout>();
  const inFlightRef = useRef(0);

  const removeDeletedFromGroups = useCallback(
    (nextGroups: typeof groups) =>
      nextGroups.map((group) => ({
        ...group,
        projects: (group.projects ?? []).filter((project) => !deletedProjectIds.has(project.id)),
      })),
    [deletedProjectIds]
  );

  // Optimistic local ordering — synced from the server-derived `groups` prop
  // so the UI updates immediately on drop instead of snapping back.
  const [localGroups, setLocalGroups] = useState(() => removeDeletedFromGroups(groups));

  // Opening an item from a URL, for a notification's deep link.
  useEffect(() => {
    if (!deepLink?.itemId || deepLinkHandled.current) return;
    deepLinkHandled.current = true;
    setTargetCommentId(deepLink.commentId);

    const loaded = localGroups.flatMap((g) => g.projects).find((p) => p.id === deepLink.itemId);
    if (loaded) {
      setDetailProject(loaded);
    } else {
      // Not on this page: items are server-paginated at 25 and groups can be
      // collapsed, so a notification about an older item would otherwise click
      // through to the board and silently do nothing — the most likely way this
      // feature feels broken.
      void fetchProjectById(deepLink.itemId).then((project) => {
        // A deleted item resolves to null and the board simply opens normally.
        if (project) setDetailProject(project as typeof detailProject);
      });
    }

    // Consume the params. Without this, closing the panel re-opens it on the
    // next render and a refresh replays the navigation.
    //
    // `history.replaceState`, not `router.replace`: this route is already
    // rendered, and a Next navigation would re-run the server component and
    // refetch the whole board just to drop a query string. It also keeps
    // GroupList free of an app-router dependency, which every one of its
    // existing tests would otherwise have to mock.
    const params = new URLSearchParams(window.location.search);
    params.delete('itemId');
    params.delete('commentId');
    const query = params.toString();
    window.history.replaceState(
      null,
      '',
      query ? `${window.location.pathname}?${query}` : window.location.pathname,
    );
    // `localGroups` is deliberately not a dependency: it is read once, on the
    // single run `deepLinkHandled` allows, and listing it would re-run the effect
    // on every optimistic edit for no benefit. (This repo does not enable
    // react-hooks/exhaustive-deps, so there is no disable comment to add.)
  }, [deepLink]);

  // Commit an optimistic tree: update local state AND mirror it up to the owner
  // so BoardPageContent's server reconciliation carries moved rows forward in
  // their NEW group rather than reverting them to the old one.
  const commitGroups = useCallback(
    (next: typeof localGroups) => {
      setLocalGroups(next);
      onGroupsChange?.(next);
    },
    [onGroupsChange]
  );

  useEffect(() => {
    setDeletedProjectIds(new Set());
  }, [boardId]);

  useEffect(() => {
    if (isCreating || isPending || inFlightRef.current > 0) return;
    setLocalGroups(removeDeletedFromGroups(groups));
  }, [groups, isCreating, isPending, removeDeletedFromGroups]);

  const applyOptimistic = useCallback(
    async <T,>(
      mutator: (groups: typeof localGroups) => typeof localGroups,
      serverCall: () => Promise<T>,
      errorMessage: string,
      rolledBackRowId?: string
    ): Promise<{ ok: true; value: T } | { ok: false }> => {
      const mutationId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      markMutation(mutationId);
      inFlightRef.current += 1;
      const previous = localGroups;
      commitGroups(mutator(localGroups));
      queueMicrotask(() => {
        const dur = measureMutation(mutationId);
        if (dur !== undefined && dur > 16 && process.env.NODE_ENV === 'development') {
          console.warn(`[perf] mutation paint ${dur.toFixed(1)}ms (target ≤16ms)`);
        }
      });
      try {
        const value = await serverCall();
        return { ok: true, value };
      } catch (err) {
        commitGroups(previous);
        toast.error(errorMessage);
        if (process.env.NODE_ENV === 'development') {
          console.error('[applyOptimistic]', errorMessage, err);
        }
        if (rolledBackRowId) {
          // CSS-only flash via a transient class on the row; consumer is BoardRow
          const el = document.querySelector(
            `[data-row-id="${window.CSS.escape(rolledBackRowId)}"]`
          );
          el?.classList.add('animate-flash-error');
          setTimeout(() => el?.classList.remove('animate-flash-error'), 400);
        }
        return { ok: false };
      } finally {
        inFlightRef.current = Math.max(0, inFlightRef.current - 1);
      }
    },
    [localGroups, commitGroups]
  );

  // Apply an inline field edit to the whole selection when the edited row is
  // part of a multi-row selection; otherwise apply it to just that row.
  // Mirrors handleBulkAction('status'): optimistic bulk patch + a client-side
  // per-id server loop (no bulk-update endpoint — see the design doc).
  const applyToSelection = useCallback(
    (
      editedId: string,
      mutate: (groups: GroupTree, ids: string[]) => GroupTree,
      serverPatch: (id: string) => Promise<void>,
      errorMessage: string
    ) => {
      const ids = resolveBulkTargets(editedId, selectedItems);
      if (ids.length === 0) return;
      applyOptimistic(
        (groups) => mutate(groups, ids),
        async () => {
          for (const id of ids) await serverPatch(id);
        },
        errorMessage,
        editedId
      );
    },
    [applyOptimistic, selectedItems]
  );

  const isSorted = !!sortConfig;

  const sensors = useSensors(
    useSensor(BoardPointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(BoardKeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const deferredSearchQuery = useDeferredValue(searchQuery);
  const deferredFilterRules = useDeferredValue(filterRules);

  const filteredGroups = useMemo(() => {
    return localGroups
      .map((group) => {
        let filtered = group.projects ?? [];

        if (deferredSearchQuery) {
          const q = deferredSearchQuery.toLowerCase();
          filtered = filtered.filter(
            (p) => p.name.toLowerCase().includes(q) || p.owner?.toLowerCase().includes(q)
          );
        }

        filtered = applyFilterRules(filtered, deferredFilterRules, boardStatuses);

        const sorted = sortProjects(filtered, sortConfig ?? null);
        return { ...group, projects: sorted };
      })
      .filter((g) =>
        !deferredSearchQuery && !deferredFilterRules.length ? true : g.projects.length > 0
      );
  }, [localGroups, deferredSearchQuery, deferredFilterRules, sortConfig, boardStatuses]);

  // An integration must be connected for the Source column to have anything to
  // show; the user can then hide it via the Columns panel.
  const hasIntegration = (hasAnyJiraLink(jiraLinks) || hasGitHubIntegration || hasAdoIntegration);
  const showSource = hasIntegration && visibleSystemFields.source !== false;
  const showOwner = visibleSystemFields.owner !== false;
  // Assignee (the synced source person) is hidden by default; opt in via Columns.
  const showAssignee = visibleSystemFields.assignee === true;
  const showStatus = visibleSystemFields.status !== false;
  const showUpdated = visibleSystemFields.updated !== false;
  const hasClassificationColumn = visibleSystemFields.classification !== false;

  const { template: gridTemplate, minWidth: gridMinWidth } = useMemo(
    () =>
      buildGridTemplate(
        columns,
        {
          owner: showOwner,
          assignee: showAssignee,
          status: showStatus,
          startDate: !!visibleSystemFields.startDate,
          endDate: !!visibleSystemFields.endDate,
          dueDate: !!visibleSystemFields.dueDate,
          duration: !!visibleSystemFields.duration,
          source: showSource,
          updated: showUpdated,
          classification: hasClassificationColumn,
        },
        columnWidths
      ),
    [
      columns,
      showOwner,
      showAssignee,
      showStatus,
      showSource,
      showUpdated,
      hasClassificationColumn,
      visibleSystemFields.startDate,
      visibleSystemFields.endDate,
      visibleSystemFields.dueDate,
      visibleSystemFields.duration,
      columnWidths,
    ]
  );

  const boardVisibleColumns = useMemo(
    () => ({
      name: true,
      owner: showOwner,
      assignee: showAssignee,
      status: showStatus,
      description: false,
      updated: showUpdated,
      source: showSource,
      classification: hasClassificationColumn,
      startDate: !!visibleSystemFields.startDate,
      endDate: !!visibleSystemFields.endDate,
      dueDate: !!visibleSystemFields.dueDate,
      duration: !!visibleSystemFields.duration,
    }),
    [
      showOwner,
      showAssignee,
      showStatus,
      showUpdated,
      showSource,
      hasClassificationColumn,
      visibleSystemFields.startDate,
      visibleSystemFields.endDate,
      visibleSystemFields.dueDate,
      visibleSystemFields.duration,
    ]
  );

  // Owner combobox autocompletes from every owner/assignee value already used
  // on the board (Monday-style: pick an existing person or type a new one).
  const ownerOptions = useMemo(() => {
    const set = new Set<string>();
    for (const g of localGroups) {
      for (const p of g.projects) {
        if (p.owner?.trim()) set.add(p.owner.trim());
        if (p.assignee?.trim()) set.add(p.assignee.trim());
      }
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [localGroups]);

  const gridStyle = {
    '--board-grid-cols': gridTemplate,
    '--board-grid-min': `${gridMinWidth}px`,
    minWidth: `${gridMinWidth}px`,
  } as React.CSSProperties;

  // Build navigable items list from filtered groups
  const navigableItems = useMemo(() => {
    const items: string[] = [];
    for (const group of filteredGroups) {
      if (collapsedGroups.has(group.id)) continue;
      for (const project of group.projects) {
        items.push(project.id);
      }
      if (!isViewer) {
        items.push(`add-${group.id}`);
      }
    }
    return items;
  }, [filteredGroups, collapsedGroups, isViewer]);

  // Notify parent of navigable items changes
  useEffect(() => {
    onNavItemsChange?.(navigableItems);
  }, [navigableItems, onNavItemsChange]);

  // Map group IDs to their first navigable item
  const groupFirstItems = useMemo(() => {
    const map = new Map<string, string>();
    for (const group of filteredGroups) {
      if (collapsedGroups.has(group.id)) continue;
      if (group.projects.length > 0) {
        map.set(group.id, group.projects[0].id);
      } else if (!isViewer) {
        map.set(group.id, `add-${group.id}`);
      }
    }
    return map;
  }, [filteredGroups, collapsedGroups, isViewer]);

  // Find which group owns the currently focused item
  const findGroupForItem = useCallback(
    (itemId: string): string | null => {
      if (itemId.startsWith('add-')) return itemId.slice(4);
      for (const group of filteredGroups) {
        if (group.projects.some((p) => p.id === itemId)) return group.id;
      }
      return null;
    },
    [filteredGroups]
  );

  // Keyboard handler for the board container
  const handleBoardKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      // Skip all handling when in edit mode
      if (navState.mode === 'edit') return;

      // Skip when typing in an inline editor (name/owner/field inputs). These set
      // local component state rather than nav 'edit' mode, so without this guard the
      // board nav would hijack Enter/Escape/Space and prevent the edit from saving.
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) {
          return;
        }
      }

      const isAddRow = navState.focusedRowId?.startsWith('add-') ?? false;

      // G chord: second key
      if (gPendingRef.current) {
        gPendingRef.current = false;
        clearTimeout(gTimerRef.current);
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          const currentGroupId = navState.focusedRowId
            ? findGroupForItem(navState.focusedRowId)
            : null;
          if (!currentGroupId) return;
          const visibleGroupIds = filteredGroups
            .filter((g) => !collapsedGroups.has(g.id))
            .map((g) => g.id);
          const currentIdx = visibleGroupIds.indexOf(currentGroupId);
          if (currentIdx === -1) return;
          const targetIdx =
            e.key === 'ArrowUp'
              ? Math.max(0, currentIdx - 1)
              : Math.min(visibleGroupIds.length - 1, currentIdx + 1);
          const targetGroupId = visibleGroupIds[targetIdx];
          const targetItem = groupFirstItems.get(targetGroupId);
          if (targetItem) {
            navDispatch({ type: 'FOCUS_ROW', rowId: targetItem });
          }
          return;
        }
        // Not a valid second key for G chord — fall through
      }

      // Tab / Shift+Tab
      if (e.key === 'Tab') {
        e.preventDefault();
        if (e.shiftKey) {
          navDispatch({ type: 'TAB_PREV', items: navigableItems });
        } else {
          navDispatch({ type: 'TAB_NEXT', items: navigableItems });
        }
        return;
      }

      // Arrow navigation
      if (navState.mode === 'row') {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          navDispatch({ type: 'TAB_NEXT', items: navigableItems });
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          navDispatch({ type: 'TAB_PREV', items: navigableItems });
          return;
        }
      }

      if (navState.mode === 'cell') {
        if (e.key === 'ArrowRight') {
          e.preventDefault();
          navDispatch({ type: 'CELL_NEXT', cellCount, items: navigableItems });
          return;
        }
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          navDispatch({ type: 'CELL_PREV', cellCount, items: navigableItems });
          return;
        }
      }

      // Enter — enter cell mode (skip for add-rows)
      if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && navState.mode === 'row' && !isAddRow) {
        e.preventDefault();
        navDispatch({ type: 'ENTER_CELL', cellCount });
        return;
      }

      // Cmd/Ctrl+Enter — open detail panel
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && navState.focusedRowId && !isAddRow) {
        e.preventDefault();
        const project = filteredGroups
          .flatMap((g) => g.projects)
          .find((p) => p.id === navState.focusedRowId);
        if (project) {
          setDetailProject(project);
        }
        return;
      }

      // Escape
      if (e.key === 'Escape') {
        e.preventDefault();
        if (navState.mode === 'cell') {
          navDispatch({ type: 'EXIT_CELL' });
        } else {
          navDispatch({ type: 'BLUR' });
        }
        return;
      }

      // Space — toggle selection (skip for add-rows)
      if (e.key === ' ' && navState.mode === 'row' && navState.focusedRowId && !isAddRow) {
        e.preventDefault();
        navDispatch({ type: 'TOGGLE_SELECT', rowId: navState.focusedRowId });
        toggleSelect(navState.focusedRowId, !selectedItems.has(navState.focusedRowId));
        return;
      }

      // Delete / Backspace — delete focused row (skip for add-rows)
      if (
        (e.key === 'Delete' || e.key === 'Backspace') &&
        navState.mode === 'row' &&
        navState.focusedRowId &&
        !isAddRow &&
        !isViewer
      ) {
        e.preventDefault();
        const confirmed = window.confirm('Delete this item?');
        if (confirmed) {
          const currentIdx = navigableItems.indexOf(navState.focusedRowId);
          const projectId = navState.focusedRowId;
          setDeletedProjectIds((prev) => {
            const next = new Set(prev);
            next.add(projectId);
            return next;
          });
          void (async () => {
            const result = await applyOptimistic(
              (groups) => removeProject(groups, projectId),
              () => deleteProject(projectId, boardId),
              "Couldn't delete project"
            );
            if (!result.ok) {
              setDeletedProjectIds((prev) => {
                const next = new Set(prev);
                next.delete(projectId);
                return next;
              });
              return;
            }
            onProjectDelete?.(projectId);
          })();
          // Move focus to next row (or prev if at end)
          const nextIdx = currentIdx < navigableItems.length - 1 ? currentIdx + 1 : currentIdx - 1;
          if (nextIdx >= 0 && navigableItems[nextIdx]) {
            navDispatch({ type: 'FOCUS_ROW', rowId: navigableItems[nextIdx] });
          } else {
            navDispatch({ type: 'BLUR' });
          }
        }
        return;
      }

      // Single-char shortcuts — only when not in an input
      const el = document.activeElement;
      const inInput =
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement ||
        (el instanceof HTMLElement && el.isContentEditable);
      if (inInput) return;

      // G chord start
      if (e.key === 'g' || e.key === 'G') {
        e.preventDefault();
        gPendingRef.current = true;
        gTimerRef.current = setTimeout(() => {
          gPendingRef.current = false;
        }, 500);
        return;
      }

      // N — focus the add-row of the current group
      if ((e.key === 'n' || e.key === 'N') && !isViewer) {
        e.preventDefault();
        const currentGroupId = navState.focusedRowId
          ? findGroupForItem(navState.focusedRowId)
          : (filteredGroups[0]?.id ?? null);
        if (currentGroupId) {
          const addRowId = `add-${currentGroupId}`;
          if (navigableItems.includes(addRowId)) {
            navDispatch({ type: 'FOCUS_ROW', rowId: addRowId });
          }
        }
        return;
      }
    },
    [
      navState,
      navDispatch,
      navigableItems,
      cellCount,
      filteredGroups,
      collapsedGroups,
      groupFirstItems,
      findGroupForItem,
      selectedItems,
      isViewer,
      startCreating,
    ]
  );

  const collapseAll = () => {
    collapseAllInternal(localGroups.map((g) => g.id));
  };

  const toggleSelect = (projectId: string, selected: boolean) => {
    setSelectedItems((prev) => {
      const next = new Set(prev);
      if (selected) next.add(projectId);
      else next.delete(projectId);
      return next;
    });
  };

  const toggleVisibleSelect = (visibleProjectIds: string[], select: boolean) => {
    setSelectedItems((prev) => {
      const next = new Set(prev);
      for (const id of visibleProjectIds) {
        if (select) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  };

  const computeGroupSelectionState = (
    visibleProjectIds: string[],
    selected: Set<string>
  ): 'none' | 'some' | 'all' => {
    if (visibleProjectIds.length === 0) return 'none';
    let count = 0;
    for (const id of visibleProjectIds) if (selected.has(id)) count++;
    if (count === 0) return 'none';
    if (count === visibleProjectIds.length) return 'all';
    return 'some';
  };

  const allGroups = localGroups.map((g) => ({ id: g.id, name: g.name }));

  const isGroupId = useCallback(
    (id: string) => localGroups.some((g) => g.id === id),
    [localGroups]
  );

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const { active, over } = event;
      setActiveId(null);

      if (!over || active.id === over.id) return;

      const activeStr = String(active.id);
      const overStr = String(over.id);

      try {
        setIsPending(true);

        // Group reordering: active.id is a plain group UUID.
        // over.id can be either another group UUID OR a composite project item ID
        // of the form "group-{groupId}-project-{projectId}" — both cases mean
        // the user is dragging a group header and wants to reorder groups.
        if (isGroupId(activeStr)) {
          let targetGroupId = overStr;
          if (!isGroupId(overStr)) {
            const m = overStr.match(/^group-(.+)-project-(.+)$/);
            if (!m) return; // unrecognised format — bail out
            targetGroupId = m[1]; // group containing the hovered project item
          }
          if (activeStr === targetGroupId) return;

          const oldIndex = localGroups.findIndex((g) => g.id === activeStr);
          const newIndex = localGroups.findIndex((g) => g.id === targetGroupId);
          if (oldIndex === -1 || newIndex === -1) return;

          const reordered = [...localGroups];
          const [moved] = reordered.splice(oldIndex, 1);
          reordered.splice(newIndex, 0, moved);

          const previous = localGroups;
          commitGroups(reordered); // optimistic update — UI reflects new order immediately
          try {
            await reorderGroups(
              reordered.map((g, i) => ({ id: g.id, position: i })),
              boardId
            );
          } catch (err) {
            commitGroups(previous); // roll back on server failure
            console.error('Failed to reorder groups:', err);
          }
          return;
        }

        // Item reordering: the dragged item is always a composite
        // "group-{groupId}-project-{projectId}". The drop target is either
        // another item (composite) or a bare group id — the latter happens when
        // dropping into an *empty* group, which renders no rows to land on.
        const activeMatch = activeStr.match(/^group-(.+)-project-(.+)$/);
        if (!activeMatch) return;
        const [, activeGroupId, activeProjectId] = activeMatch;

        const overMatch = overStr.match(/^group-(.+)-project-(.+)$/);
        let overGroupId: string;
        let overProjectId: string;
        if (overMatch) {
          [, overGroupId, overProjectId] = overMatch;
        } else if (isGroupId(overStr)) {
          // Dropped on a group container — append to that group. The empty
          // string never matches a project id, so reorderItemInTree appends.
          overGroupId = overStr;
          overProjectId = '';
        } else {
          return;
        }

        // Rebuild the target group's ordering and renumber it sequentially.
        // A single fractional `order` cannot work here: most projects have a
        // NULL order, so a midpoint computed from NULL neighbours collapses to
        // one value the server's `order ASC NULLS LAST` sort pushes to the top.
        const result = reorderItemInTree(
          localGroups,
          activeGroupId,
          activeProjectId,
          overGroupId,
          overProjectId
        );
        if (!result) return;

        const previous = localGroups;
        commitGroups(result.tree); // optimistic — reflects the drop immediately
        try {
          await reorderItems(result.updates, boardId);
        } catch (err) {
          commitGroups(previous); // roll back on server failure
          toast.error("Couldn't move item");
          if (process.env.NODE_ENV === 'development') {
            console.error('Failed to reorder items:', err);
          }
        }
      } finally {
        setIsPending(false);
      }
    },
    [localGroups, isGroupId, commitGroups]
  );

  const handleBulkAction = async (action: string, value?: string) => {
    const ids = Array.from(selectedItems);
    if (ids.length === 0) return;

    if (action === 'delete') {
      setDeletedProjectIds((prev) => {
        const next = new Set(prev);
        for (const id of ids) next.add(id);
        return next;
      });
      const result = await applyOptimistic(
        (groups) => removeProjects(groups, ids),
        () => deleteProjects(ids, boardId),
        `Couldn't delete ${ids.length} item${ids.length === 1 ? '' : 's'}`
      );
      if (!result.ok) {
        setDeletedProjectIds((prev) => {
          const next = new Set(prev);
          for (const id of ids) next.delete(id);
          return next;
        });
      } else {
        for (const id of ids) {
          onProjectDelete?.(id);
        }
      }
    } else if (action === 'status' && value) {
      await applyOptimistic(
        (groups) => applyBulkPatch(groups, ids, { status: value }),
        async () => {
          for (const id of ids) await updateProject(id, { status: value }, boardId);
        },
        `Couldn't update ${ids.length} item${ids.length === 1 ? '' : 's'}`
      );
    } else if (action === 'move' && value) {
      // Bulk move-to-group: send a single batched /projects/reorder call with
      // groupId-only updates (no `order`). Order is intentionally omitted so
      // Jira-synced projects whose `order` is `null` in the DB are not
      // overwritten with `undefined` — the API skips the order column when
      // omitted. Each project keeps its existing relative order within the
      // new group. See planning/STATE.md 2026-06-16 "bulk-move crash-loop"
      // and the follow-up entry for the order-optional schema change.
      const updates = ids
        .map((id) => {
          const proj = localGroups.flatMap((g) => g.projects).find((p) => p.id === id);
          return proj ? { id, groupId: value } : null;
        })
        .filter((u): u is { id: string; groupId: string } => u !== null);

      if (updates.length === 0) return;

      await applyOptimistic(
        (groups) => {
          let next = groups;
          for (const id of ids) {
            const proj = next.flatMap((g) => g.projects).find((p) => p.id === id);
            if (proj) next = moveProject(next, id, value, proj.order);
          }
          return next;
        },
        async () => {
          await reorderItems(updates, boardId);
        },
        `Couldn't move ${ids.length} item${ids.length === 1 ? '' : 's'}`
      );
    } else if (action === 'duplicate') {
      const sources = localGroups.flatMap((g) => g.projects).filter((p) => ids.includes(p.id));
      await applyOptimistic(
        (groups) => {
          let next = groups;
          for (const src of sources) {
            next = addProject(next, src.groupId ?? '', {
              ...src,
              id: makeTempId(),
              name: `Copy of ${src.name}`,
            });
          }
          return next;
        },
        async () => {
          for (const src of sources) {
            await createProject(
              {
                name: `Copy of ${src.name}`,
                owner: src.owner,
                status: src.status,
                groupId: src.groupId ?? undefined,
                boardId: src.boardId ?? undefined,
              },
              boardId
            );
          }
        },
        `Couldn't duplicate ${sources.length} item${sources.length === 1 ? '' : 's'}`
      );
    }
    setSelectedItems(new Set());
  };

  // Single source of per-row props shared by both the sortable path and the
  // virtualized path. groupColor is NOT included here because it is per-group
  // and merged at each call site.
  const buildRowProps = useCallback(
    (project: ProjectWithFields) => ({
      project,
      onEdit: isViewer || isTempId(project.id) ? undefined : () => onProjectEdit?.(project),
      onDelete:
        isViewer || isTempId(project.id)
          ? undefined
          : () => {
              const projectId = project.id;
              setDeletedProjectIds((prev) => {
                const next = new Set(prev);
                next.add(projectId);
                return next;
              });
              void (async () => {
                const result = await applyOptimistic(
                  (groups) => removeProject(groups, projectId),
                  () => deleteProject(projectId, boardId),
                  "Couldn't delete project"
                );
                if (!result.ok) {
                  setDeletedProjectIds((prev) => {
                    const next = new Set(prev);
                    next.delete(projectId);
                    return next;
                  });
                  return;
                }
                onProjectDelete?.(projectId);
              })();
            },
      columns,
      fieldValues: project.fieldValues,
      onFieldChange:
        isViewer || isTempId(project.id)
          ? undefined
          : (colId: string, value: string) =>
              applyToSelection(
                project.id,
                (groups, ids) => applyBulkFieldValue(groups, ids, colId, value),
                (id) => updateFieldValue(id, colId, value, boardId),
                "Couldn't update field"
              ),
      jiraLinks,
      hasGitHubIntegration,
      adoOrgUrls,
      hasAdoIntegration,
      onNameChange:
        isViewer || isTempId(project.id)
          ? undefined
          : (name: string) => {
              applyOptimistic(
                (groups) => setProjectField(groups, project.id, { name }),
                () => updateProject(project.id, { name }, boardId),
                "Couldn't rename project",
                project.id
              );
            },
      onStatusChange:
        isViewer || isTempId(project.id)
          ? undefined
          : (status: ProjectStatus) =>
              applyToSelection(
                project.id,
                (groups, ids) => applyBulkPatch(groups, ids, { status }),
                (id) => updateProject(id, { status }, boardId),
                "Couldn't update status"
              ),
      onStatusIdChange:
        isViewer || isTempId(project.id)
          ? undefined
          : (statusId: string) =>
              applyToSelection(
                project.id,
                (groups, ids) => applyBulkPatch(groups, ids, { statusId }),
                (id) => updateProject(id, { statusId }, boardId),
                "Couldn't update status"
              ),
      onOwnerChange:
        isViewer || isTempId(project.id)
          ? undefined
          : (owner: string) => {
              const trimmed = owner.trim();
              if (!trimmed) return;
              applyToSelection(
                project.id,
                (groups, ids) =>
                  // The VALUE goes to the whole selection; the dirty MARK goes to
                  // the clicked row only. `overriddenFields` is per-row state, so
                  // bulk-patching it would copy this row's dirty keys onto every
                  // other selected row. The rest get their badge on revalidation.
                  setProjectField(applyBulkPatch(groups, ids, { owner: trimmed }), project.id, {
                    overriddenFields: Array.from(
                      new Set([...(project.overriddenFields ?? []), 'owner'])
                    ),
                  }),
                (id) => updateProject(id, { owner: trimmed }, boardId),
                "Couldn't update owner"
              );
            },
      ownerOptions,
      onOwnerIdChange:
        isViewer || isTempId(project.id)
          ? undefined
          : (ownerId: string | null) =>
              applyToSelection(
                project.id,
                (groups, ids) => applyBulkPatch(groups, ids, { ownerId }),
                (id) => updateProject(id, { ownerId }, boardId),
                "Couldn't update owner"
              ),
      onDuplicate:
        isViewer || isTempId(project.id)
          ? undefined
          : () => {
              const tempId = makeTempId();
              applyOptimistic(
                (groups) =>
                  addProject(groups, project.groupId ?? '', {
                    ...project,
                    id: tempId,
                    name: `Copy of ${project.name}`,
                  }),
                () =>
                  createProject(
                    {
                      name: `Copy of ${project.name}`,
                      owner: project.owner,
                      status: project.status,
                      groupId: project.groupId ?? undefined,
                      boardId: project.boardId ?? undefined,
                    },
                    boardId
                  ),
                "Couldn't duplicate project"
              );
            },
      onMoveToGroup:
        isViewer || isTempId(project.id)
          ? undefined
          : (groupId: string) => {
              applyOptimistic(
                (groups) => moveProject(groups, project.id, groupId, project.order),
                () => updateProject(project.id, { groupId }, boardId),
                "Couldn't move project",
                project.id
              );
            },
      availableGroups: allGroups,
      selected: isViewer ? undefined : selectedItems.has(project.id),
      onSelect:
        isViewer || isTempId(project.id)
          ? undefined
          : (sel: boolean) => toggleSelect(project.id, sel),
      onExpand: () => setDetailProject(project),
      commentCount: commentCounts?.[project.id] ?? 0,
      boardOwners,
      boardStatuses,
      onManageStatuses: isViewer ? undefined : () => setShowStatusManager(true),
      visibleColumns: boardVisibleColumns,
      startDate: project.startDate,
      endDate: project.endDate,
      dueDate: project.dueDate,
      durationCode: project.durationCode,
      overriddenFields: project.overriddenFields ?? [],
      preOverrideValues: project.preOverrideValues ?? null,
      onRevertField:
        isViewer || isTempId(project.id)
          ? undefined
          : (fieldKey: string) =>
              applyOptimistic(
                (groups) =>
                  setProjectField(groups, project.id, {
                    overriddenFields: (project.overriddenFields ?? []).filter(
                      (k: string) => k !== fieldKey
                    ),
                  }),
                () => updateProject(project.id, { revertFields: [fieldKey] }, boardId),
                "Couldn't revert the field",
                project.id
              ),
      onSystemFieldChange:
        isViewer || isTempId(project.id)
          ? undefined
          : (field: 'startDate' | 'endDate' | 'dueDate' | 'durationCode', value: string) => {
              const v = value === '' ? null : value;
              applyToSelection(
                project.id,
                (groups, ids) => {
                  const withValue = applyBulkPatch(groups, ids, { [field]: v });
                  // Only dueDate is source-synced; startDate/endDate/durationCode
                  // are manual-only and can never be dirty. The mark lands on the
                  // clicked row alone — see the note on onOwnerChange above.
                  if (field !== 'dueDate') return withValue;
                  return setProjectField(withValue, project.id, {
                    overriddenFields: Array.from(
                      new Set([...(project.overriddenFields ?? []), 'dueDate'])
                    ),
                  });
                },
                (id) => updateProject(id, { [field]: v }, boardId),
                `Couldn't save ${field}`
              );
            },
      onCostClassificationChange:
        isViewer || isTempId(project.id)
          ? undefined
          : (value: 'CAPEX' | 'OPEX' | null) =>
              applyToSelection(
                project.id,
                (groups, ids) => applyBulkPatch(groups, ids, { costClassification: value }),
                (id) => patchProject(id, { costClassification: value }, boardId),
                "Couldn't update CapEx/OpEx"
              ),
      isFocused: navState.focusedRowId === project.id,
      focusedCell:
        navState.focusedRowId === project.id && navState.mode === 'cell'
          ? navState.focusedCellIndex
          : null,
      isKbSelected: navState.selectedRowIds.has(project.id),
    }),
    [
      isViewer,
      onProjectEdit,
      applyOptimistic,
      applyToSelection,
      boardId,
      columns,
      jiraLinks,
      hasGitHubIntegration,
      adoOrgUrls,
      hasAdoIntegration,
      allGroups,
      selectedItems,
      commentCounts,
      boardOwners,
      boardStatuses,
      navState,
      boardVisibleColumns,
      onProjectDelete,
      ownerOptions,
    ]
  );

  return (
    <>
      <DndContext
        sensors={isSorted || isViewer ? [] : sensors}
        collisionDetection={closestCorners}
        onDragStart={
          isSorted || isViewer ? undefined : (event) => setActiveId(String(event.active.id))
        }
        onDragEnd={isSorted || isViewer ? undefined : handleDragEnd}
      >
        <div
          className="space-y-6 overflow-x-auto pb-2"
          tabIndex={-1}
          onKeyDown={handleBoardKeyDown}
        >
          {filteredGroups.length === 0 && (
            <p className="text-center text-sm text-slate-500 py-12">
              {searchQuery || filterRules.length > 0
                ? 'No items match your search'
                : 'No groups yet. Click "+ Add new group" below to get started.'}
            </p>
          )}

          <SortableContext
            items={filteredGroups.map((g) => g.id)}
            strategy={verticalListSortingStrategy}
          >
            {filteredGroups.map((group) => {
              const isCollapsed = collapsedGroups.has(group.id);
              const groupColor = (group as Group & { color?: string }).color || '#6C6CFF';
              return (
                <SortableGroupContainer key={group.id} id={group.id}>
                  {({ listeners, attributes }) => (
                    <div>
                      {/* Group header — standalone above the table */}
                      <div className="flex items-center gap-1 px-1 pb-1">
                        {!isViewer && (
                          <button
                            type="button"
                            className="flex items-center justify-center w-5 h-7 shrink-0 text-slate-300 hover:text-slate-500 cursor-grab active:cursor-grabbing transition-colors"
                            aria-label="Drag to reorder group"
                            {...listeners}
                            {...attributes}
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
                        )}
                        <GroupHeader
                          title={group.name}
                          count={group.projects.length}
                          collapsed={isCollapsed}
                          onToggle={() => toggleCollapse(group.id)}
                          color={groupColor}
                          onColorChange={
                            isViewer
                              ? undefined
                              : (color) => {
                                  applyOptimistic(
                                    (groups) => setGroupField(groups, group.id, { color }),
                                    () => updateGroup(group.id, { color }, boardId),
                                    "Couldn't update group color"
                                  );
                                }
                          }
                          onRename={
                            isViewer
                              ? undefined
                              : (name) => {
                                  applyOptimistic(
                                    (groups) => setGroupField(groups, group.id, { name }),
                                    () => updateGroup(group.id, { name }, boardId),
                                    "Couldn't rename group"
                                  );
                                }
                          }
                          onDuplicate={
                            isViewer
                              ? undefined
                              : () => {
                                  if (!boardId) return;
                                  const tempId = makeTempId();
                                  applyOptimistic(
                                    (groups) =>
                                      addGroup(groups, {
                                        id: tempId,
                                        name: `${group.name} (copy)`,
                                        boardId,
                                        position: groups.length,
                                        color: group.color ?? '#6C6CFF',
                                        projects: [],
                                      }),
                                    () => createGroup(boardId, `${group.name} (copy)`),
                                    "Couldn't duplicate group"
                                  );
                                }
                          }
                          onDelete={
                            isViewer
                              ? undefined
                              : () => {
                                  applyOptimistic(
                                    (groups) => removeGroup(groups, group.id),
                                    () => deleteGroup(group.id, boardId),
                                    "Couldn't delete group"
                                  );
                                }
                          }
                          onCollapseAll={collapseAll}
                          statusCounts={{
                            NOT_STARTED: group.projects.filter((p) => p.status === 'NOT_STARTED')
                              .length,
                            IN_PROGRESS: group.projects.filter((p) => p.status === 'IN_PROGRESS')
                              .length,
                            AT_RISK: group.projects.filter((p) => p.status === 'AT_RISK').length,
                            BLOCKED: group.projects.filter((p) => p.status === 'BLOCKED').length,
                            DONE: group.projects.filter((p) => p.status === 'DONE').length,
                          }}
                          boardStatusDistribution={
                            boardStatuses && boardStatuses.length > 0
                              ? computeBoardStatusDistribution(group.projects, boardStatuses)
                              : undefined
                          }
                        />
                      </div>

                      {/* Table container */}
                      {!isCollapsed && (
                        <div
                          className="border border-slate-200 rounded-md bg-white"
                          style={gridStyle}
                        >
                          <ColumnHeaderRow
                            columns={columns}
                            hasJiraIntegration={hasAnyJiraLink(jiraLinks)}
                            hasGitHubIntegration={hasGitHubIntegration}
                            hasAdoIntegration={hasAdoIntegration}
                            sortConfig={sortConfig}
                            onSort={onColumnSort}
                            groupColor={groupColor}
                            visibleColumns={boardVisibleColumns}
                            hasClassificationColumn={hasClassificationColumn}
                            columnWidths={columnWidths}
                            onColumnResize={onColumnResize}
                            selectionState={
                              isViewer
                                ? undefined
                                : computeGroupSelectionState(
                                    group.projects.map((p) => p.id),
                                    selectedItems
                                  )
                            }
                            onSelectAll={
                              isViewer
                                ? undefined
                                : (select) =>
                                    toggleVisibleSelect(
                                      group.projects.map((p) => p.id),
                                      select
                                    )
                            }
                          />

                          {group.projects.length === 0 ? (
                            <p className="text-center text-sm text-slate-500 py-4">No items</p>
                          ) : group.projects.length > VIRTUALIZE_THRESHOLD ? (
                            // Large group: render via react-window windowed list.
                            // Drag-and-drop is intentionally disabled here — SortableContext
                            // cannot be mixed with a virtualised list.
                            <VirtualProjectRows
                              projects={group.projects}
                              buildRowProps={(p) => ({ ...buildRowProps(p), groupColor })}
                            />
                          ) : (
                            <SortableContext
                              items={group.projects.map((p) => `group-${group.id}-project-${p.id}`)}
                              strategy={verticalListSortingStrategy}
                            >
                              <div>
                                {group.projects.map((project) => (
                                  <DraggableProjectRow
                                    key={project.id}
                                    id={`group-${group.id}-project-${project.id}`}
                                    disabled={isPending || isSorted || isViewer}
                                    {...buildRowProps(project)}
                                    groupColor={groupColor}
                                  />
                                ))}
                              </div>
                            </SortableContext>
                          )}

                          <ColumnSummaryRow
                            columns={columns}
                            items={group.projects}
                            groupColor={groupColor}
                            hasAssignee={showAssignee}
                            hasSourceLink={showSource}
                            hasClassificationColumn={hasClassificationColumn}
                          />

                          {!isViewer && (
                            <InlineAddRow
                              isLoading={isCreating || isPending}
                              groupColor={groupColor}
                              onAdd={(name) => {
                                const tempId = makeTempId();
                                applyOptimistic(
                                  (groups) =>
                                    addProject(groups, group.id, {
                                      id: tempId,
                                      name,
                                      owner: 'Unassigned',
                                      status: 'NOT_STARTED',
                                      groupId: group.id,
                                      boardId: boardId ?? null,
                                      order:
                                        (group.projects[group.projects.length - 1]?.order ?? 0) + 1,
                                      ownerId: null,
                                      statusId: null,
                                      description: null,
                                      jiraKey: null,
                                      githubIssueId: null,
                                      adoWorkItemId: null,
                                      adoProject: null,
                                      createdAt: new Date(),
                                      updatedAt: new Date(),
                                    } as ProjectWithFields),
                                  () =>
                                    createProject(
                                      {
                                        name,
                                        owner: 'Unassigned',
                                        status: 'NOT_STARTED',
                                        groupId: group.id,
                                        boardId,
                                      },
                                      boardId
                                    ),
                                  "Couldn't create project"
                                );
                              }}
                              onShiftEnterAdd={(name) => {
                                const tempId = makeTempId();
                                applyOptimistic(
                                  (groups) =>
                                    addProject(groups, group.id, {
                                      id: tempId,
                                      name,
                                      owner: 'Unassigned',
                                      status: 'NOT_STARTED',
                                      groupId: group.id,
                                      boardId: boardId ?? null,
                                      order:
                                        (group.projects[group.projects.length - 1]?.order ?? 0) + 1,
                                      ownerId: null,
                                      statusId: null,
                                      description: null,
                                      jiraKey: null,
                                      githubIssueId: null,
                                      adoWorkItemId: null,
                                      adoProject: null,
                                      createdAt: new Date(),
                                      updatedAt: new Date(),
                                    } as ProjectWithFields),
                                  () =>
                                    createProject(
                                      {
                                        name,
                                        owner: 'Unassigned',
                                        status: 'NOT_STARTED',
                                        groupId: group.id,
                                        boardId,
                                      },
                                      boardId
                                    ),
                                  "Couldn't create project"
                                );
                              }}
                            />
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </SortableGroupContainer>
              );
            })}
          </SortableContext>

          {/* Add new group button */}
          {boardId && !isViewer && (
            <button
              type="button"
              onClick={() => {
                if (!boardId) return;
                const tempId = makeTempId();
                applyOptimistic(
                  (groups) =>
                    addGroup(groups, {
                      id: tempId,
                      name: 'New Group',
                      boardId,
                      position: groups.length,
                      color: '#6C6CFF',
                      projects: [],
                    }),
                  () => createGroup(boardId, 'New Group'),
                  "Couldn't create group"
                );
              }}
              disabled={isCreating || isPending}
              className="flex w-full items-center gap-3 rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-3.5 text-sm text-slate-500 hover:bg-slate-50 hover:text-slate-400 hover:border-slate-300 transition-all duration-200 disabled:opacity-50"
            >
              + Add new group
            </button>
          )}
        </div>

        <DragOverlay>
          {activeId ? (
            isGroupId(activeId) ? (
              <div className="glass border-indigo-500 px-4 py-3 shadow-lg">
                <span className="text-sm font-semibold text-indigo-500">
                  {localGroups.find((g) => g.id === activeId)?.name ?? 'Moving group...'}
                </span>
              </div>
            ) : (
              <div className="glass border-indigo-500 px-4 py-2 shadow-lg">
                <span className="text-sm text-indigo-500">Moving item...</span>
              </div>
            )
          ) : null}
        </DragOverlay>
      </DndContext>

      {selectedItems.size > 0 && (
        <BulkActionBar
          count={selectedItems.size}
          groups={allGroups}
          onAction={handleBulkAction}
          onClear={() => setSelectedItems(new Set())}
        />
      )}

      {detailProject && (
        <ItemDetailPanel
          project={detailProject}
          targetCommentId={targetCommentId}
          columns={columns}
          boardId={boardId}
          boardKind={boardKind}
          owners={ownerOptions}
          onClose={() => {
            setDetailProject(null);
            setTargetCommentId(undefined);
          }}
          onSave={(field, value) => {
            if (field === 'revertField' || field === 'revertAllFields') {
              const keys =
                field === 'revertAllFields'
                  ? (detailProject.overriddenFields ?? [])
                  : [value];
              if (keys.length === 0) return;
              applyOptimistic(
                (groups) =>
                  setProjectField(groups, detailProject.id, {
                    overriddenFields: (detailProject.overriddenFields ?? []).filter(
                      (k: string) => !keys.includes(k)
                    ),
                  }),
                () => updateProject(detailProject.id, { revertFields: keys }, boardId),
                "Couldn't revert the field",
                detailProject.id
              );
              return;
            }
            if (field === 'owner') {
              applyOptimistic(
                (groups) =>
                  setProjectField(groups, detailProject.id, {
                    owner: value,
                    overriddenFields: Array.from(
                      new Set([...(detailProject.overriddenFields ?? []), 'owner'])
                    ),
                  }),
                () => updateProject(detailProject.id, { owner: value }, boardId),
                "Couldn't save owner",
                detailProject.id
              );
            } else if (
              field === 'name' ||
              field === 'status' ||
              field === 'description'
            ) {
              applyOptimistic(
                (groups) => setProjectField(groups, detailProject.id, { [field]: value }),
                () => updateProject(detailProject.id, { [field]: value }, boardId),
                `Couldn't save ${field}`,
                detailProject.id
              );
            } else if (field === 'startDate' || field === 'endDate' || field === 'durationCode') {
              const v = value === '' ? null : value;
              applyOptimistic(
                (groups) => setProjectField(groups, detailProject.id, { [field]: v }),
                () => updateProject(detailProject.id, { [field]: v }, boardId),
                `Couldn't save ${field}`,
                detailProject.id
              );
            } else {
              applyOptimistic(
                (groups) => setProjectFieldValue(groups, detailProject.id, field, value as string),
                () => updateFieldValue(detailProject.id, field, value as string, boardId),
                "Couldn't save field",
                detailProject.id
              );
            }
          }}
        />
      )}

      {showStatusManager && boardId && boardStatuses && (
        <StatusManagementPanel
          boardId={boardId}
          statuses={boardStatuses}
          onClose={() => setShowStatusManager(false)}
        />
      )}
    </>
  );
}

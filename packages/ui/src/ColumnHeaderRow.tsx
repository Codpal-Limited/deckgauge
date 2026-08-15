import { useCallback, useRef } from 'react';
import { clampColumnWidth, resolveColumnWidth } from '@deckgauge/shared';
import type { BoardColumn } from '@deckgauge/shared';
import type { VisibleColumns } from './ColumnToggle';

// Sticky-left offsets for the pinned Item block (color stripe + checkbox + name).
// Must match the fixed track widths in GroupList.buildGridTemplate.
const STRIPE_LEFT = 0;
const CHECKBOX_LEFT = 6;
const NAME_LEFT = 34; // stripe (6) + checkbox (28)

interface DragHandleProps {
  // dnd-kit useSortable listeners and attributes — typed loosely
  // since this component shouldn't depend on @dnd-kit types directly
  listeners?: object;
  attributes?: object;
}

interface ColumnHeaderRowProps {
  visibleColumns?: VisibleColumns;
  columns?: BoardColumn[];
  hasJiraIntegration?: boolean;
  hasGitHubIntegration?: boolean;
  hasAdoIntegration?: boolean;
  dragHandleProps?: DragHandleProps;
  sortConfig?: { column: string; direction: 'asc' | 'desc' } | null;
  onSort?: (column: string) => void;
  groupColor?: string;
  /** Tri-state of the group's select-all checkbox. Omit (with onSelectAll) to hide the checkbox. */
  selectionState?: 'none' | 'some' | 'all';
  /** Called when user toggles the checkbox. `select=true` selects all visible; `select=false` deselects all visible. */
  onSelectAll?: (select: boolean) => void;
  /** When true, renders the CapEx/OpEx classification header cell between Updated and the action spacer. */
  hasClassificationColumn?: boolean;
  /** Persisted per-column widths; drives the live width used while resizing. */
  columnWidths?: Record<string, number>;
  /** Called continuously while a column is being resized. */
  onColumnResize?: (key: string, width: number) => void;
}

/**
 * Track a horizontal drag on a column's right edge and report the new width.
 * `resolveWidth` maps a column key + the widths map to the width the drag starts
 * from; it defaults to the main board's system-column resolver, but other boards
 * (e.g. the org-tree employee board) pass their own so the drag begins from the
 * width they actually render.
 */
export function useColumnResize(
  columnWidths: Record<string, number>,
  onColumnResize?: (key: string, width: number) => void,
  resolveWidth: (key: string, widths: Record<string, number>) => number = resolveColumnWidth,
) {
  const drag = useRef<{ key: string; startX: number; startWidth: number } | null>(null);

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      const d = drag.current;
      if (!d || !onColumnResize) return;
      onColumnResize(d.key, clampColumnWidth(d.startWidth + (e.clientX - d.startX)));
    },
    [onColumnResize],
  );

  const onPointerUp = useCallback(() => {
    drag.current = null;
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
  }, [onPointerMove]);

  const startResize = useCallback(
    (key: string, e: React.PointerEvent) => {
      if (!onColumnResize) return;
      // Don't let the drag start a sort click or a group drag.
      e.preventDefault();
      e.stopPropagation();
      drag.current = { key, startX: e.clientX, startWidth: resolveWidth(key, columnWidths) };
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'col-resize';
      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp);
    },
    [columnWidths, onColumnResize, resolveWidth, onPointerMove, onPointerUp],
  );

  return startResize;
}

export function ResizeHandle({
  columnKey,
  onStart,
}: {
  columnKey: string;
  onStart?: (key: string, e: React.PointerEvent) => void;
}) {
  if (!onStart) return null;
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${columnKey} column`}
      data-no-dnd="true"
      onPointerDown={(e) => onStart(columnKey, e)}
      onClick={(e) => e.stopPropagation()}
      className="absolute top-0 right-0 z-30 h-full w-1.5 cursor-col-resize select-none hover:bg-indigo-400/40 active:bg-indigo-500/60"
    />
  );
}

function SortIndicator({ direction }: { direction: 'asc' | 'desc' }) {
  const label = direction === 'asc' ? 'Sorted ascending' : 'Sorted descending';
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="currentColor"
      className="text-indigo-500 ml-1 inline-block shrink-0"
      aria-label={label}
      role="img"
    >
      {direction === 'asc' ? <path d="M6 2L10 8H2L6 2Z" /> : <path d="M6 10L2 4H10L6 10Z" />}
    </svg>
  );
}

function SortableHeader({
  columnKey,
  sortConfig,
  onSort,
  className,
  style,
  resizeKey,
  onResizeStart,
  children,
}: {
  columnKey: string;
  sortConfig?: { column: string; direction: 'asc' | 'desc' } | null;
  onSort?: (column: string) => void;
  className?: string;
  style?: React.CSSProperties;
  resizeKey?: string;
  onResizeStart?: (key: string, e: React.PointerEvent) => void;
  children: React.ReactNode;
}) {
  const isSorted = sortConfig?.column === columnKey;
  const handleClick = onSort ? () => onSort(columnKey) : undefined;

  return (
    <div
      className={`${className ?? ''} ${onSort ? 'cursor-pointer select-none' : ''} relative flex items-center`.trim()}
      style={style}
      onClick={handleClick}
      role={onSort ? 'button' : undefined}
      tabIndex={onSort ? 0 : undefined}
      onKeyDown={
        onSort
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSort(columnKey);
              }
            }
          : undefined
      }
    >
      {children}
      {isSorted && <SortIndicator direction={sortConfig!.direction} />}
      {resizeKey && <ResizeHandle columnKey={resizeKey} onStart={onResizeStart} />}
    </div>
  );
}

function SelectAllCheckbox({
  state,
  onToggle,
}: {
  state: 'none' | 'some' | 'all';
  onToggle: (select: boolean) => void;
}) {
  const checked = state === 'all';
  const indeterminate = state === 'some';

  return (
    <input
      type="checkbox"
      aria-label="Select all visible items in this group"
      checked={checked}
      ref={(el) => {
        if (el) el.indeterminate = indeterminate;
      }}
      onChange={() => {
        onToggle(state !== 'all');
      }}
      className="h-4 w-4 rounded border-slate-300 text-indigo-500 focus:ring-indigo-500/20"
    />
  );
}

export function ColumnHeaderRow({
  visibleColumns = {
    name: true,
    owner: true,
    status: true,
    description: false,
    updated: true,
  },
  columns,
  hasJiraIntegration,
  hasGitHubIntegration,
  hasAdoIntegration,
  dragHandleProps,
  sortConfig,
  onSort,
  groupColor = '#6C6CFF',
  selectionState,
  onSelectAll,
  hasClassificationColumn,
  columnWidths = {},
  onColumnResize,
}: ColumnHeaderRowProps) {
  const startResize = useColumnResize(columnWidths, onColumnResize);
  // The Source column only has content when an integration is connected AND the
  // user hasn't hidden it via the Columns panel.
  const showSource =
    visibleColumns.source !== false &&
    (!!hasJiraIntegration || !!hasGitHubIntegration || !!hasAdoIntegration);

  // Shared classes for the pinned Item block so scrolled columns tuck underneath.
  const stickyCell = 'sticky z-20 bg-slate-50';

  return (
    <div
      className="grid items-center text-xs font-medium text-slate-500 uppercase tracking-wider bg-slate-50 border-b border-slate-200"
      style={{ gridTemplateColumns: 'var(--board-grid-cols)' }}
    >
      {/* Left color stripe (pinned) */}
      <div
        className="sticky z-20 h-full rounded-tl-md"
        style={{ backgroundColor: groupColor, left: STRIPE_LEFT }}
      />

      {/* Drag handle and/or select-all checkbox (pinned) */}
      <div
        className={`${stickyCell} flex items-center justify-center gap-1 px-1 py-1.5 border-r border-slate-200`}
        style={{ left: CHECKBOX_LEFT }}
      >
        {dragHandleProps ? (
          <button
            type="button"
            className="flex items-center justify-center w-4 h-5 shrink-0 text-slate-300 hover:text-slate-500 cursor-grab active:cursor-grabbing transition-colors"
            aria-label="Drag to reorder group"
            {...dragHandleProps.listeners}
            {...dragHandleProps.attributes}
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
        ) : null}
        {selectionState !== undefined && onSelectAll ? (
          <SelectAllCheckbox state={selectionState} onToggle={onSelectAll} />
        ) : null}
        {!dragHandleProps && !(selectionState !== undefined && onSelectAll) ? (
          <div className="h-4 w-4" />
        ) : null}
      </div>

      {/* Item header (pinned) */}
      {visibleColumns.name && (
        <SortableHeader
          columnKey="name"
          sortConfig={sortConfig}
          onSort={onSort}
          resizeKey="name"
          onResizeStart={startResize}
          style={{ left: NAME_LEFT }}
          className={`${stickyCell} px-3 py-1.5 border-r border-slate-200 justify-between`}
        >
          <span>Item</span>
        </SortableHeader>
      )}

      {/* Owner header */}
      {visibleColumns.owner && (
        <SortableHeader
          columnKey="owner"
          sortConfig={sortConfig}
          onSort={onSort}
          resizeKey="owner"
          onResizeStart={startResize}
          className="px-3 py-1.5 border-r border-slate-200 justify-center"
        >
          <span>Owner</span>
        </SortableHeader>
      )}

      {/* Assignee header (read-only synced source person) */}
      {visibleColumns.assignee && (
        <div className="relative px-3 py-1.5 border-r border-slate-200 text-center">
          Assignee
          <ResizeHandle columnKey="assignee" onStart={startResize} />
        </div>
      )}

      {/* Status header */}
      {visibleColumns.status && (
        <SortableHeader
          columnKey="status"
          sortConfig={sortConfig}
          onSort={onSort}
          resizeKey="status"
          onResizeStart={startResize}
          className="px-3 py-1.5 border-r border-slate-200 justify-center"
        >
          <span>Status</span>
        </SortableHeader>
      )}

      {/* Custom column headers */}
      {columns?.map((col) => (
        <SortableHeader
          key={col.id}
          columnKey={col.id}
          sortConfig={sortConfig}
          onSort={onSort}
          resizeKey={col.id}
          onResizeStart={startResize}
          className="px-3 py-1.5 border-r border-slate-200 justify-center"
        >
          <span>{col.name}</span>
        </SortableHeader>
      ))}

      {visibleColumns.startDate && (
        <div className="relative px-3 py-1.5 border-r border-slate-200 text-center">
          Start
          <ResizeHandle columnKey="startDate" onStart={startResize} />
        </div>
      )}
      {visibleColumns.endDate && (
        <div className="relative px-3 py-1.5 border-r border-slate-200 text-center">
          End
          <ResizeHandle columnKey="endDate" onStart={startResize} />
        </div>
      )}
      {visibleColumns.dueDate && (
        <div className="relative px-3 py-1.5 border-r border-slate-200 text-center">
          Due
          <ResizeHandle columnKey="dueDate" onStart={startResize} />
        </div>
      )}
      {visibleColumns.duration && (
        <div className="relative px-3 py-1.5 border-r border-slate-200 text-center">
          Duration
          <ResizeHandle columnKey="duration" onStart={startResize} />
        </div>
      )}

      {/* Source Link header */}
      {showSource && (
        <div className="relative px-3 py-1.5 border-r border-slate-200 text-center">
          Source
          <ResizeHandle columnKey="source" onStart={startResize} />
        </div>
      )}

      {/* Updated header */}
      {visibleColumns.updated && (
        <SortableHeader
          columnKey="updated"
          sortConfig={sortConfig}
          onSort={onSort}
          resizeKey="updated"
          onResizeStart={startResize}
          className="px-3 py-1.5 border-r border-slate-200 justify-center"
        >
          <span>Updated</span>
        </SortableHeader>
      )}

      {/* CapEx/OpEx classification header */}
      {hasClassificationColumn && (
        <div className="relative px-3 py-1.5 border-r border-slate-200 text-center">
          CapEx/OpEx
          <ResizeHandle columnKey="classification" onStart={startResize} />
        </div>
      )}

      {/* Action spacer */}
      <div className="px-1 py-1.5" />
    </div>
  );
}

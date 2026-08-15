'use client';

import { buildBoardGridTemplate } from '@deckgauge/shared';
import type { GridColumnSpec } from '@deckgauge/shared';
import { InlineAddRow } from '../InlineAddRow';
import { ResizeHandle, useColumnResize } from '../ColumnHeaderRow';
import type { BoardShellProps, ShellColumn } from './types';

// Sticky-left offsets for the pinned block (color stripe + checkbox + first
// pinned column). Must match the leading structural tracks below.
const STRIPE_WIDTH = 6;
const CHECKBOX_WIDTH = 28;
const CHECKBOX_LEFT = STRIPE_WIDTH;
const PINNED_LEFT = STRIPE_WIDTH + CHECKBOX_WIDTH; // 34

function SortIndicator({ direction }: { direction: 'asc' | 'desc' }) {
  const label = direction === 'asc' ? 'Sorted ascending' : 'Sorted descending';
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="currentColor"
      className="text-indigo-500 ml-1 inline-block shrink-0"
      role="img"
      aria-label={label}
    >
      {direction === 'asc' ? <path d="M6 2L10 8H2L6 2Z" /> : <path d="M6 10L2 4H10L6 10Z" />}
    </svg>
  );
}

function SelectAllCheckbox({
  state,
  onToggle,
}: {
  state: 'none' | 'some' | 'all';
  onToggle: (select: boolean) => void;
}) {
  return (
    <input
      type="checkbox"
      aria-label="Select all visible rows in this group"
      checked={state === 'all'}
      ref={(el) => {
        if (el) el.indeterminate = state === 'some';
      }}
      onChange={() => onToggle(state !== 'all')}
      className="h-4 w-4 rounded border-slate-300 text-indigo-500 focus:ring-indigo-500/20"
    />
  );
}

/**
 * Generic, presentational board card: a grid of column headers + rows + an
 * optional summary and inline-add row, all driven by one `--board-grid-cols`
 * variable. The consumer supplies the column model and a `renderCell` for each
 * cell, plus sort/resize/selection wiring. Drag-and-drop, data ownership, and
 * group headers stay with the consumer — this renders one group's card body.
 *
 * This is the shared shell that both the project board and the org-tree
 * employee board are migrating onto (planning/BOARD-SHELL-CONVERGENCE.md).
 */
export function BoardShell<Row>({
  columns,
  rows,
  rowKey,
  rowRenderKey,
  renderCell,
  RowComponent,
  groupColor = '#6C6CFF',
  columnWidths = {},
  onColumnResize,
  sort,
  onSort,
  selection,
  onAddRow,
  renderSummary,
  trailing,
  emptyLabel = 'No items',
}: BoardShellProps<Row>) {
  // Start a resize from the column's currently-rendered width.
  const resolveWidth = (key: string) => columns.find((c) => c.key === key)?.width ?? 0;
  const startResize = useColumnResize(columnWidths, onColumnResize, resolveWidth);

  const specs: GridColumnSpec[] = columns.map((c) => ({
    width: c.width,
    ...(c.flex != null ? { flex: c.flex } : {}),
  }));
  const { template, minWidth } = buildBoardGridTemplate(specs, {
    leading: [STRIPE_WIDTH, CHECKBOX_WIDTH],
    trailing,
  });

  const gridStyle = {
    ['--board-grid-cols']: template,
    minWidth: `${minWidth}px`,
  } as React.CSSProperties;

  const rowGrid = { gridTemplateColumns: 'var(--board-grid-cols)' } as React.CSSProperties;

  const alignClass = (c: ShellColumn) =>
    c.align === 'left' ? 'justify-start text-left' : 'justify-center text-center';

  return (
    <div className="w-max min-w-full rounded-md border border-slate-200 bg-white" style={gridStyle}>
      {/* Header row */}
      <div
        className="grid items-center text-xs font-medium text-slate-500 uppercase tracking-wider bg-slate-50 border-b border-slate-200"
        style={rowGrid}
      >
        <div
          className="sticky z-20 h-full rounded-tl-md"
          style={{ backgroundColor: groupColor, left: 0 }}
        />
        <div
          className="sticky z-20 bg-slate-50 flex items-center justify-center px-1 py-1.5 border-r border-slate-200"
          style={{ left: CHECKBOX_LEFT }}
        >
          {selection ? (
            <SelectAllCheckbox state={selection.selectAllState} onToggle={selection.onSelectAll} />
          ) : (
            <div className="h-4 w-4" />
          )}
        </div>
        {columns.map((c) => {
          const isSorted = sort?.key === c.key;
          const clickable = c.sortable && onSort;
          return (
            <div
              key={c.key}
              role={clickable ? 'button' : undefined}
              tabIndex={clickable ? 0 : undefined}
              aria-label={clickable ? `Sort by ${c.label}` : undefined}
              onClick={clickable ? () => onSort!(c.key) : undefined}
              onKeyDown={
                clickable
                  ? (e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onSort!(c.key);
                      }
                    }
                  : undefined
              }
              className={[
                'relative flex items-center px-3 py-1.5 border-r border-slate-200',
                alignClass(c),
                clickable ? 'cursor-pointer select-none' : '',
                c.pinned ? 'sticky z-20 bg-slate-50' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              style={c.pinned ? { left: PINNED_LEFT } : undefined}
            >
              <span>{c.label}</span>
              {isSorted && <SortIndicator direction={sort!.direction} />}
              {onColumnResize && <ResizeHandle columnKey={c.key} onStart={startResize} />}
            </div>
          );
        })}
      </div>

      {/* Data rows */}
      {rows.length === 0 ? (
        <p className="text-center text-sm text-slate-500 py-4">{emptyLabel}</p>
      ) : (
        rows.map((row) => {
          const key = rowKey(row);
          const reactKey = rowRenderKey ? rowRenderKey(row) : key;
          const selected = selection?.isSelected(key) ?? false;
          const rowClass = `group grid items-center border-b border-slate-100 transition-colors hover:bg-slate-50 ${
            selected ? 'bg-indigo-500/10 border-indigo-500/30' : ''
          }`;
          const rowInner = (
            <>
              <div className="sticky left-0 z-10 h-full" style={{ backgroundColor: groupColor }} />
              <div
                className={`sticky z-10 bg-white flex items-center justify-center px-1 py-1 border-r border-slate-100`}
                style={{ left: CHECKBOX_LEFT }}
                onKeyDown={(e) => e.stopPropagation()}
              >
                {selection ? (
                  <input
                    type="checkbox"
                    aria-label={selection.rowLabel ? selection.rowLabel(key) : `Select row ${key}`}
                    checked={selected}
                    onChange={(e) => selection.onToggle(key, e.target.checked)}
                    data-no-dnd="true"
                    className="h-4 w-4 rounded border-slate-300 text-indigo-500 focus:ring-indigo-500/20"
                  />
                ) : (
                  <div className="h-4 w-4" />
                )}
              </div>
              {columns.map((c) => (
                <div
                  key={c.key}
                  className={[
                    'px-3 py-1 border-r border-slate-100 min-w-0',
                    c.pinned ? 'sticky z-10 bg-white' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  style={c.pinned ? { left: PINNED_LEFT } : undefined}
                  onKeyDown={(e) => e.stopPropagation()}
                >
                  {renderCell(row, c.key)}
                </div>
              ))}
            </>
          );

          if (RowComponent) {
            return (
              <RowComponent
                key={reactKey}
                row={row}
                rowKey={key}
                selected={selected}
                className={rowClass}
                style={rowGrid}
              >
                {rowInner}
              </RowComponent>
            );
          }
          return (
            <div key={reactKey} data-row-id={key} className={rowClass} style={rowGrid}>
              {rowInner}
            </div>
          );
        })
      )}

      {renderSummary && rows.length > 0 && renderSummary(rows)}

      {onAddRow && <InlineAddRow onAdd={onAddRow} groupColor={groupColor} />}
    </div>
  );
}

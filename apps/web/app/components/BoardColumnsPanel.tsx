'use client';

import { useEffect, useRef, useState } from 'react';
import { isSystemColumnVisible } from '@deckgauge/shared';
import { ColumnsIcon } from './board-header/icons';
import type { BoardColumn } from '@deckgauge/shared';

// System columns split around the custom columns to mirror the board's grid
// order. `name` (Item) is the pinned row anchor and can never be hidden.
const SIZE_COLUMN_NAME = 'Size';

const LEADING_SYSTEM: Array<{ key: string; label: string; locked?: boolean }> = [
  { key: 'name', label: 'Item', locked: true },
  { key: 'owner', label: 'Owner' },
  { key: 'assignee', label: 'Assignee' },
  { key: 'status', label: 'Status' },
];

interface TrailingRow {
  key: string;
  label: string;
  /** Only meaningful when an integration is connected. */
  integrationOnly?: boolean;
}

const TRAILING_SYSTEM: TrailingRow[] = [
  { key: 'size', label: 'Size' },
  { key: 'startDate', label: 'Start date' },
  { key: 'endDate', label: 'End date' },
  { key: 'dueDate', label: 'Due date' },
  { key: 'duration', label: 'Duration' },
  { key: 'source', label: 'Source', integrationOnly: true },
  { key: 'updated', label: 'Updated' },
  { key: 'classification', label: 'CapEx/OpEx' },
];

interface BoardColumnsPanelProps {
  columns: BoardColumn[];
  /** Keys currently hidden (system keys or custom BoardColumn ids). */
  hidden: string[];
  hasIntegration: boolean;
  disabled?: boolean;
  onToggle: (key: string) => void;
  onAddColumn: () => void;
  onDeleteColumn: (columnId: string) => void;
}

export function BoardColumnsPanel({
  columns,
  hidden,
  hasIntegration,
  disabled,
  onToggle,
  onAddColumn,
  onDeleteColumn,
}: BoardColumnsPanelProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const hiddenSet = new Set(hidden);

  // The "Size" system field is stored as a BoardColumn named "Size" but toggled
  // via the pseudo-key `size`; keep it out of the custom-column list.
  const customColumns = columns.filter((c) => c.name !== SIZE_COLUMN_NAME);
  const trailing = TRAILING_SYSTEM.filter((r) => !r.integrationOnly || hasIntegration);

  useEffect(() => {
    if (!isOpen) return;
    const handleMouseDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsOpen(false);
    };
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  const renderRow = (
    key: string,
    label: string,
    opts?: { locked?: boolean; onDelete?: () => void },
  ) => (
    <div
      key={key}
      className="flex items-center gap-2 px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-100"
    >
      <label className="flex flex-1 items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          aria-label={label}
          checked={isSystemColumnVisible(key, hiddenSet)}
          disabled={disabled || opts?.locked}
          onChange={() => onToggle(key)}
          className="rounded accent-teal-600"
        />
        <span className={opts?.locked ? 'text-slate-400' : ''}>{label}</span>
      </label>
      {opts?.onDelete && (
        <button
          type="button"
          aria-label={`Delete ${label}`}
          onClick={opts.onDelete}
          className="text-slate-400 hover:text-rose-500"
        >
          ×
        </button>
      )}
    </div>
  );

  return (
    <div ref={containerRef} className="relative inline-flex">
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        disabled={disabled}
        aria-label="Manage columns"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        className={`inline-flex h-full items-center rounded-r-lg px-2.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-500/40 ${
          isOpen ? 'bg-teal-500/10 text-teal-600' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
        }`}
      >
        <ColumnsIcon className="h-3.5 w-3.5" />
      </button>

      {isOpen && (
        <div className="absolute right-0 top-full mt-1.5 flex max-h-96 w-60 flex-col overflow-hidden rounded-xl border border-slate-200 bg-surface-1 shadow-dropdown z-50 animate-fade-in">
          <div className="overflow-y-auto py-1">
            {LEADING_SYSTEM.map((r) => renderRow(r.key, r.label, { locked: r.locked }))}

            {customColumns.length > 0 && <div className="my-1 border-t border-slate-200" />}
            {customColumns.map((col) =>
              renderRow(col.id, col.name, { onDelete: () => onDeleteColumn(col.id) }),
            )}

            <div className="my-1 border-t border-slate-200" />
            {trailing.map((r) => renderRow(r.key, r.label))}
          </div>

          <button
            type="button"
            onClick={() => {
              onAddColumn();
              setIsOpen(false);
            }}
            disabled={disabled}
            className="shrink-0 border-t border-slate-200 px-3 py-2 text-left text-xs font-medium text-teal-600 transition-colors hover:bg-teal-500/10 disabled:opacity-50"
          >
            ＋ Add column
          </button>
        </div>
      )}
    </div>
  );
}

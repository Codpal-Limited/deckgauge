'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { colorForValue } from './colorForValue';

interface OwnerSelectProps {
  /** Current effective owner value. */
  value: string;
  /** Distinct owner/assignee values already used on the board (autocomplete). */
  options: string[];
  /** Commit a new owner value (existing or freshly typed). */
  onChange: (value: string) => void;
  ariaLabel?: string;
  emptyLabel?: string;
}

/**
 * Plain combobox for the Owner cell: a colored value pill that opens a
 * type-to-filter list of values already used on the board, and lets you add
 * a new value by typing. The revert-to-synced-value affordance lives in
 * `OverrideBadge`, rendered alongside this component by the caller.
 */
export function OwnerSelect({
  value,
  options,
  onChange,
  ariaLabel = 'Owner',
  emptyLabel = '—',
}: OwnerSelectProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        setDraft('');
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const hasValue = value.trim() !== '';

  const filtered = useMemo(() => {
    const q = draft.trim().toLowerCase();
    const unique = Array.from(new Set(options.filter((o) => o.trim() !== '')));
    if (!q) return unique;
    return unique.filter((o) => o.toLowerCase().includes(q));
  }, [options, draft]);

  const trimmed = draft.trim();
  const exactExists = filtered.some((o) => o.toLowerCase() === trimmed.toLowerCase());
  const canAdd = trimmed.length > 0 && !exactExists;

  const commit = (v: string) => {
    onChange(v);
    setOpen(false);
    setDraft('');
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (canAdd) commit(trimmed);
      else if (filtered.length === 1 && filtered[0]) commit(filtered[0]);
    } else if (e.key === 'Escape') {
      setOpen(false);
      setDraft('');
    }
  };

  return (
    <div ref={rootRef} className="relative w-full">
      <button
        type="button"
        aria-label={ariaLabel}
        onClick={() => setOpen((o) => !o)}
        className="w-full cursor-pointer truncate rounded-sm border-0 px-2 py-1 text-left text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-indigo-300"
        style={{ backgroundColor: colorForValue(value), color: hasValue ? '#ffffff' : '#475569' }}
      >
        {hasValue ? value : emptyLabel}
      </button>

      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 w-48 rounded border border-slate-200 bg-white p-1 shadow-lg">
          <input
            ref={inputRef}
            aria-label={`Filter or add ${ariaLabel}`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Type a name..."
            className="mb-1 w-full rounded border border-slate-200 px-2 py-1 text-xs focus:border-indigo-300 focus:outline-none"
          />

          <div className="max-h-48 overflow-y-auto">
            {filtered.map((o) => (
              <button
                key={o}
                type="button"
                onClick={() => commit(o)}
                className="mb-0.5 block w-full truncate rounded px-2 py-1 text-left text-xs font-semibold text-white"
                style={{ backgroundColor: colorForValue(o) }}
              >
                {o}
              </button>
            ))}
            {filtered.length === 0 && !canAdd && (
              <div className="px-2 py-1 text-xs text-slate-400">No matches</div>
            )}
          </div>

          {canAdd && (
            <button
              type="button"
              aria-label={`Add ${trimmed}`}
              onClick={() => commit(trimmed)}
              className="mt-1 block w-full truncate rounded border-t border-slate-100 px-2 py-1 text-left text-xs text-slate-600 hover:bg-slate-50"
            >
              + Add &ldquo;{trimmed}&rdquo;
            </button>
          )}
        </div>
      )}
    </div>
  );
}

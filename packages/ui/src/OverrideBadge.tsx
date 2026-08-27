'use client';

import { useEffect, useRef, useState } from 'react';

interface OverrideBadgeProps {
  /** Human field name, e.g. "Due date". Used in the accessible trigger name. */
  label: string;
  /**
   * The pre-edit synced value, ALREADY formatted for display by the caller.
   * An empty string renders as "empty" rather than a blank gap, so the user can
   * tell "the source had nothing" from "we failed to load it".
   */
  syncedValueLabel: string;
  onRevert: () => void;
}

/**
 * The dot a cell wears once a manual edit has taken it over, and the popover
 * that undoes that edit.
 *
 * Deliberately field-agnostic: the caller formats `syncedValueLabel`, so a date
 * cell, an owner cell and a text cell all get an identical affordance without
 * this component knowing any field's display rules.
 */
export function OverrideBadge({ label, syncedValueLabel, onRevert }: OverrideBadgeProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  return (
    <span ref={rootRef} className="relative inline-flex shrink-0">
      <button
        type="button"
        aria-label={`${label} was edited manually`}
        title={`${label} was edited manually — click to revert`}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="h-1.5 w-1.5 rounded-full bg-amber-500 hover:ring-2 hover:ring-amber-200"
      />

      {open && (
        <div className="absolute right-0 top-full z-40 mt-1 w-56 rounded border border-slate-200 bg-white p-2 text-left shadow-lg">
          <p className="mb-2 text-xs text-slate-600">
            Edited manually. Synced value was{' '}
            <span className="font-medium text-slate-900">
              {syncedValueLabel.trim() === '' ? 'empty' : syncedValueLabel}
            </span>
            .
          </p>
          <button
            type="button"
            aria-label="Revert to synced value"
            onClick={(e) => {
              e.stopPropagation();
              onRevert();
              setOpen(false);
            }}
            className="block w-full rounded px-2 py-1 text-left text-xs text-indigo-600 hover:bg-indigo-50"
          >
            {'↺'} Revert to synced value
          </button>
        </div>
      )}
    </span>
  );
}

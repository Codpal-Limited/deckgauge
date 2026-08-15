'use client';

import { useState } from 'react';
import { createPortal } from 'react-dom';

interface CreateEntityDialogProps {
  /** Heading — the entity type or board-template label (e.g. "Development", "Roadmap"). */
  title: string;
  icon: JSX.Element;
  /** One short paragraph explaining what the entity is for. */
  summary: string;
  /** "What you get" bullets. */
  highlights: readonly string[];
  /** Optional muted line under the button (e.g. board "Next: connect …"). */
  footnote?: string;
  /** Label above the name input. Defaults to "Name". */
  nameLabel?: string;
  namePlaceholder?: string;
  onCancel: () => void;
  onCreate: (name: string) => void;
  isPending?: boolean;
}

/**
 * Shared "explain then name" modal for every sidebar create action (boards,
 * roadmaps, org trees, comparisons). Explains what the entity does, takes a
 * name, and commits via `onCreate`; the caller performs the create + routing.
 *
 * Rendered through a portal to <body> so the fixed overlay escapes the sidebar's
 * `position: sticky` stacking context — otherwise the backdrop and card paint
 * behind the board content instead of over the whole viewport.
 */
export function CreateEntityDialog({
  title,
  icon,
  summary,
  highlights,
  footnote,
  nameLabel = 'Name',
  namePlaceholder,
  onCancel,
  onCreate,
  isPending = false,
}: CreateEntityDialogProps) {
  const [name, setName] = useState('');
  const trimmed = name.trim();
  const canCreate = trimmed.length > 0 && !isPending;

  const submit = () => {
    if (canCreate) onCreate(trimmed);
  };

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-entity-title"
        className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl"
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel();
        }}
      >
        <div className="flex items-start gap-3">
          <span
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600 [&>svg]:h-5 [&>svg]:w-5"
            aria-hidden="true"
          >
            {icon}
          </span>
          <div>
            <h2 id="create-entity-title" className="text-base font-semibold text-slate-900">
              {title}
            </h2>
            <p className="mt-1 text-sm leading-relaxed text-slate-500">{summary}</p>
          </div>
        </div>

        <ul className="mt-4 space-y-1.5">
          {highlights.map((h) => (
            <li key={h} className="flex items-start gap-2 text-sm text-slate-600">
              <svg
                viewBox="0 0 20 20"
                fill="currentColor"
                className="mt-0.5 h-4 w-4 shrink-0 text-indigo-500"
                aria-hidden="true"
              >
                <path
                  fillRule="evenodd"
                  d="M16.7 5.3a1 1 0 0 1 0 1.4l-7.5 7.5a1 1 0 0 1-1.4 0l-3.5-3.5a1 1 0 1 1 1.4-1.4l2.8 2.79 6.8-6.79a1 1 0 0 1 1.4 0Z"
                  clipRule="evenodd"
                />
              </svg>
              {h}
            </li>
          ))}
        </ul>

        <label className="mt-5 block text-xs font-semibold uppercase tracking-wide text-slate-500">
          {nameLabel}
          <input
            aria-label={nameLabel}
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
            }}
            placeholder={namePlaceholder}
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-normal text-slate-900 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
          />
        </label>

        {footnote && <p className="mt-2 text-xs text-slate-400">{footnote}</p>}

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!canCreate}
            className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-indigo-500 to-violet-500 px-4 py-1.5 text-sm font-semibold text-white shadow-sm transition enabled:hover:from-indigo-600 enabled:hover:to-violet-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isPending ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  BUCKET_HINT,
  BUCKET_LABEL,
  STATUS_BUCKETS,
  type PooledStatus,
  type StatusBucket,
} from '@deckgauge/shared';
import { saveOrgTreeStatusBuckets } from '../../actions/org-tree-timesheet';

/**
 * Colours live here, not in `packages/shared`.
 *
 * A Tailwind class is not domain vocabulary, and the two surfaces that speak
 * buckets use DIFFERENT palettes by decision (option A): this panel follows
 * Jira's status categories, which is what the owner asked for — "we have todo
 * statuses in grey and 'In progress' statuses in 'Blue'" — while Team Focus
 * keeps `STAGE_COLOR`.
 *
 * The two buckets Jira has no category for get their own colours rather than
 * borrowing one: amber for parked, because it is the finding the fifth bucket
 * was added to surface, and rose for abandoned, because it leaves delivery
 * figures entirely.
 */
const BUCKET_ACCENT: Record<StatusBucket, string> = {
  TODO: 'bg-slate-400',
  IN_PROGRESS: 'bg-blue-500',
  WAITING_TO_SHIP: 'bg-amber-500',
  DONE: 'bg-emerald-500',
  ABORTED: 'bg-rose-400',
};

export interface StatusBucketDrawerProps {
  orgTreeId: string;
  /**
   * Shown in the header, because this panel has NO SCRIM and the tree picker
   * behind it stays live — an operator can switch the grid to another team while
   * this is open. The write stays correct either way (it matches the pool on
   * screen), but without the name nothing says which team that is. The panel is
   * deliberately not closed on a tree change: that would discard unsaved edits
   * silently, which is worse than a label.
   */
  orgTreeName: string;
  /** Every status the tree's people have been in, with what it currently means. */
  pool: PooledStatus[];
  /**
   * Whether this tree already has a timesheet config row.
   *
   * The pool looks identical either way, but it does not MEAN the same thing:
   * on a configured tree these buckets reflect what is being counted, on an
   * unconfigured one they are a proposal that is moving nobody's hours yet.
   * Configuration is opt-in per tree (slice 2b-iii), so the drawer has to say
   * which of the two the reader is looking at.
   */
  configured: boolean;
  onClose: () => void;
  /** Handed the DERIVED counted list, so the caller can refresh the grid. */
  onSaved?: (activeStatuses: string[]) => void;
}

export function StatusBucketDrawer({
  orgTreeId,
  orgTreeName,
  pool,
  configured,
  onClose,
  onSaved,
}: StatusBucketDrawerProps) {
  // Keyed by status name, which is the identity the whole panel works in — one
  // decision per name, applied to every source reporting it, so the operator
  // never sees the same word twice.
  const [buckets, setBuckets] = useState<Record<string, StatusBucket>>(() =>
    Object.fromEntries(pool.map((p) => [p.status, p.bucket])),
  );
  const [filter, setFilter] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  /**
   * The full set, in the pool's order — NOT the filtered view.
   *
   * The filter is a view, not a selection. Sending only the visible rows would
   * silently leave everything the operator scrolled past to be re-seeded, which
   * is the opposite of what saving means.
   */
  const decisions: PooledStatus[] = useMemo(
    () => pool.map((p) => ({ status: p.status, bucket: buckets[p.status] ?? p.bucket })),
    [pool, buckets],
  );

  const countsAsWork = decisions.filter((d) => d.bucket === 'IN_PROGRESS').length;

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q === '' ? decisions : decisions.filter((d) => d.status.toLowerCase().includes(q));
  }, [decisions, filter]);

  async function onSave() {
    setSaving(true);
    setError(null);
    try {
      const { activeStatuses } = await saveOrgTreeStatusBuckets(orgTreeId, decisions);
      onSaved?.(activeStatuses);
    } catch {
      // Surfaced, and the drawer STAYS OPEN. Closing on a failed write is how an
      // operator comes to believe the hours moved.
      setError('Could not save — nothing was changed. Try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    // NO SCRIM, deliberately: this panel rewrites the grid behind it and the
    // operator needs to read that grid while working. `TicketDetailDrawer` has
    // one because nothing behind it changes.
    <aside
      aria-label="Time rules"
      className="fixed right-0 top-14 z-50 flex h-[calc(100%-3.5rem)] w-[26rem] max-w-full flex-col
                 border-l border-slate-200 bg-white shadow-dropdown animate-slide-in-right"
    >
      <div className="border-b border-slate-200 px-4 pb-3 pt-4">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-slate-800">Time rules</h2>
            <p className="text-xs font-medium text-slate-600">{orgTreeName}</p>
            <p className="mt-0.5 text-xs text-slate-500">
              Say what each status means. Only{' '}
              <span className="font-medium text-slate-700">{BUCKET_LABEL.IN_PROGRESS}</span> counts
              as work on the timesheet.
            </p>
          </div>
          <button
            type="button"
            aria-label="close drawer"
            onClick={onClose}
            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            ×
          </button>
        </div>

        <p className="mt-3 text-xs text-slate-500">
          <span
            data-testid="counts-as-work"
            className="rounded bg-blue-50 px-1.5 py-0.5 font-semibold text-blue-700"
          >
            {countsAsWork}
          </span>{' '}
          of {decisions.length} statuses count as work
        </p>

        {!configured && (
          <p
            role="status"
            className="mt-3 rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-800"
          >
            These are suggestions — they are not applied to this team&apos;s hours yet. Save to
            start using them.
          </p>
        )}

        <input
          aria-label="Filter statuses"
          className="mt-3 w-full rounded border border-slate-200 px-2.5 py-1.5 text-sm
                     focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
          placeholder="Filter statuses…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3">
        {decisions.length === 0 ? (
          <p className="py-8 text-center text-sm text-slate-400">
            No statuses yet. Once this team&apos;s work moves through a board, its statuses appear
            here.
          </p>
        ) : (
          // Sections in STATUS_BUCKETS order, which is ordered as work flows. A
          // hand-ordered list here would be a second source of truth for it.
          <div className="flex flex-col gap-5">
            {STATUS_BUCKETS.map((bucket) => {
              const rows = visible.filter((d) => d.bucket === bucket);
              return (
                <section key={bucket}>
                  <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                    <i
                      className={`h-2 w-2 rounded-sm ${BUCKET_ACCENT[bucket]}`}
                      aria-hidden="true"
                    />
                    {BUCKET_LABEL[bucket]}
                    <span className="font-normal normal-case tracking-normal text-slate-400">
                      {rows.length}
                    </span>
                  </h3>
                  <p className="mt-1 text-[11px] leading-snug text-slate-400">
                    {BUCKET_HINT[bucket]}
                  </p>
                  {rows.length === 0 ? (
                    <p className="mt-2 text-xs text-slate-300">—</p>
                  ) : (
                    <ul className="mt-2 flex flex-col gap-1">
                      {rows.map((d) => (
                        <li
                          key={d.status}
                          className="flex items-center justify-between gap-2 rounded border border-slate-100 bg-slate-50/60 px-2 py-1"
                        >
                          <span className="truncate text-sm text-slate-700" title={d.status}>
                            {d.status}
                          </span>
                          <select
                            aria-label={`Bucket for ${d.status}`}
                            value={d.bucket}
                            onChange={(e) =>
                              setBuckets((prev) => ({
                                ...prev,
                                [d.status]: e.target.value as StatusBucket,
                              }))
                            }
                            className="shrink-0 rounded border border-slate-200 bg-white px-1.5 py-0.5 text-xs text-slate-600
                                       focus:border-blue-500 focus:outline-none"
                          >
                            {STATUS_BUCKETS.map((b) => (
                              <option key={b} value={b}>
                                {BUCKET_LABEL[b]}
                              </option>
                            ))}
                          </select>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              );
            })}
          </div>
        )}
      </div>

      <div className="border-t border-slate-200 px-4 py-3">
        {error && (
          <p
            role="alert"
            className="mb-2 rounded border border-rose-200 bg-rose-50 px-2 py-1.5 text-xs text-rose-700"
          >
            {error}
          </p>
        )}
        <button
          type="button"
          onClick={onSave}
          disabled={saving || decisions.length === 0}
          className="btn-primary w-full disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </aside>
  );
}

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  FOCUS_PROVIDERS,
  type FocusProvider,
  type FocusStage,
  type FocusStageMapSettings,
  type StageMapOverrides,
} from '@deckgauge/shared';
import { fetchFocusStageMap, saveFocusStageMap } from '../../../../actions/focus-config';
import { STAGE_COLOR, STAGE_LABEL, type FocusStageKey } from './focus-ui';

/**
 * Which source state means which delivery stage, for one board.
 *
 * The line this editor exists to let a board draw is the one between IN
 * DEVELOPMENT and WAITING TO SHIP: in development is still the engineer's to
 * finish, waiting to ship is not. A board whose states the shipped default has
 * never heard of reports every one of them as "not started / stalled", which
 * reads as a team that stopped working rather than a map that needs a line
 * adding — so the unmapped states sort to the top and say what they currently
 * count as.
 *
 * All four stages are offered, not just the arguable two. A migrated workflow
 * carries states like "Ready for Production" and "Cancelled" that belong at the
 * ends, and offering only the middle pair would force them into the wrong bar.
 */

const PROVIDER_LABEL: Record<FocusProvider, string> = {
  jira: 'Jira',
  ado: 'Azure DevOps',
};

/**
 * This dialog's dropdown order — NOT the same declaration as the identically
 * named `STAGE_ORDER` in `FocusChartWidgets.tsx`, which orders the funnel's
 * segments. Two unrelated constants that must move together.
 */
const STAGE_ORDER: FocusStageKey[] = [
  'IN_PRODUCTION',
  'WAITING_TO_SHIP',
  'IN_DEVELOPMENT',
  'CANCELLED',
  'NOT_STARTED',
];

const USE_DEFAULT = '';

interface Props {
  open: boolean;
  boardId: string;
  onClose: () => void;
  /** Called after a save lands, so the widget can refetch its numbers. */
  onSaved?: (settings: FocusStageMapSettings) => void;
}

type Draft = Record<FocusProvider, Record<string, FocusStage>>;

function draftFrom(overrides: StageMapOverrides): Draft {
  return { jira: { ...(overrides.jira ?? {}) }, ado: { ...(overrides.ado ?? {}) } };
}

function overridesFrom(draft: Draft): StageMapOverrides {
  const out: StageMapOverrides = {};
  for (const provider of FOCUS_PROVIDERS) {
    if (Object.keys(draft[provider]).length > 0) out[provider] = { ...draft[provider] };
  }
  return out;
}

/**
 * The rows for one provider: everything it reports, plus anything this board has
 * already decided about.
 *
 * The second half is deliberate. A state can go quiet — renamed upstream, or
 * simply unused this window — without the decision about it becoming wrong, and
 * dropping its row would discard the mapping on the next save. Unmapped states
 * lead, because they are the reason anyone opened this.
 */
function rowsFor(
  provider: FocusProvider,
  settings: FocusStageMapSettings,
  unmapped: ReadonlySet<string>,
): string[] {
  const states = new Set([
    ...settings.observed[provider],
    ...Object.keys(settings.overrides[provider] ?? {}),
  ]);
  return [...states].sort((a, b) => {
    const aUnmapped = unmapped.has(a) ? 0 : 1;
    const bUnmapped = unmapped.has(b) ? 0 : 1;
    return aUnmapped - bUnmapped || a.localeCompare(b);
  });
}

export function FocusStageMapEditor({ open, boardId, onClose, onSaved }: Props) {
  const [settings, setSettings] = useState<FocusStageMapSettings | null>(null);
  const [draft, setDraft] = useState<Draft>({ jira: {}, ado: {} });
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setLoading(true);
    setLoadError(null);
    setSaveError(null);
    fetchFocusStageMap(boardId)
      .then((s) => {
        if (!live) return;
        setSettings(s);
        setDraft(draftFrom(s.overrides));
      })
      .catch((err: unknown) => {
        if (!live) return;
        setLoadError(err instanceof Error ? err.message : 'Failed to load the stage map');
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [open, boardId]);

  /**
   * Focus enters the panel on open and returns to whatever had it on close.
   *
   * Keyed on `open` ALONE, and separate from the Escape listener below, because
   * the two have incompatible dependencies. The listener needs `onClose`, which
   * the call site passes as an inline arrow (`FocusChartWidgets.tsx`), so it has
   * a fresh identity on every render of the funnel widget — and the funnel
   * re-renders whenever `useWidgetData` yields a new object or `DashboardCanvas`
   * re-renders. Combined into one effect, each of those re-renders ran this
   * cleanup (focus jumping to the trigger BEHIND the modal) and then re-ran it
   * (focus jumping to Close), losing the user's place mid-edit.
   *
   * `sharing/ShareDialog.tsx:57-71` already splits them for this reason; its
   * Escape cleanup removes the listener and nothing else, which is what makes
   * `onClose` in those deps harmless.
   */
  useEffect(() => {
    if (!open) return;
    const restoreTo = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => {
      restoreTo?.focus?.();
    };
  }, [open]);

  // Escape closes. Cleanup removes the listener and has no other side effect,
  // so re-running it on a new `onClose` identity is free — see above.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const unmappedByProvider = useMemo(() => {
    const out: Record<FocusProvider, Set<string>> = { jira: new Set(), ado: new Set() };
    for (const u of settings?.unmapped ?? []) out[u.provider].add(u.state);
    return out;
  }, [settings]);

  const setStage = useCallback((provider: FocusProvider, state: string, value: string) => {
    setDraft((prev) => {
      const next: Draft = { jira: { ...prev.jira }, ado: { ...prev.ado } };
      if (value === USE_DEFAULT) delete next[provider][state];
      else next[provider][state] = value as FocusStage;
      return next;
    });
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    // The action RETURNS its failure rather than throwing — a thrown error in a
    // server action reaches the browser as an opaque Next digest, and the
    // message is the useful part here (it names the offending state).
    const outcome = await saveFocusStageMap(boardId, overridesFrom(draft));
    setSaving(false);
    if (!outcome.ok) {
      setSaveError(outcome.error);
      return;
    }
    onSaved?.(outcome.settings);
    onClose();
  }, [boardId, draft, onSaved, onClose]);

  if (!open) return null;
  // Next server-renders this client component, and `createPortal` below would
  // throw on `document`. Nothing to reconcile: the in-place output is empty on
  // both sides. Same guard as `sidebar/CreateEntityDialog.tsx`.
  if (typeof document === 'undefined') return null;

  const observedCount = settings
    ? settings.observed.jira.length + settings.observed.ado.length
    : 0;
  // "overridden", not "mapped". A board whose every state the shipped defaults
  // already place correctly is fully MAPPED and would read "0 mapped" here —
  // the wrong word in a dialog that exists to fix a misleading number.
  const overriddenCount = Object.keys(draft.jira).length + Object.keys(draft.ado).length;
  const providersWithRows = settings
    ? FOCUS_PROVIDERS.filter((p) => rowsFor(p, settings, unmappedByProvider[p]).length > 0)
    : [];

  // Portaled, not rendered in place. Every widget lives inside a
  // react-grid-layout item carrying `transform: translate(...)`, and a
  // transformed ancestor is the containing block for `position: fixed`
  // descendants — so `inset-0` resolved against the WIDGET's box while
  // `max-h-[85vh]` stayed viewport-relative. The dialog came out taller than
  // the box it was pinned to: it hung off the top of the page with Save below
  // the fold, over a backdrop that dimmed one widget instead of the screen,
  // and `WidgetCard`'s `overflow-hidden` clipped the rest. `WidgetHelpButton`
  // and `CreateEntityDialog` portal for the same reason.
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Focus stage map"
        className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-5 py-3 border-b border-slate-100 flex items-center gap-3">
          <h2 className="text-sm font-semibold text-slate-900">Focus stage map</h2>
          {settings && (
            <span className="text-xs text-slate-500">
              {overriddenCount} overridden of {observedCount} observed
            </span>
          )}
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="ml-auto text-slate-400 hover:text-slate-700 text-lg leading-none"
          >
            ×
          </button>
        </header>

        <div className="px-5 py-3 text-xs text-slate-600 border-b border-slate-100">
          Which source state means which delivery stage. The line that matters is{' '}
          <b className="text-slate-800">in development</b> versus{' '}
          <b className="text-slate-800">waiting to ship</b>: in development is still the
          engineer&apos;s to finish, waiting to ship is not. A state left on{' '}
          <span className="font-mono text-[11px] mx-0.5 px-1 bg-slate-100 rounded">
            — use default —
          </span>
          uses the shipped map, and a state the shipped map does not know counts as not started.
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-3">
          {loading && <p className="text-sm text-slate-400">Loading…</p>}

          {loadError && (
            <div className="text-sm text-rose-700">
              <p className="font-medium">Could not load this board&apos;s stage map.</p>
              <p className="text-xs mt-1">{loadError}</p>
            </div>
          )}

          {settings && !loading && !loadError && providersWithRows.length === 0 && (
            <p className="text-sm text-slate-600">
              This board&apos;s sources report no states yet, so there is nothing to map. Check
              that a Jira or Azure DevOps source is attached and has completed a sync.
            </p>
          )}

          {settings &&
            !loading &&
            !loadError &&
            providersWithRows.map((provider) => {
              const rows = rowsFor(provider, settings, unmappedByProvider[provider]);
              return (
                <section key={provider} className="mb-5 last:mb-0">
                  <h3 className="text-xs font-semibold text-slate-700 mb-1.5">
                    {PROVIDER_LABEL[provider]}
                  </h3>
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-[11px] uppercase tracking-wide text-slate-400">
                        <th scope="col" className="font-medium pb-1">
                          Source state
                        </th>
                        <th scope="col" className="font-medium pb-1 w-56">
                          Delivery stage
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((state) => {
                        const chosen = draft[provider][state];
                        // What this row ACTUALLY falls back to with no board
                        // override — which is `effective`, not `defaults`, since
                        // the organization's Time rules decisions sit between
                        // the two. Reading `defaults` printed "Default · Waiting
                        // to ship" for a state the funnel was counting as In
                        // development.
                        const fallback = settings.effective[provider][state];
                        // Named differently when it did NOT come from the
                        // shipped map, so an operator can tell a product default
                        // from a decision their organization made — and knows
                        // there is somewhere else to change it.
                        const fromTimeRules = fallback !== settings.defaults[provider][state];
                        const isUnmapped = unmappedByProvider[provider].has(state);
                        return (
                          <tr key={state} className="border-t border-slate-100">
                            <td className="py-1.5 pr-3 align-middle">
                              <span className="text-slate-800">{state}</span>
                              {isUnmapped && !chosen && (
                                <span className="block text-[11px] text-amber-700">
                                  Not in the shipped map — counted as not started
                                </span>
                              )}
                              {!isUnmapped && !chosen && fallback && (
                                <span className="block text-[11px] text-slate-400">
                                  {fromTimeRules ? 'Time rules' : 'Default'} · {STAGE_LABEL[fallback]}
                                </span>
                              )}
                            </td>
                            <td className="py-1.5 align-middle">
                              <select
                                aria-label={`Stage for ${provider} state ${state}`}
                                className="w-full text-sm border border-slate-200 rounded px-2 py-1 bg-white"
                                style={chosen ? { color: STAGE_COLOR[chosen] } : undefined}
                                value={chosen ?? USE_DEFAULT}
                                onChange={(e) => setStage(provider, state, e.target.value)}
                              >
                                <option value={USE_DEFAULT}>— use default —</option>
                                {STAGE_ORDER.map((stage) => (
                                  <option key={stage} value={stage}>
                                    {STAGE_LABEL[stage]}
                                  </option>
                                ))}
                              </select>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </section>
              );
            })}
        </div>

        <footer className="px-5 py-3 border-t border-slate-100 flex items-center gap-3">
          {saveError && <p className="text-xs text-rose-700 flex-1">{saveError}</p>}
          <button
            type="button"
            onClick={onClose}
            className="ml-auto text-sm text-slate-500 hover:text-slate-700 px-3 py-1.5"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || loading || !!loadError}
            className="text-sm text-white bg-slate-800 hover:bg-slate-900 disabled:opacity-50 rounded px-3 py-1.5"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

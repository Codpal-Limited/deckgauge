'use client';
import { useEffect, useRef, useState } from 'react';
import { clearFocusVerdict, setFocusVerdict } from '../../../../actions/focus-verdicts';
import {
  CLASS_COLOR,
  CLASS_GLYPH,
  CLASS_KEYS,
  CLASS_LABEL,
  classPillLabel,
  type FocusClassKey,
} from './focus-ui';

interface Props {
  boardId: string;
  taskKey: string;
  /**
   * The `focus_verdicts` row this task's class is filed under. Content-addressed
   * — see `taskFingerprint` — which is why the write is keyed by this and not by
   * `taskKey`.
   */
  fingerprint: string;
  cls: FocusClassKey;
  /** Whether a person set this class, as opposed to a rule, the board or a model. */
  overridden: boolean;
  /** Re-read the widget, so the new class replaces the old one on screen. */
  onSaved: () => void;
}

/**
 * The ledger's class cell, as a control.
 *
 * A human verdict is the top of the precedence order (R6.5) — above the
 * finance-maintained CAPEX flag, the rules and the model — so this one cell
 * overrules every other classifier on the page. That is why the popover states
 * what it is doing rather than presenting four bare letters.
 */
export function FocusClassPicker({
  boardId,
  taskKey,
  fingerprint,
  cls,
  overridden,
  onSaved,
}: Props) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Escape and click-away, matching `WidgetHelpButton` and the dashboard's other
  // popovers. Copied rather than invented: this panel overlays a scrolling table
  // and without it there is no keyboard way out, and two of these can sit open at
  // once.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onClickAway = (e: MouseEvent) => {
      const t = e.target as Node;
      if (buttonRef.current?.contains(t)) return;
      if (panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClickAway);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClickAway);
    };
  }, [open]);

  async function run(action: () => Promise<{ ok: true } | { ok: false; error: string }>) {
    setSaving(true);
    setError(null);
    const result = await action();
    setSaving(false);
    if (!result.ok) {
      // Kept on screen rather than swallowed. The API refuses a caller who holds
      // board access without an organization membership, and that sentence is
      // the only thing that explains why the class did not change.
      setError(result.error);
      return;
    }
    setOpen(false);
    setReason('');
    onSaved();
  }

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-label={`Set classification for ${taskKey} (currently ${CLASS_LABEL[cls]})`}
        onClick={() => setOpen(!open)}
        className={`inline-grid place-items-center w-5 h-5 rounded text-[11px] font-bold text-white transition-shadow hover:ring-2 hover:ring-slate-300 ${
          // A person's call is ringed, so it does not read as the system's.
          overridden ? 'ring-2 ring-offset-1 ring-slate-800' : ''
        }`}
        style={{ background: CLASS_COLOR[cls] }}
      >
        {CLASS_GLYPH[cls]}
      </button>

      {open && (
        <div
          ref={panelRef}
          // Named, and a region rather than a bare div: the class options reuse
          // `classPillLabel`, so their names are identical to the ledger's filter
          // pills. Without a labelled region there is no way — for a test or for
          // a screen-reader user — to tell "filter the table to OPEX" apart from
          // "declare this task OPEX", which are very different actions.
          role="dialog"
          aria-label={`Classification options for ${taskKey}`}
          className="absolute left-0 top-6 z-50 w-64 rounded-lg border border-slate-200 bg-white p-2 shadow-lg"
        >
          <p className="px-1 pb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
            Set classification
          </p>
          <div className="flex flex-col gap-0.5">
            {CLASS_KEYS.map((c) => (
              <button
                key={c}
                type="button"
                disabled={saving}
                onClick={() => run(() => setFocusVerdict(boardId, fingerprint, c, reason.trim() || undefined))}
                className={`flex items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] hover:bg-slate-50 disabled:opacity-50 ${
                  c === cls ? 'font-semibold text-slate-900' : 'text-slate-600'
                }`}
              >
                <span
                  aria-hidden
                  className="inline-grid h-4 w-4 place-items-center rounded text-[10px] font-bold text-white"
                  style={{ background: CLASS_COLOR[c] }}
                >
                  {CLASS_GLYPH[c]}
                </span>
                {classPillLabel(c)}
              </button>
            ))}
          </div>

          <label className="mt-2 block px-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
            Why (optional)
            <input
              type="text"
              value={reason}
              maxLength={400}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Printed in the ledger"
              className="mt-1 w-full rounded border border-slate-200 px-2 py-1 text-[13px] font-normal normal-case tracking-normal text-slate-700"
            />
          </label>

          {/*
            Clearing is its own control, not the Unclassified option. They are
            different statements: Unclassified means someone looked and could not
            classify it, and outranks the rules; clearing forgets the decision and
            lets the classifiers below a human answer again.
          */}
          {overridden && (
            <button
              type="button"
              disabled={saving}
              onClick={() => run(() => clearFocusVerdict(boardId, fingerprint))}
              className="mt-2 w-full rounded px-2 py-1.5 text-left text-[13px] text-red-600 hover:bg-red-50 disabled:opacity-50"
            >
              Clear override
            </button>
          )}

          {error && <p className="mt-2 px-1 text-[12px] text-red-600">{error}</p>}
        </div>
      )}
    </div>
  );
}

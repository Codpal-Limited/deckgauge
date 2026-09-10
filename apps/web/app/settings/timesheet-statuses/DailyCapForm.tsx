'use client';

import { useState } from 'react';
import { DEFAULT_DAILY_CAP_HOURS } from '@deckgauge/shared';
import { saveOrgTreeDailyCap } from '../../actions/org-tree-timesheet';

interface DailyCapFormProps {
  orgTreeId: string;
  /** null = unconfigured (engine default); 0 = uncapped. */
  initialDailyCapHours: number | null;
  /**
   * Whether this tree has a timesheet config row at all.
   *
   * The cap cannot be set without one, and this form must not be the thing that
   * creates it: the row's EXISTENCE is the timesheet override, so a row born
   * without a status list means "count nothing" and zeroes the whole tree. The
   * API refuses that with a 409; this prop is what keeps the operator from
   * meeting it.
   */
  configured: boolean;
}

/**
 * The per-day hours cap, and only that.
 *
 * What used to live beside it — picking which statuses count as work — moved to
 * the Time rules drawer on the Timesheet page, where the numbers it changes are
 * visible while you change them. This form deliberately mentions statuses
 * nowhere: two places for one decision is worse than either.
 */
export function DailyCapForm({
  orgTreeId,
  initialDailyCapHours,
  configured,
}: DailyCapFormProps) {
  const [capInput, setCapInput] = useState(
    initialDailyCapHours == null ? '' : String(initialDailyCapHours),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSave() {
    const trimmed = capInput.trim();
    // Blank is `null`, NOT `Number('')` — which is 0, and 0 means UNCAPPED.
    // Those are opposite ends of the range: null falls back to the engine
    // default, 0 removes the ceiling entirely.
    const dailyCapHours = trimmed === '' ? null : Number(trimmed);
    setSaving(true);
    setError(null);
    try {
      await saveOrgTreeDailyCap(orgTreeId, dailyCapHours);
    } catch {
      setError('Could not save — nothing was changed. Try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor="daily-cap-hours" className="text-sm font-medium text-slate-700">
        Daily hours cap
      </label>
      <input
        id="daily-cap-hours"
        type="number"
        min={0}
        max={24}
        step="0.5"
        className="w-32 rounded border border-slate-200 px-3 py-2 text-sm disabled:bg-slate-50 disabled:text-slate-400"
        placeholder={String(DEFAULT_DAILY_CAP_HOURS)}
        value={capInput}
        disabled={!configured}
        onChange={(e) => setCapInput(e.target.value)}
      />
      <p className="text-xs text-slate-500">
        Caps each engineer&apos;s counted time per day so tickets left in progress overnight
        can&apos;t inflate a day past capacity. Blank = default&nbsp;{DEFAULT_DAILY_CAP_HOURS}h;
        0 = uncapped.
      </p>
      {!configured && (
        <p role="note" className="text-xs text-amber-700">
          Set Time rules for this team first — open them from the Timesheet page. A cap on its own
          has nothing to apply to yet.
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-rose-600">
          {error}
        </p>
      )}
      <button
        type="button"
        onClick={onSave}
        disabled={saving || !configured}
        className="mt-2 self-start rounded bg-indigo-500 px-4 py-1.5 text-sm text-white disabled:opacity-50"
      >
        {saving ? 'Saving…' : 'Save'}
      </button>
    </div>
  );
}

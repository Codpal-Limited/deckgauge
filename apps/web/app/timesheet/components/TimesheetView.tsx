'use client';

import { useState } from 'react';
import type { TimesheetGridResponse, IntervalsResponse } from '@deckgauge/shared';
import {
  fetchTimesheetGridForTree,
  fetchIntervals,
  fetchTicketActivity,
  type TicketActivityResult,
} from '../../actions/timesheet';
import { resolveWindow, formatPeriodLabel } from '../lib/timesheet-ui';
import { TimesheetGrid } from './TimesheetGrid';
import { buildGridCsv } from '../lib/grid-csv';
import { PeriodNavigator } from './PeriodNavigator';
import { SegmentedControl } from './SegmentedControl';
import { TicketDetailDrawer } from './TicketDetailDrawer';

function downloadCsv(filename: string, contents: string): void {
  // Prepend a UTF-8 BOM so Excel decodes the file as UTF-8 rather than a legacy
  // codepage (which mangles the em dash in "KEY — Title" into "KEY ,Äî Title").
  const BOM = String.fromCharCode(0xfeff);
  const blob = new Blob([BOM + contents], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

interface DrawerState {
  issueKey: string;
  employeeId: string;
  /** The grid cell's own attributed seconds — see TicketDetailDrawer. */
  countedSeconds: number;
  data: IntervalsResponse | null;
  activity: TicketActivityResult | null;
}

type View = 'week' | 'month' | 'year';
type Mode = 'normalized' | 'raw';

interface TimesheetViewProps {
  orgTrees: { id: string; name: string }[];
  initialData: TimesheetGridResponse | null;
  initialOrgTreeId: string;
  anchorIso: string;
  /** Hide the org-tree picker when the view is already scoped to a single tree (e.g. embedded in the org page). */
  hideTreePicker?: boolean;
  /**
   * Set when the server-side initial fetch (in timesheet/page.tsx) got a 403
   * rather than null-from-any-other-failure — see `fetchTimesheetGridForTree`.
   * Distinguishes "you lack the analytics role or tree access" from "the
   * analytics backend is down", which look identical from `initialData` alone.
   */
  initialForbidden?: boolean;
  /**
   * Same idea one status code over: set when that initial fetch got a 401.
   * Kept distinct from `initialForbidden` because the remedy differs — sign in
   * again, versus ask for the analytics role or tree access.
   */
  initialUnauthenticated?: boolean;
}

function shiftAnchor(anchorIso: string, view: View, dir: 1 | -1): string {
  const d = new Date(anchorIso);
  if (view === 'year') d.setUTCFullYear(d.getUTCFullYear() + dir);
  else if (view === 'month') d.setUTCMonth(d.getUTCMonth() + dir);
  else d.setUTCDate(d.getUTCDate() + dir * 7);
  return d.toISOString();
}

const selectClass =
  'rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 ' +
  'transition-colors hover:border-slate-300 focus:border-indigo-500 focus:outline-none ' +
  'focus:ring-2 focus:ring-indigo-500/20';

export function TimesheetView({
  orgTrees,
  initialData,
  initialOrgTreeId,
  anchorIso,
  hideTreePicker,
  initialForbidden = false,
  initialUnauthenticated = false,
}: TimesheetViewProps) {
  const [orgTreeId, setOrgTreeId] = useState(initialOrgTreeId);
  const [anchor, setAnchor] = useState(anchorIso);
  const [view, setView] = useState<View>('month');
  const [mode, setMode] = useState<Mode>('normalized');
  const [data, setData] = useState<TimesheetGridResponse | null>(initialData);
  const [loading, setLoading] = useState(false);
  const [drawer, setDrawer] = useState<DrawerState | null>(null);
  // Set on a 403 from either the initial SSR fetch or a reload (Prev/Next,
  // granularity, time-basis, or tree-picker change) — every path that can
  // replace `data` must also be able to set this, or a mid-session role/
  // access revocation would fall straight back into the misleading
  // "backend may be unavailable" branch below.
  const [denied, setDenied] = useState<'forbidden' | 'unauthenticated' | null>(
    initialUnauthenticated ? 'unauthenticated' : initialForbidden ? 'forbidden' : null,
  );

  async function reload(next: { orgTreeId?: string; anchor?: string; view?: View; mode?: Mode }) {
    const orgId = next.orgTreeId ?? orgTreeId;
    const a = next.anchor ?? anchor;
    const v = next.view ?? view;
    const m = next.mode ?? mode;
    const w = resolveWindow(a, v);
    setLoading(true);
    const res = await fetchTimesheetGridForTree({ orgTreeId: orgId, from: w.from, to: w.to, granularity: w.granularity, mode: m });
    if (res.ok) {
      setData(res.data);
      setDenied(null);
    } else {
      setData(null);
      setDenied(res.reason === 'unknown' ? null : res.reason);
    }
    setLoading(false);
  }

  async function onTaskClick(issueKey: string, employeeId: string, countedSeconds: number) {
    const w = resolveWindow(anchor, view);
    // Open on the click, not on the response: the two fetches below take a
    // round trip each and the old panel simply did nothing visible until they
    // landed. `countedSeconds` comes from the grid cell, so the headline figure
    // is correct in the very first frame.
    setDrawer({ issueKey, employeeId, countedSeconds, data: null, activity: null });
    const [data, activity] = await Promise.all([
      fetchIntervals({ orgTreeId, issueKey, employeeId, from: w.from, to: w.to }),
      fetchTicketActivity(issueKey),
    ]);
    // A second click while the first was in flight must win, or the panel fills
    // with the previous ticket's detail under the new ticket's header.
    setDrawer((cur) =>
      cur && cur.issueKey === issueKey && cur.employeeId === employeeId
        ? { ...cur, data, activity }
        : cur,
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white p-3 shadow-card">
        {!hideTreePicker && (
          <select
            aria-label="Org tree"
            value={orgTreeId}
            onChange={(e) => {
              setOrgTreeId(e.target.value);
              void reload({ orgTreeId: e.target.value });
            }}
            className={selectClass}
          >
            {orgTrees.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        )}

        <PeriodNavigator
          label={formatPeriodLabel(anchor, view)}
          onPrev={() => {
            const a = shiftAnchor(anchor, view, -1);
            setAnchor(a);
            void reload({ anchor: a });
          }}
          onNext={() => {
            const a = shiftAnchor(anchor, view, 1);
            setAnchor(a);
            void reload({ anchor: a });
          }}
        />

        <SegmentedControl<View>
          ariaLabel="Period granularity"
          value={view}
          onChange={(v) => {
            setView(v);
            void reload({ view: v });
          }}
          options={[
            { value: 'week', label: 'Week' },
            { value: 'month', label: 'Month' },
            { value: 'year', label: 'Year' },
          ]}
        />

        <div className="ml-auto flex items-center gap-3">
          <div
            className="flex items-center gap-2"
            title="Normalized spreads each ticket's time evenly across its in-progress span. Raw counts logged time as-is."
          >
            <span className="text-xs uppercase tracking-wide text-slate-400">Time basis</span>
            <SegmentedControl<Mode>
              ariaLabel="Time basis"
              value={mode}
              onChange={(m) => {
                setMode(m);
                void reload({ mode: m });
              }}
              options={[
                { value: 'normalized', label: 'Normalized' },
                { value: 'raw', label: 'Raw' },
              ]}
            />
          </div>

          <button
            type="button"
            className="btn-primary"
            disabled={!data}
            onClick={() => {
              if (data) downloadCsv('timesheet-grid.csv', buildGridCsv(data));
            }}
          >
            ⤓ Export CSV
          </button>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-card">
        {loading ? (
          <p className="p-8 text-center text-sm text-slate-400">Loading…</p>
        ) : denied ? (
          <p className="p-8 text-center text-sm text-slate-500">
            {denied === 'unauthenticated'
              ? 'Your session has expired — sign in again to view timesheet data.'
              : 'Analytics is limited to accounts with the analytics role.'}
          </p>
        ) : data === null ? (
          <p className="p-8 text-center text-sm text-red-500">
            Couldn't load timesheet data — the analytics backend may be unavailable.
          </p>
        ) : (
          <TimesheetGrid data={data} onTaskClick={onTaskClick} />
        )}
      </div>

      {drawer && (
        <TicketDetailDrawer
          data={drawer.data}
          countedSeconds={drawer.countedSeconds}
          activity={drawer.activity}
          loading={drawer.data === null}
          onClose={() => setDrawer(null)}
        />
      )}
    </div>
  );
}

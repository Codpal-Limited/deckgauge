'use client';

import { useState, useEffect } from 'react';
import type { CapexReportResponse, EpicBreakdownResponse } from '@deckgauge/shared';
import { fetchCapexReportForTree, fetchEpicBreakdownForTree } from '../../actions/timesheet';
import { resolveWindow, formatPeriodLabel } from '../lib/timesheet-ui';
import { buildReportCsv } from '../lib/report-csv';
import { CapexReportPanel } from './CapexReportPanel';
import { TopEpicsPanel } from './TopEpicsPanel';
import { PeriodNavigator } from './PeriodNavigator';
import { SegmentedControl } from './SegmentedControl';

type View = 'week' | 'month' | 'year';
type Mode = 'normalized' | 'raw';
type GroupBy = 'team' | 'role' | 'person';

// The epic leaderboard has its own trailing window, independent of the report's
// week/month/year navigator, defaulting to a full year per the VP's request.
type EpicWindow = '6m' | '12m' | '24m' | 'ytd';
const EPIC_WINDOW_DEFAULT: EpicWindow = '12m';
// One page of the leaderboard. Server-side paging keeps the payload light — the
// full list can run 500+ epics, too heavy to ship and render in one go.
const EPIC_PAGE_SIZE = 25;

const EPIC_WINDOW_OPTIONS: { value: EpicWindow; label: string }[] = [
  { value: '6m', label: 'Last 6 months' },
  { value: '12m', label: 'Last 12 months' },
  { value: '24m', label: 'Last 24 months' },
  { value: 'ytd', label: 'Year to date' },
];

function epicWindowRange(kind: EpicWindow): { from: string; to: string } {
  const to = new Date();
  if (kind === 'ytd') {
    const from = new Date(Date.UTC(to.getUTCFullYear(), 0, 1));
    return { from: from.toISOString(), to: to.toISOString() };
  }
  const months = kind === '6m' ? 6 : kind === '24m' ? 24 : 12;
  // Subtract months WITHOUT day overflow (e.g. Aug 31 − 6m must land in Feb, not
  // spill into Mar): clamp the day to the number of days in the target month.
  const shifted = to.getUTCMonth() - months;
  const targetYear = to.getUTCFullYear() + Math.floor(shifted / 12);
  const targetMonth = ((shifted % 12) + 12) % 12;
  const daysInTarget = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const day = Math.min(to.getUTCDate(), daysInTarget);
  const from = new Date(
    Date.UTC(
      targetYear,
      targetMonth,
      day,
      to.getUTCHours(),
      to.getUTCMinutes(),
      to.getUTCSeconds(),
    ),
  );
  return { from: from.toISOString(), to: to.toISOString() };
}

interface ReportViewProps {
  orgTrees: { id: string; name: string }[];
  initialReport: CapexReportResponse | null;
  initialOrgTreeId: string;
  anchorIso: string;
  /** Hide the org-tree picker when the view is already scoped to a single tree (e.g. embedded in the org page). */
  hideTreePicker?: boolean;
  /**
   * Set when the server-side initial fetch (in timesheet/report/page.tsx) got
   * a 403 rather than null-from-any-other-failure — see
   * `fetchCapexReportForTree`'s doc. The epic-breakdown leaderboard has no
   * SSR seed (it always fetches on mount), so it has no equivalent initial
   * prop — its own forbidden state starts false and is set by that fetch.
   */
  initialForbidden?: boolean;
  /**
   * Same idea one status code over: set when that initial fetch got a 401.
   * Kept distinct from `initialForbidden` because the remedy differs — sign in
   * again, versus ask for the analytics role or tree access.
   */
  initialUnauthenticated?: boolean;
}

/**
 * Which denial the user is looking at, or `null` for "not denied". A 401 and a
 * 403 send the user to different remedies, so they must not share one boolean
 * — see `TimesheetDenialReason` in actions/timesheet.ts.
 */
type DeniedReason = 'forbidden' | 'unauthenticated' | null;

function deniedCopy(reason: Exclude<DeniedReason, null>): string {
  return reason === 'unauthenticated'
    ? 'Your session has expired — sign in again to view this report.'
    : 'Analytics is limited to accounts with the analytics role.';
}

function shiftAnchor(anchorIso: string, view: View, dir: 1 | -1): string {
  const d = new Date(anchorIso);
  if (view === 'year') d.setUTCFullYear(d.getUTCFullYear() + dir);
  else if (view === 'month') d.setUTCMonth(d.getUTCMonth() + dir);
  else d.setUTCDate(d.getUTCDate() + dir * 7);
  return d.toISOString();
}

function downloadCsv(filename: string, contents: string): void {
  // Prepend a UTF-8 BOM so Excel decodes the file as UTF-8 rather than a legacy
  // codepage (which mangles non-ASCII characters like the em dash into "‚Äî").
  const BOM = String.fromCharCode(0xfeff);
  const blob = new Blob([BOM + contents], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const selectClass =
  'rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 ' +
  'transition-colors hover:border-slate-300 focus:border-indigo-500 focus:outline-none ' +
  'focus:ring-2 focus:ring-indigo-500/20';

interface EpicPaginationProps {
  page: number;
  pageSize: number;
  total: number;
  count: number;
  onPrev: () => void;
  onNext: () => void;
}

/** "Showing 1–25 of 213" plus Prev/Next. Buttons only appear once the list
 *  spills past a single page; the count line always shows so the total is visible. */
function EpicPagination({ page, pageSize, total, count, onPrev, onNext }: EpicPaginationProps) {
  const start = page * pageSize;
  const from = total === 0 ? 0 : start + 1;
  const to = start + count;
  const hasPrev = page > 0;
  const hasNext = to < total;

  const pageBtn =
    'rounded-lg border border-slate-200 bg-white px-3 py-1 text-sm text-slate-700 ' +
    'transition-colors hover:border-slate-300 disabled:cursor-not-allowed disabled:opacity-40';

  return (
    <div className="mt-3 flex items-center justify-between">
      <span className="text-xs text-slate-500">
        Showing <span className="tabular-nums">{from}</span>–<span className="tabular-nums">{to}</span> of{' '}
        <span className="tabular-nums">{total}</span> epics
      </span>
      {(hasPrev || hasNext) && (
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label="previous epic page"
            className={pageBtn}
            onClick={onPrev}
            disabled={!hasPrev}
          >
            ← Prev
          </button>
          <button
            type="button"
            aria-label="next epic page"
            className={pageBtn}
            onClick={onNext}
            disabled={!hasNext}
          >
            Next →
          </button>
        </div>
      )}
    </div>
  );
}

export function ReportView({
  orgTrees,
  initialReport,
  initialOrgTreeId,
  anchorIso,
  hideTreePicker,
  initialForbidden = false,
  initialUnauthenticated = false,
}: ReportViewProps) {
  const [orgTreeId, setOrgTreeId] = useState(initialOrgTreeId);
  const [anchor, setAnchor] = useState(anchorIso);
  const [view, setView] = useState<View>('month');
  const [mode, setMode] = useState<Mode>('normalized');
  const [groupBy, setGroupBy] = useState<GroupBy | undefined>(undefined);
  const [report, setReport] = useState<CapexReportResponse | null>(initialReport);
  const [loading, setLoading] = useState(false);
  // See TimesheetView's identical field for why every path that can replace
  // `report`/`epics` must also be able to set its denial flag.
  const [denied, setDenied] = useState<DeniedReason>(
    initialUnauthenticated ? 'unauthenticated' : initialForbidden ? 'forbidden' : null,
  );
  const [epicWindow, setEpicWindow] = useState<EpicWindow>(EPIC_WINDOW_DEFAULT);
  const [epicPage, setEpicPage] = useState(0);
  const [epics, setEpics] = useState<EpicBreakdownResponse | null>(null);
  const [epicsLoading, setEpicsLoading] = useState(true);
  const [epicsDenied, setEpicsDenied] = useState<DeniedReason>(null);

  async function reload(next: { orgTreeId?: string; anchor?: string; view?: View; mode?: Mode; groupBy?: GroupBy }) {
    const orgId = next.orgTreeId ?? orgTreeId;
    const a = next.anchor ?? anchor;
    const v = next.view ?? view;
    const m = next.mode ?? mode;
    const g = next.groupBy ?? groupBy;
    const w = resolveWindow(a, v);
    setLoading(true);
    try {
      const res = await fetchCapexReportForTree({ orgTreeId: orgId, from: w.from, to: w.to, granularity: w.granularity, mode: m, groupBy: g });
      if (res.ok) {
        setReport(res.data);
        setDenied(null);
      } else {
        setReport(null);
        setDenied(res.reason === 'unknown' ? null : res.reason);
      }
    } finally {
      setLoading(false);
    }
  }

  // The epic leaderboard has no server-rendered seed, so fetch on mount and
  // whenever its inputs (tree, time basis, window, or page) change. The `cancelled`
  // flag is a latest-wins guard: if inputs change before a fetch resolves, its
  // result is discarded so a stale response can't overwrite the current one.
  useEffect(() => {
    let cancelled = false;
    const w = epicWindowRange(epicWindow);
    setEpicsLoading(true);
    fetchEpicBreakdownForTree({
      orgTreeId,
      from: w.from,
      to: w.to,
      mode,
      limit: EPIC_PAGE_SIZE,
      offset: epicPage * EPIC_PAGE_SIZE,
    })
      .then((res) => {
        if (cancelled) return;
        if (res.ok) {
          setEpics(res.data);
          setEpicsDenied(null);
        } else {
          setEpics(null);
          setEpicsDenied(res.reason === 'unknown' ? null : res.reason);
        }
      })
      .finally(() => {
        if (!cancelled) setEpicsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [orgTreeId, mode, epicWindow, epicPage]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white p-3 shadow-card">
        {!hideTreePicker && (
          <select
            aria-label="Org tree"
            value={orgTreeId}
            onChange={(e) => {
              setOrgTreeId(e.target.value);
              setEpicPage(0);
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

        <div className="flex items-center gap-2">
          <span className="text-xs uppercase tracking-wide text-slate-400">Group by</span>
          <SegmentedControl<GroupBy>
            ariaLabel="Group by"
            value={groupBy}
            onChange={(g) => {
              setGroupBy(g);
              void reload({ groupBy: g });
            }}
            options={[
              { value: 'team', label: 'Team' },
              { value: 'role', label: 'Role' },
              { value: 'person', label: 'Person' },
            ]}
          />
        </div>

        {/* `flex-wrap` because the 44px touch floor widened this row past 390px:
            the period arrows went 27px -> 44px each, taking the row to 408px
            against a 390px viewport and tearing the page by 18px (measured).
            Wrapping is the same remedy `StatusRulesEditor` already uses for
            its action row. `ml-auto` still right-aligns it when it fits. */}
        <div className="ml-auto flex flex-wrap items-center gap-3">
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
                setEpicPage(0);
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
            disabled={!report}
            onClick={() => {
              if (report) downloadCsv('timesheet-capex-report.csv', buildReportCsv(report));
            }}
          >
            ⤓ Export CSV
          </button>
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-card">
        {loading ? (
          <p className="p-4 text-center text-sm text-slate-400">Loading…</p>
        ) : denied ? (
          <p className="p-4 text-center text-sm text-slate-500">{deniedCopy(denied)}</p>
        ) : report === null ? (
          <p className="p-4 text-center text-sm text-red-500">
            Couldn't load the CapEx/OpEx report — the analytics backend may be unavailable.
          </p>
        ) : (
          <CapexReportPanel report={report} />
        )}
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-card">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-800">Top epics</h2>
            <p className="text-xs text-slate-500">
              Epics developers spent the most time on, coloured by CapEx / OpEx.
            </p>
          </div>
          <label className="flex items-center gap-2">
            <span className="text-xs uppercase tracking-wide text-slate-400">Window</span>
            <select
              aria-label="Epic window"
              value={epicWindow}
              onChange={(e) => {
                setEpicWindow(e.target.value as EpicWindow);
                setEpicPage(0);
              }}
              className={selectClass}
            >
              {EPIC_WINDOW_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        {epicsLoading ? (
          <p className="p-4 text-center text-sm text-slate-400">Loading…</p>
        ) : epicsDenied ? (
          <p className="p-4 text-center text-sm text-slate-500">{deniedCopy(epicsDenied)}</p>
        ) : epics === null ? (
          <p className="p-4 text-center text-sm text-red-500">
            Couldn't load the epic breakdown — the analytics backend may be unavailable.
          </p>
        ) : (
          <>
            <TopEpicsPanel epics={epics.epics} rankOffset={epicPage * EPIC_PAGE_SIZE} />
            <EpicPagination
              page={epicPage}
              pageSize={EPIC_PAGE_SIZE}
              total={epics.total}
              count={epics.epics.length}
              onPrev={() => setEpicPage((p) => Math.max(0, p - 1))}
              onNext={() => setEpicPage((p) => p + 1)}
            />
          </>
        )}
      </div>
    </div>
  );
}

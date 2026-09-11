'use client';

import { useState } from 'react';
import type { EpicRow } from '@deckgauge/shared';
import { formatHours } from '../lib/timesheet-ui';
import { classificationColor } from '../lib/classification';
import { ClassificationPill } from './ClassificationPill';
import { SplitBar } from './SplitBar';
import { TableScroller } from '../../components/TableScroller';

interface TopEpicsPanelProps {
  epics: EpicRow[];
  /** Rank of the first row (0-based row index → shown rank is rankOffset + index + 1),
   *  so ranks stay absolute across pages (page 2 shows 26, 27, …). Defaults to 0. */
  rankOffset?: number;
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      className={`h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform ${open ? 'rotate-90' : ''}`}
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden
    >
      <path
        fillRule="evenodd"
        d="M7.21 5.23a.75.75 0 0 1 1.06.02l4 4.25a.75.75 0 0 1 0 1.02l-4 4.25a.75.75 0 1 1-1.08-1.04L10.64 10 7.19 6.31a.75.75 0 0 1 .02-1.08Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

/** Only http(s) links are safe to render into an href — guards against a
 *  hostile scheme (e.g. javascript:) sneaking in from misconfigured source URLs. */
function isSafeHttpUrl(url: string | null): url is string {
  return url != null && /^https?:\/\//i.test(url);
}

/** The epic name — a deep link to its source system when a safe url is known.
 *  The click is isolated so following the link doesn't also toggle the row. */
function EpicName({ epic }: { epic: EpicRow }) {
  const label = epic.title ?? epic.epicKey;
  const suffix = epic.title ? <span className="ml-2 text-xs text-slate-400">{epic.epicKey}</span> : null;
  if (isSafeHttpUrl(epic.url)) {
    return (
      <span className="min-w-0">
        <a
          href={epic.url}
          target="_blank"
          rel="noreferrer"
          onClick={(ev) => ev.stopPropagation()}
          className="font-medium text-indigo-600 hover:underline"
        >
          {label}
        </a>
        {suffix}
      </span>
    );
  }
  return (
    <span className="min-w-0">
      <span className="font-medium text-slate-700">{label}</span>
      {suffix}
    </span>
  );
}

function EmployeeDetail({ epic }: { epic: EpicRow }) {
  if (epic.byEmployee.length === 0) {
    return <p className="px-3 py-2 text-sm text-slate-400">No per-developer breakdown available.</p>;
  }
  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr className="text-left text-xs uppercase tracking-wide text-slate-400">
          <th className="px-3 py-1.5 font-medium">Developer</th>
          <th className="px-3 py-1.5 text-right font-medium">Hours</th>
          <th className="px-3 py-1.5 text-left font-medium">Split</th>
        </tr>
      </thead>
      <tbody>
        {epic.byEmployee.map((emp) => (
          <tr key={emp.employeeId} className="border-t border-slate-100">
            <td className="px-3 py-1.5 text-slate-700">{emp.name}</td>
            <td className="px-3 py-1.5 text-right tabular-nums text-slate-600">
              {formatHours(emp.totalSeconds)}
            </td>
            <td className="px-3 py-1.5">
              <SplitBar
                capexSeconds={emp.capexSeconds}
                opexSeconds={emp.opexSeconds}
                unclassifiedSeconds={emp.unclassifiedSeconds}
                className="min-w-[6rem]"
              />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

interface FragmentRowProps {
  epic: EpicRow;
  rank: number;
  open: boolean;
  onToggle: () => void;
}

/** A clickable epic row plus, when open, an expansion row with the per-developer
 *  breakdown. Kept as real table rows so columns line up with the header. */
function FragmentRow({ epic, rank, open, onToggle }: FragmentRowProps) {
  return (
    <>
      <tr onClick={onToggle} className="cursor-pointer border-t border-slate-100 hover:bg-slate-50">
        <td className="px-3 py-2 text-right tabular-nums text-slate-400">
          <button
            type="button"
            aria-expanded={open}
            aria-label={open ? 'Collapse epic' : 'Expand epic'}
            onClick={(ev) => {
              ev.stopPropagation();
              onToggle();
            }}
            // 26x20 measured. Floored on both axes — but verify the page
            // does not overflow afterwards: the same change on
            // `TimesheetGrid`'s chevron widened a sticky column and tore the
            // page by 18px, and was reverted. This cell is `text-right` and
            // not sticky, so it has room the other did not.
            className="inline-flex min-h-11 min-w-11 items-center justify-center gap-1.5 md:min-h-0 md:min-w-0"
          >
            <Chevron open={open} />
            {rank}
          </button>
        </td>
        <td className="px-3 py-2">
          <div className="flex items-center gap-2">
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: classificationColor(epic.classification) }}
              aria-hidden
            />
            <EpicName epic={epic} />
          </div>
        </td>
        <td className="px-3 py-2">
          <ClassificationPill classification={epic.classification} />
        </td>
        <td className="px-3 py-2 text-right font-medium tabular-nums text-slate-700">
          {formatHours(epic.totalSeconds)}
        </td>
        <td className="px-3 py-2">
          <SplitBar
            capexSeconds={epic.capexSeconds}
            opexSeconds={epic.opexSeconds}
            unclassifiedSeconds={epic.unclassifiedSeconds}
            className="min-w-[6rem]"
          />
        </td>
      </tr>
      {open && (
        <tr className="bg-slate-50/60">
          <td colSpan={5} className="py-2 pl-8 pr-3">
            <EmployeeDetail epic={epic} />
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * Ranked leaderboard of the epics developers spent the most in-progress time on
 * over the selected window. Each row is colour-coded by CapEx / OpEx and links
 * to the epic in its source system; clicking a row expands a per-developer
 * hours breakdown.
 */
export function TopEpicsPanel({ epics, rankOffset = 0 }: TopEpicsPanelProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  if (epics.length === 0) {
    return (
      <p className="rounded-xl border border-slate-200 bg-white p-4 text-center text-sm text-slate-400">
        No epic time recorded in this window.
      </p>
    );
  }

  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200" data-testid="top-epics">
      <TableScroller>
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-400">
              <th className="w-16 px-3 py-2 text-right font-medium">#</th>
              <th className="px-3 py-2 font-medium">Epic</th>
              <th className="px-3 py-2 font-medium">Type</th>
              <th className="px-3 py-2 text-right font-medium">Hours</th>
              <th className="px-3 py-2 text-left font-medium">Split</th>
            </tr>
          </thead>
          <tbody>
            {epics.map((e, i) => {
              const key = `${e.provider}:${e.epicKey}`;
              const open = expanded.has(key);
              return (
                <FragmentRow
                  key={key}
                  epic={e}
                  rank={rankOffset + i + 1}
                  open={open}
                  onToggle={() => toggle(key)}
                />
              );
            })}
          </tbody>
        </table>
      </TableScroller>
    </div>
  );
}

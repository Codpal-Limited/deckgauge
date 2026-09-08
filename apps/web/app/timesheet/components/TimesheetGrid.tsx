'use client';

import { Fragment, useState } from 'react';
import type { TimesheetGridResponse, TimesheetEmployeeRow } from '@deckgauge/shared';
import {
  formatHours,
  orderEmployeesByHierarchy,
  aggregateEmployeeTasks,
  employeeSplit,
  columnTotals,
} from '../lib/timesheet-ui';
import { SplitBar } from './SplitBar';
import { ClassificationPill } from './ClassificationPill';

interface TimesheetGridProps {
  data: TimesheetGridResponse;
  /** `countedSeconds` is this cell's own attributed total, so the drawer never has to re-derive it. */
  onTaskClick: (issueKey: string, employeeId: string, countedSeconds: number) => void;
}

function rowTotal(e: TimesheetEmployeeRow): number {
  return e.cells.reduce((acc, c) => acc + c.seconds, 0);
}

function secondsByBucket(e: TimesheetEmployeeRow): Map<string, number> {
  return new Map(e.cells.map((c) => [c.bucketKey, c.seconds] as const));
}

// Sticky first column: opaque background must match the row so scrolled cells
// slide underneath it. Kept as a constant so header/body/footer stay in sync.
const STICKY = 'sticky left-0 z-10';

export function TimesheetGrid({ data, onTaskClick }: TimesheetGridProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const ordered = orderEmployeesByHierarchy(data.employees);

  function toggle(id: string) {
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const colTotals = columnTotals(data.employees, data.buckets);
  const grand = data.employees.reduce(
    (acc, e) => {
      const s = employeeSplit(e);
      return {
        capexSeconds: acc.capexSeconds + s.capexSeconds,
        opexSeconds: acc.opexSeconds + s.opexSeconds,
        unclassifiedSeconds: acc.unclassifiedSeconds + s.unclassifiedSeconds,
      };
    },
    { capexSeconds: 0, opexSeconds: 0, unclassifiedSeconds: 0 },
  );
  const grandTotal = grand.capexSeconds + grand.opexSeconds + grand.unclassifiedSeconds;
  const grandClassified = grand.capexSeconds + grand.opexSeconds;
  const grandPct = grandClassified > 0 ? (grand.capexSeconds / grandClassified) * 100 : 0;
  const unmatchedTotal = data.unmatched.reduce((acc, u) => acc + u.seconds, 0);

  return (
    <div className="max-h-[70vh] overflow-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-slate-400">
            <th className={`${STICKY} z-20 bg-white px-3 py-2.5 font-medium`}>Engineer</th>
            {data.buckets.map((b) => (
              <th key={b} className="bg-white px-3 py-2.5 text-right font-medium tabular-nums">
                {b}
              </th>
            ))}
            <th className="bg-white px-3 py-2.5 text-right font-medium">Total</th>
            <th className="bg-white px-3 py-2.5 text-left font-medium">CapEx split</th>
          </tr>
        </thead>
        <tbody>
          {ordered.map(({ employee, depth }) => {
            const byBucket = secondsByBucket(employee);
            const isOpen = expanded.has(employee.employeeId);
            const split = employeeSplit(employee);
            return (
              <Fragment key={employee.employeeId}>
                <tr className="group border-t border-slate-100 hover:bg-indigo-50/40">
                  <td
                    className={`${STICKY} bg-white px-3 py-2 group-hover:bg-indigo-50/40`}
                    style={{ paddingLeft: `${12 + depth * 18}px` }}
                  >
                    <button
                      type="button"
                      aria-label={`expand ${employee.name}`}
                      onClick={() => toggle(employee.employeeId)}
                      className="mr-1.5 inline-flex h-4 w-4 items-center justify-center text-slate-400 transition-colors hover:text-slate-600"
                    >
                      <span
                        className={`inline-block text-[10px] transition-transform duration-150 ${isOpen ? 'rotate-90' : ''}`}
                      >
                        ▶
                      </span>
                    </button>
                    <span className="font-medium text-slate-700">{employee.name}</span>
                    {employee.role && (
                      <span className="ml-2 text-xs text-slate-400">{employee.role}</span>
                    )}
                  </td>
                  {data.buckets.map((b) => (
                    <td key={b} className="px-3 py-2 text-right tabular-nums text-slate-600">
                      {byBucket.has(b) ? formatHours(byBucket.get(b)!) : ''}
                    </td>
                  ))}
                  <td className="px-3 py-2 text-right font-semibold tabular-nums text-slate-800">
                    {formatHours(rowTotal(employee))}
                  </td>
                  <td className="px-3 py-2">
                    <SplitBar
                      capexSeconds={split.capexSeconds}
                      opexSeconds={split.opexSeconds}
                      unclassifiedSeconds={split.unclassifiedSeconds}
                      capexPct={split.capexPct}
                      showPct
                      className="min-w-[8rem]"
                    />
                  </td>
                </tr>
                {isOpen &&
                  aggregateEmployeeTasks(employee).map((t) => (
                    <tr
                      key={`${employee.employeeId}|${t.issueKey}|${t.classification}`}
                      className="bg-slate-50/60 text-xs"
                    >
                      <td
                        className="sticky left-0 z-10 bg-slate-50/60 px-3 py-1.5"
                        style={{ paddingLeft: `${34 + depth * 18}px` }}
                      >
                        <button
                          type="button"
                          onClick={() => onTaskClick(t.issueKey, employee.employeeId, t.total)}
                          className="font-medium text-indigo-600 hover:underline"
                        >
                          {t.issueKey}
                        </button>
                        {t.title && (
                          <span
                            className="ml-2 inline-block max-w-[16rem] truncate align-bottom text-slate-500"
                            title={t.title}
                          >
                            {t.title}
                          </span>
                        )}
                        <ClassificationPill classification={t.classification} className="ml-2" />
                      </td>
                      {data.buckets.map((b) => (
                        <td key={b} className="px-3 py-1.5 text-right tabular-nums text-slate-500">
                          {t.byBucket.has(b) ? formatHours(t.byBucket.get(b)!) : ''}
                        </td>
                      ))}
                      <td className="px-3 py-1.5 text-right tabular-nums text-slate-600">
                        {formatHours(t.total)}
                      </td>
                      <td className="px-3 py-1.5" />
                    </tr>
                  ))}
              </Fragment>
            );
          })}
          {data.unmatched.length > 0 && (
            <tr className="border-t border-slate-200 text-slate-500">
              <td className="sticky left-0 z-10 bg-white px-3 py-2 italic">Unmatched</td>
              <td className="px-3 py-2 text-right tabular-nums" colSpan={data.buckets.length}>
                {data.unmatched.length} unresolved assignees
              </td>
              <td className="px-3 py-2 text-right tabular-nums">{formatHours(unmatchedTotal)}</td>
              <td className="px-3 py-2" />
            </tr>
          )}
        </tbody>
        <tfoot>
          <tr className="sticky bottom-0 border-t-2 border-slate-200 bg-slate-50 font-semibold text-slate-700">
            <td className={`${STICKY} z-20 bg-slate-50 px-3 py-2.5`}>Total</td>
            {data.buckets.map((b) => (
              <td key={b} className="bg-slate-50 px-3 py-2.5 text-right tabular-nums">
                {formatHours(colTotals.get(b) ?? 0)}
              </td>
            ))}
            <td className="bg-slate-50 px-3 py-2.5 text-right tabular-nums">
              {formatHours(grandTotal)}
            </td>
            <td className="bg-slate-50 px-3 py-2.5">
              <SplitBar
                capexSeconds={grand.capexSeconds}
                opexSeconds={grand.opexSeconds}
                unclassifiedSeconds={grand.unclassifiedSeconds}
                capexPct={grandPct}
                showPct
                className="min-w-[8rem]"
              />
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

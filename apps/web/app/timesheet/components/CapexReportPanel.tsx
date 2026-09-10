'use client';

import { useEffect, useState } from 'react';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
} from 'recharts';
import { costFromSeconds, DEFAULT_BLENDED_HOURLY_RATE, type CapexReportResponse } from '@deckgauge/shared';
import { formatHours, formatCost } from '../lib/timesheet-ui';
import { SPLIT_COLORS } from '../lib/classification';
import { SplitBar } from './SplitBar';
import { TableScroller } from '../../components/TableScroller';

interface CapexReportPanelProps {
  report: CapexReportResponse;
}

// Persist the blended rate so a VP sets it once. Guarded for SSR / private mode.
const RATE_STORAGE_KEY = 'vpc-blended-hourly-rate';

function loadRate(): number {
  if (typeof window === 'undefined') return DEFAULT_BLENDED_HOURLY_RATE;
  const raw = window.localStorage.getItem(RATE_STORAGE_KEY);
  const n = raw == null ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_BLENDED_HOURLY_RATE;
}

function pct(p: number): string {
  return `${p.toFixed(1)}%`;
}

interface StatCardProps {
  label: string;
  value: string;
  sub?: string;
  accent?: string;
}

function StatCard({ label, value, sub, accent }: StatCardProps) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-slate-400">{label}</div>
      <div className="mt-0.5 text-xl font-semibold tabular-nums" style={accent ? { color: accent } : undefined}>
        {value}
      </div>
      {sub !== undefined && <div className="mt-0.5 text-xs tabular-nums text-slate-400">{sub}</div>}
    </div>
  );
}

export function CapexReportPanel({ report }: CapexReportPanelProps) {
  // Render the chart only after mount. recharts' ResponsiveContainer measures its
  // parent synchronously on first render; before the browser lays the element out
  // that reads as 0, so it logs a "width(-1)/height(-1)" warning. Deferring one
  // tick (post-layout) lets it measure a real size and keeps the console clean.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Blended-rate cost layer. Rate is user-editable and persisted; cost figures
  // are estimates driven entirely by it (see shared/timesheet-cost.ts).
  const [rate, setRate] = useState<number>(DEFAULT_BLENDED_HOURLY_RATE);
  useEffect(() => setRate(loadRate()), []);
  function updateRate(next: number) {
    const clean = Number.isFinite(next) && next > 0 ? next : 0;
    setRate(clean);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(RATE_STORAGE_KEY, String(clean));
    }
  }

  const t = report.totals;
  const capexCost = costFromSeconds(t.capexSeconds, rate);
  const totalCost = costFromSeconds(
    t.capexSeconds + t.opexSeconds + t.unclassifiedSeconds,
    rate
  );

  const chartData = report.byBucket.map((b) => ({
    bucketKey: b.bucketKey,
    CapEx: Number((b.capexSeconds / 3600).toFixed(2)),
    OpEx: Number((b.opexSeconds / 3600).toFixed(2)),
    Unclassified: Number((b.unclassifiedSeconds / 3600).toFixed(2)),
  }));

  return (
    <div className="flex flex-col gap-5">
      {/* Hero: the one number a VP scans for, with its split */}
      <div className="rounded-xl border border-slate-200 bg-slate-50/60 px-5 py-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-xs uppercase tracking-wide text-slate-400">Capitalizable cost</div>
            <div
              className="mt-0.5 text-2xl font-semibold tabular-nums text-slate-800"
              data-testid="capitalizable-cost"
            >
              {formatCost(capexCost)}
            </div>
            <div className="mt-0.5 text-xs text-slate-400">
              of {formatCost(totalCost)} total · {pct(report.totals.capexPct)} CapEx
            </div>
          </div>
          <label className="flex flex-col items-end text-xs text-slate-400">
            Blended rate
            <span className="mt-1 inline-flex items-center rounded-md border border-slate-200 bg-white px-2 py-1 text-slate-700">
              $
              <input
                type="number"
                min={0}
                step={5}
                aria-label="Blended hourly rate"
                value={rate}
                onChange={(e) => updateRate(Number(e.target.value))}
                className="w-16 border-none bg-transparent text-right tabular-nums outline-none"
              />
              /h
            </span>
          </label>
        </div>
        <SplitBar
          className="mt-3"
          capexSeconds={report.totals.capexSeconds}
          opexSeconds={report.totals.opexSeconds}
          unclassifiedSeconds={report.totals.unclassifiedSeconds}
        />
        <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-500">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: SPLIT_COLORS.capex }} />
            CapEx {formatHours(report.totals.capexSeconds)}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: SPLIT_COLORS.opex }} />
            OpEx {formatHours(report.totals.opexSeconds)}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: SPLIT_COLORS.unclassified }} />
            Unclassified {formatHours(report.totals.unclassifiedSeconds)}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="totals-summary">
        <StatCard label="CapEx" value={formatHours(report.totals.capexSeconds)} sub={formatCost(capexCost)} accent={SPLIT_COLORS.capex} />
        <StatCard label="OpEx" value={formatHours(report.totals.opexSeconds)} sub={formatCost(costFromSeconds(report.totals.opexSeconds, rate))} accent={SPLIT_COLORS.opex} />
        <StatCard label="Unclassified" value={formatHours(report.totals.unclassifiedSeconds)} sub={formatCost(costFromSeconds(report.totals.unclassifiedSeconds, rate))} />
        <StatCard label="CapEx %" value={pct(report.totals.capexPct)} sub={`${formatCost(totalCost)} total`} />
      </div>

      <div
        data-testid="report-chart"
        className="rounded-xl border border-slate-200 bg-white p-3"
        style={{ width: '100%', height: 280 }}
      >
        {mounted && (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData}>
              <XAxis dataKey="bucketKey" fontSize={11} stroke="#94a3b8" />
              <YAxis fontSize={11} stroke="#94a3b8" />
              <Tooltip />
              <Legend />
              <Bar dataKey="CapEx" stackId="a" fill={SPLIT_COLORS.capex} radius={[0, 0, 0, 0]} />
              <Bar dataKey="OpEx" stackId="a" fill={SPLIT_COLORS.opex} />
              <Bar dataKey="Unclassified" stackId="a" fill={SPLIT_COLORS.unclassified} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      {report.byGroup.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-slate-200">
          <TableScroller>
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-400">
                  <th className="px-3 py-2 font-medium">Group</th>
                  <th className="px-3 py-2 text-right font-medium">CapEx</th>
                  <th className="px-3 py-2 text-right font-medium">OpEx</th>
                  <th className="px-3 py-2 text-right font-medium">Unclassified</th>
                  <th className="px-3 py-2 text-right font-medium">CapEx %</th>
                  <th className="px-3 py-2 text-right font-medium">Cost</th>
                  <th className="px-3 py-2 text-left font-medium">Split</th>
                </tr>
              </thead>
              <tbody>
                {report.byGroup.map((g) => (
                  <tr key={g.group} className="border-t border-slate-100 hover:bg-slate-50">
                    <td className="px-3 py-2 font-medium text-slate-700">{g.group}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-600">
                      {formatHours(g.capexSeconds)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-600">
                      {formatHours(g.opexSeconds)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-600">
                      {formatHours(g.unclassifiedSeconds)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums font-medium text-slate-700">
                      {pct(g.capexPct)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-600">
                      {formatCost(
                        costFromSeconds(
                          g.capexSeconds + g.opexSeconds + g.unclassifiedSeconds,
                          rate
                        )
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <SplitBar
                        capexSeconds={g.capexSeconds}
                        opexSeconds={g.opexSeconds}
                        unclassifiedSeconds={g.unclassifiedSeconds}
                        className="min-w-[6rem]"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroller>
        </div>
      )}
    </div>
  );
}

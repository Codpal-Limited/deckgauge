'use client';
import {
  ResponsiveContainer,
  ScatterChart as RechartsScatter,
  Scatter,
  XAxis,
  YAxis,
  ZAxis,
  Tooltip,
  CartesianGrid,
  Cell,
} from 'recharts';
import type { BenchmarkConfig, Tier } from '@deckgauge/shared';
import { BenchmarkBands } from './BenchmarkBands';
import { ScatterPointTooltip, type ScatterPoint } from './ScatterPointTooltip';
import { TierLegend } from './TierLegend';

// The point shape lives with the tooltip that reads all of it — the chart only
// needs x, y and tier, but the tooltip is what makes the other fields worth
// carrying.
type Point = ScatterPoint;

interface Props {
  points: Point[];
  xAxisLabel: string;
  yAxisLabel: string;
  benchmarks?: BenchmarkConfig;
  height?: number;
  // onPointClick wins over the default href-opens-in-new-tab behaviour.
  // Used by CH-backed widgets to drill into the intelligence console.
  onPointClick?: (point: Point) => void;
}

const TIER_FILL: Record<Tier, string> = {
  elite: '#10b981',
  high: '#84cc16',
  medium: '#f59e0b',
  low: '#f43f5e',
};

// Exposed for unit tests. Prefers the caller's drill callback; otherwise
// opens the per-point href in a new tab (the legacy behaviour).
export function handleScatterPointClick(
  point: Point | undefined,
  onPointClick?: (point: Point) => void,
  openHref: (href: string) => void = (href) => window.open(href, '_blank')
): void {
  if (!point) return;
  if (onPointClick) {
    onPointClick(point);
    return;
  }
  if (point.href) openHref(point.href);
}

// The largest y the axis should show: the data's max plus 5% headroom so the
// topmost point isn't clipped. Returns undefined for empty data so the axis
// (and benchmark bands) fall back to their auto behaviour.
export function scatterYMax(points: Point[]): number | undefined {
  const dataMax = points.reduce((max, p) => Math.max(max, p.y), 0);
  if (dataMax <= 0) return undefined;
  return Math.ceil(dataMax * 1.05);
}

export function ScatterChart({
  points,
  xAxisLabel,
  yAxisLabel,
  benchmarks,
  height,
  onPointClick,
}: Props) {
  const yMax = scatterYMax(points);
  return (
    <div className="h-full w-full flex flex-col">
      <ResponsiveContainer width="100%" height={height ?? '100%'}>
        <RechartsScatter margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
          <XAxis
            dataKey="x"
            type="category"
            tick={{ fontSize: 11 }}
            label={{ value: xAxisLabel, position: 'insideBottom', fontSize: 11 }}
          />
          <YAxis
            dataKey="y"
            domain={[0, yMax ?? 'auto']}
            tick={{ fontSize: 11 }}
            label={{ value: yAxisLabel, angle: -90, position: 'insideLeft', fontSize: 11 }}
          />
          <ZAxis range={[40, 40]} />
          {benchmarks ? <BenchmarkBands config={benchmarks} yMax={yMax} /> : null}
          <Tooltip content={<ScatterPointTooltip />} cursor={{ strokeDasharray: '3 3' }} />
          <Scatter
            data={points}
            onClick={(d: { payload?: Point }) =>
              handleScatterPointClick(d.payload, onPointClick)
            }
          >
            {points.map((p, i) => (
              <Cell key={i} fill={TIER_FILL[p.tier]} />
            ))}
          </Scatter>
        </RechartsScatter>
      </ResponsiveContainer>
      {benchmarks ? <TierLegend config={benchmarks} /> : null}
    </div>
  );
}

'use client';
import {
  ResponsiveContainer,
  ComposedChart,
  Line,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
} from 'recharts';
import { ChartTooltip } from './ChartTooltip';
import type { BenchmarkConfig } from '@deckgauge/shared';
import { BenchmarkBands } from './BenchmarkBands';
import { TierLegend } from './TierLegend';

// Exposed for unit tests. ComposedChart fires onClick with the current axis
// state — translate it into the simpler point shape the chart's callers expect.
export function handleTrendLineClick(
  state:
    | { activeLabel?: string; activePayload?: Array<{ value?: number; name?: string }> }
    | null
    | undefined,
  onPointClick?: (point: { x: string; y?: number; seriesName?: string }) => void
): void {
  if (!onPointClick || !state || typeof state.activeLabel !== 'string') return;
  const first = state.activePayload?.[0];
  onPointClick({
    x: state.activeLabel,
    y: typeof first?.value === 'number' ? first.value : undefined,
    seriesName: typeof first?.name === 'string' ? first.name : undefined,
  });
}

interface SeriesPoint {
  x: string;
  y: number;
}

interface Series {
  name: string;
  points: SeriesPoint[];
  color?: string;
}

interface Props {
  series: Series[];
  yAxisLabel: string;
  benchmarks?: BenchmarkConfig;
  confidenceBand?: { lower: number[]; upper: number[] };
  height?: number;
  // Fires when the user clicks the chart area. The payload x identifies the
  // category bucket (e.g. week start ISO date). CH-backed widgets use this to
  // drill into the intelligence console with the widget SQL pre-populated.
  onPointClick?: (point: { x: string; y?: number; seriesName?: string }) => void;
}

function computeYAxisMax(
  series: Series[],
  benchmarks: BenchmarkConfig | undefined,
  confidenceBand: { lower: number[]; upper: number[] } | undefined
): number | undefined {
  if (!benchmarks) return undefined;
  const values = series
    .flatMap((s) => s.points.map((p) => p.y))
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (confidenceBand) {
    values.push(
      ...confidenceBand.upper.filter(
        (v): v is number => typeof v === 'number' && Number.isFinite(v)
      )
    );
  }
  const dataMax = values.length ? Math.max(...values) : 0;
  if (benchmarks.direction === 'lower_is_better') {
    return Math.max(dataMax * 1.5, benchmarks.elite * 2);
  }
  return Math.max(dataMax * 1.2, benchmarks.elite * 1.5);
}

export function TrendLineChart({
  series,
  yAxisLabel,
  benchmarks,
  confidenceBand,
  height,
  onPointClick,
}: Props) {
  const xValues = Array.from(new Set(series.flatMap((s) => s.points.map((p) => p.x)))).sort();
  const data = xValues.map((x, i) => {
    const row: Record<string, string | number | undefined> = { x };
    for (const s of series) row[s.name] = s.points.find((p) => p.x === x)?.y;
    if (confidenceBand) {
      // Recharts range area: a [lower, upper] tuple draws the band directly, with
      // no background-coloured "mask" area. The old mask hardcoded fill="#fff",
      // which painted a visible white band in dark mode (the card is not white).
      row.__band = [confidenceBand.lower[i], confidenceBand.upper[i]];
    }
    return row;
  });
  const latest = series[0]?.points.at(-1)?.y;
  const yMax = computeYAxisMax(series, benchmarks, confidenceBand);

  return (
    <div className="h-full w-full flex flex-col">
      <ResponsiveContainer width="100%" height={height ?? 300}>
        <ComposedChart
          data={data}
          margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
          onClick={(state: { activeLabel?: string; activePayload?: Array<{ value?: number; name?: string }> }) =>
            handleTrendLineClick(state, onPointClick)
          }
          style={onPointClick ? { cursor: 'pointer' } : undefined}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
          <XAxis dataKey="x" tick={{ fontSize: 11 }} />
          <YAxis
            tick={{ fontSize: 11 }}
            label={{ value: yAxisLabel, angle: -90, position: 'insideLeft', fontSize: 11 }}
          />
          {benchmarks ? <BenchmarkBands config={benchmarks} yMax={yMax} /> : null}
          {confidenceBand ? (
            <Area
              type="monotone"
              dataKey="__band"
              stroke="none"
              fill="#4f46e5"
              fillOpacity={0.12}
            />
          ) : null}
          <Tooltip content={<ChartTooltip />} />
          {series.length > 1 ? <Legend /> : null}
          {series.map((s) => (
            <Line
              key={s.name}
              type="monotone"
              dataKey={s.name}
              stroke={s.color ?? '#4f46e5'}
              strokeWidth={2}
              dot={false}
            />
          ))}
        </ComposedChart>
      </ResponsiveContainer>
      {benchmarks ? <TierLegend config={benchmarks} currentValue={latest ?? undefined} /> : null}
    </div>
  );
}

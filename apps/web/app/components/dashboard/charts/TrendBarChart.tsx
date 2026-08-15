'use client';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceLine,
} from 'recharts';
import { CHART_TOOLTIP } from './chartTheme';

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
  layout?: 'grouped' | 'stacked';
  targetLine?: { value: number; label: string };
  height?: number;
}

export function TrendBarChart({
  series,
  yAxisLabel,
  layout = 'grouped',
  targetLine,
  height,
}: Props) {
  const xValues = Array.from(new Set(series.flatMap((s) => s.points.map((p) => p.x))));
  const data = xValues.map((x) => {
    const row: Record<string, string | number | undefined> = { x };
    for (const s of series) row[s.name] = s.points.find((p) => p.x === x)?.y;
    return row;
  });

  return (
    <ResponsiveContainer width="100%" height={height ?? '100%'}>
      <BarChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
        <XAxis dataKey="x" tick={{ fontSize: 11 }} />
        <YAxis
          tick={{ fontSize: 11 }}
          label={{
            value: yAxisLabel,
            angle: -90,
            position: 'insideLeft',
            fontSize: 11,
          }}
        />
        <Tooltip {...CHART_TOOLTIP} />
        {series.length > 1 ? <Legend /> : null}
        {targetLine ? (
          <ReferenceLine
            y={targetLine.value}
            stroke="#dc2626"
            strokeDasharray="4 4"
            label={{
              value: targetLine.label,
              fontSize: 10,
              fill: '#dc2626',
              position: 'right',
            }}
          />
        ) : null}
        {series.map((s) => (
          <Bar
            key={s.name}
            dataKey={s.name}
            fill={s.color ?? '#4f46e5'}
            stackId={layout === 'stacked' ? 'all' : undefined}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

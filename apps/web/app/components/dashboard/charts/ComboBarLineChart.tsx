'use client';
import {
  ResponsiveContainer,
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts';
import { CHART_TOOLTIP } from './chartTheme';

interface ComboPoint {
  label: string;
  delivered: number;
  cycleDays: number | null;
  flagged?: boolean;
}

interface Props {
  points: ComboPoint[];
  height?: number;
}

// Custom dot renderer for the cycle-time line: flagged periods (bulk-close /
// stale-data guard tripped) render as a hollow marker so they read as
// "don't trust this point" at a glance, per the plan's bulk-close guard.
function CycleDot(props: {
  cx?: number;
  cy?: number;
  payload?: ComboPoint;
  index?: number;
}) {
  const { cx, cy, payload, index } = props;
  if (typeof cx !== 'number' || typeof cy !== 'number' || payload?.cycleDays === null) {
    return <g key={`dot-empty-${index}`} />;
  }
  const flagged = Boolean(payload?.flagged);
  return (
    <circle
      key={`dot-${index}`}
      cx={cx}
      cy={cy}
      r={4}
      stroke="#dc2626"
      strokeWidth={flagged ? 2 : 1}
      fill={flagged ? 'none' : '#dc2626'}
    />
  );
}

export function ComboBarLineChart({ points, height }: Props) {
  const data = points.map((p) => ({
    label: p.label,
    delivered: p.delivered,
    cycleDays: p.cycleDays,
    flagged: p.flagged ?? false,
  }));

  return (
    <ResponsiveContainer width="100%" height={height ?? 300}>
      <ComposedChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
        <XAxis dataKey="label" tick={{ fontSize: 11 }} />
        <YAxis
          yAxisId="left"
          tick={{ fontSize: 11, className: 'tabular-nums' }}
          label={{ value: 'items', angle: -90, position: 'insideLeft', fontSize: 11 }}
        />
        <YAxis
          yAxisId="right"
          orientation="right"
          tick={{ fontSize: 11, className: 'tabular-nums' }}
          label={{
            value: 'days · lower=better',
            angle: 90,
            position: 'insideRight',
            fontSize: 11,
          }}
        />
        <Tooltip {...CHART_TOOLTIP} />
        <Legend />
        <Bar yAxisId="left" dataKey="delivered" name="Delivered" fill="#4f46e5" />
        <Line
          yAxisId="right"
          type="monotone"
          dataKey="cycleDays"
          name="Cycle time (days)"
          stroke="#dc2626"
          strokeWidth={2}
          dot={CycleDot}
          connectNulls
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

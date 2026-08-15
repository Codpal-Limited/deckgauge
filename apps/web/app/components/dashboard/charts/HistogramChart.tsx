'use client';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from 'recharts';
import { CHART_TOOLTIP } from './chartTheme';
import type { Tier } from '@deckgauge/shared';

interface Bucket {
  label: string;
  count: number;
  tier?: Tier;
}

interface Props {
  buckets: Bucket[];
  height?: number;
}

const TIER_FILL: Record<Tier, string> = {
  elite: '#10b981',
  high: '#84cc16',
  medium: '#f59e0b',
  low: '#f43f5e',
};

export function HistogramChart({ buckets, height }: Props) {
  return (
    <ResponsiveContainer width="100%" height={height ?? '100%'}>
      <BarChart data={buckets} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
        <XAxis dataKey="label" tick={{ fontSize: 10 }} />
        <YAxis tick={{ fontSize: 11 }} />
        <Tooltip {...CHART_TOOLTIP} />
        <Bar dataKey="count">
          {buckets.map((b, i) => (
            <Cell key={i} fill={b.tier ? TIER_FILL[b.tier] : '#4f46e5'} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

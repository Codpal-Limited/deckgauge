'use client';

import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { CHART_TOOLTIP } from '../charts/chartTheme';
import type { InvestmentCategory } from '@deckgauge/shared';
import { useWidgetConfigWithBoardPeriod } from '../useWidgetConfigWithBoardPeriod';
import { useWidgetData } from './useWidgetData';
import { WidgetErrorState } from './WidgetErrorState';
import { WidgetEmptyState } from './WidgetEmptyState';

interface Props {
  boardId: string;
  config: Record<string, unknown>;
}

interface Slice {
  category: InvestmentCategory;
  label: string;
  count: number;
  pct: number;
}

interface Data {
  slices: Slice[];
  total: number;
  emptyReason?: string;
}

// Fixed colour per investment category so the donut reads consistently and the
// legend colours never shuffle when a category drops out for a given window.
const CATEGORY_COLOR: Record<InvestmentCategory, string> = {
  feature: '#22c55e', // green — new value delivered
  bug: '#f43f5e', // rose — corrective work
  tech_debt: '#f59e0b', // amber — deferred cost
  maintenance: '#64748b', // slate — keep-the-lights-on
  other: '#a855f7', // violet — uncategorised
};

export default function InvestmentAllocationWidget({ boardId, config }: Props) {
  const merged = useWidgetConfigWithBoardPeriod(config);
  const { data, error } = useWidgetData<Data>(boardId, 'INVESTMENT_ALLOCATION', merged);

  if (error) return <WidgetErrorState />;
  if (!data) return <p className="text-sm text-slate-400">Loading…</p>;
  if (data.emptyReason) return <WidgetEmptyState boardId={boardId} reason={data.emptyReason} />;
  if (data.slices.length === 0)
    return <p className="text-sm text-slate-400 p-2">No completed work in this window.</p>;

  return (
    <ResponsiveContainer width="100%" height="100%">
      <PieChart>
        <Pie
          data={data.slices}
          dataKey="count"
          nameKey="label"
          cx="50%"
          cy="50%"
          innerRadius="45%"
          outerRadius="75%"
          paddingAngle={2}
        >
          {data.slices.map((s) => (
            <Cell key={s.category} fill={CATEGORY_COLOR[s.category]} />
          ))}
        </Pie>
        <Tooltip
          {...CHART_TOOLTIP}
          formatter={(value, _name, item) => {
            const slice = (item as { payload?: Slice } | undefined)?.payload;
            return [`${value} (${slice?.pct ?? 0}%)`, slice?.label ?? ''];
          }}
        />
        <Legend />
      </PieChart>
    </ResponsiveContainer>
  );
}

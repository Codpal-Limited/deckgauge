'use client';

import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { CHART_TOOLTIP } from '../charts/chartTheme';
import { useWidgetData } from './useWidgetData';
import { WidgetErrorState } from './WidgetErrorState';

interface Props {
  boardId: string;
  config: Record<string, unknown>;
}

interface Data {
  items: Array<{ label: string; value: number; color: string }>;
}

export default function StatusDistributionWidget({ boardId, config }: Props) {
  const { data, error } = useWidgetData<Data>(boardId, 'STATUS_DISTRIBUTION', config);

  if (error) return <WidgetErrorState />;
  if (!data) return <p className="text-sm text-slate-400">Loading...</p>;
  if (data.items.length === 0) return <p className="text-sm text-slate-400">No data</p>;

  return (
    <ResponsiveContainer width="100%" height="100%">
      <PieChart>
        <Pie
          data={data.items}
          dataKey="value"
          nameKey="label"
          cx="50%"
          cy="50%"
          innerRadius="40%"
          outerRadius="70%"
          paddingAngle={2}
        >
          {data.items.map((item, i) => (
            <Cell key={i} fill={item.color} />
          ))}
        </Pie>
        <Tooltip {...CHART_TOOLTIP} />
        <Legend />
      </PieChart>
    </ResponsiveContainer>
  );
}

'use client';

import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { CHART_TOOLTIP } from '../charts/chartTheme';
import { useWidgetData } from './useWidgetData';
import { WidgetErrorState } from './WidgetErrorState';

interface StatusEntry {
  label: string;
  count: number;
  color: string;
}

interface GroupData {
  name: string;
  statuses: StatusEntry[];
}

interface Props {
  boardId: string;
  config: Record<string, unknown>;
}

export default function StatusByGroupWidget({ boardId, config }: Props) {
  const { data, error } = useWidgetData<{ groups: GroupData[] }>(boardId, 'STATUS_BY_GROUP', config);

  if (error) return <WidgetErrorState />;
  if (!data) return <p className="text-sm text-slate-400">Loading...</p>;
  if (data.groups.length === 0) return <p className="text-sm text-slate-400">No data</p>;

  const allStatuses = new Map<string, string>();
  for (const group of data.groups) {
    for (const s of group.statuses) {
      allStatuses.set(s.label, s.color);
    }
  }

  const chartData = data.groups.map((g) => {
    const row: Record<string, unknown> = { name: g.name };
    for (const s of g.statuses) {
      row[s.label] = s.count;
    }
    return row;
  });

  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={chartData} layout="vertical">
        <XAxis type="number" />
        <YAxis type="category" dataKey="name" width={100} tick={{ fontSize: 12 }} />
        <Tooltip {...CHART_TOOLTIP} />
        <Legend />
        {Array.from(allStatuses.entries()).map(([label, color]) => (
          <Bar key={label} dataKey={label} stackId="stack" fill={color} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

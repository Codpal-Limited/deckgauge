'use client';

import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { CHART_TOOLTIP } from '../charts/chartTheme';
import { useWidgetData } from './useWidgetData';
import { WidgetErrorState } from './WidgetErrorState';

interface Props {
  boardId: string;
  config: Record<string, unknown>;
}

interface Data {
  owners: Array<{ name: string; count: number }>;
}

export default function ItemsByOwnerWidget({ boardId, config }: Props) {
  const { data, error } = useWidgetData<Data>(boardId, 'ITEMS_BY_OWNER', config);

  if (error) return <WidgetErrorState />;
  if (!data) return <p className="text-sm text-slate-400">Loading...</p>;
  if (data.owners.length === 0) return <p className="text-sm text-slate-400">No data</p>;

  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data.owners} layout="vertical">
        <XAxis type="number" />
        <YAxis type="category" dataKey="name" width={100} tick={{ fontSize: 12 }} />
        <Tooltip {...CHART_TOOLTIP} />
        <Bar dataKey="count" fill="#6366f1" radius={[0, 4, 4, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

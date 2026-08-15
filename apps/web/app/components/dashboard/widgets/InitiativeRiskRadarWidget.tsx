'use client';

import { useWidgetData } from './useWidgetData';
import { WidgetErrorState } from './WidgetErrorState';
import { WidgetEmptyState } from './WidgetEmptyState';

interface Props {
  boardId: string;
  config: Record<string, unknown>;
}

interface Initiative {
  name: string;
  due_date: string;
  days_until_due: number;
  status: 'on_track' | 'at_risk' | 'overdue';
  source: 'jira' | 'ado' | 'github';
}

interface Data {
  initiatives: Initiative[];
  emptyReason?: string;
}

const BADGE = {
  on_track: 'bg-emerald-100 text-emerald-700',
  at_risk: 'bg-amber-100 text-amber-700',
  overdue: 'bg-rose-100 text-rose-700',
} as const;

export default function InitiativeRiskRadarWidget({ boardId, config }: Props) {
  const { data, error } = useWidgetData<Data>(boardId, 'INITIATIVE_RISK_RADAR', config);
  if (error) return <WidgetErrorState />;
  if (!data) return <p className="text-sm text-slate-400">Loading…</p>;
  if (data.emptyReason) return <WidgetEmptyState boardId={boardId} reason={data.emptyReason} />;
  if (data.initiatives.length === 0)
    return (
      <p className="text-sm text-slate-500 p-2">
        No open initiatives with a due date. Set a Due date on a board row to track it here.
      </p>
    );
  return (
    <ul className="divide-y divide-slate-100 text-sm overflow-auto h-full">
      {data.initiatives.map((it, i) => (
        <li key={i} className="flex items-center justify-between px-3 py-2">
          <div>
            <p className="font-medium text-slate-800">{it.name}</p>
            <p className="text-xs text-slate-500">
              {it.source} · due {it.due_date}
            </p>
          </div>
          <span className={`text-xs px-2 py-0.5 rounded ${BADGE[it.status]}`}>
            {it.status.replace('_', ' ')}
          </span>
        </li>
      ))}
    </ul>
  );
}

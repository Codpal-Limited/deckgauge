'use client';
import { SortableTable } from '../charts/SortableTable';
import { useWidgetConfigWithBoardPeriod } from '../useWidgetConfigWithBoardPeriod';
import { useWidgetData } from './useWidgetData';
import { WidgetErrorState } from './WidgetErrorState';
import { WidgetEmptyState } from './WidgetEmptyState';

interface Props {
  boardId: string;
  config: Record<string, unknown>;
}

interface Row extends Record<string, unknown> {
  period: string;
  ai_pr_pct: number;
  ai_commit_pct: number;
  pr_total: number;
  commit_total: number;
}

interface Signal {
  signal: string;
  count: number;
}

interface Data {
  rows: Row[];
  signals?: Signal[];
  emptyReason?: string;
}

export default function AiAdoptionWidget({ boardId, config }: Props) {
  const merged = useWidgetConfigWithBoardPeriod(config);
  const { data, error } = useWidgetData<Data>(boardId, 'AI_ADOPTION', merged);
  if (error) return <WidgetErrorState />;
  if (!data) return <p className="text-sm text-slate-400">Loading…</p>;
  if (data.emptyReason) return <WidgetEmptyState boardId={boardId} reason={data.emptyReason} />;
  return (
    <div className="flex flex-col h-full gap-1">
      <div className="flex-1 min-h-0">
        <SortableTable<Row>
          rows={data.rows}
          defaultSortKey="period"
          defaultSortDir="asc"
          columns={[
            { key: 'period', label: 'Period', sortable: true },
            { key: 'ai_pr_pct', label: 'AI PR %', sortable: true, align: 'right' },
            { key: 'ai_commit_pct', label: 'AI Commit %', sortable: true, align: 'right' },
            { key: 'pr_total', label: 'PRs', sortable: true, align: 'right' },
            { key: 'commit_total', label: 'Commits', sortable: true, align: 'right' },
          ]}
        />
      </div>
      <p className="text-xs text-slate-500 px-2">Detection is trailer-based; absence ≠ zero use.</p>
    </div>
  );
}

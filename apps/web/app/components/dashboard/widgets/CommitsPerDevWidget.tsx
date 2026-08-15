'use client';
import { SortableTable } from '../charts/SortableTable';
import { SparklineCell } from '../charts/SparklineCell';
import { useWidgetConfigWithBoardPeriod } from '../useWidgetConfigWithBoardPeriod';
import { useWidgetData } from './useWidgetData';
import { WidgetErrorState } from './WidgetErrorState';
import { WidgetEmptyState } from './WidgetEmptyState';

interface Props {
  boardId: string;
  config: Record<string, unknown>;
}

interface Row {
  email: string;
  name: string;
  userId: string | null;
  commits: number;
  additions: number;
  deletions: number;
  ai_pct: number;
  trend: number[];
}

interface Data {
  rows: Row[];
  emptyReason?: string;
}

export default function CommitsPerDevWidget({ boardId, config }: Props) {
  const merged = useWidgetConfigWithBoardPeriod(config);
  const { data, error } = useWidgetData<Data>(boardId, 'COMMITS_PER_DEV', merged);
  if (error) return <WidgetErrorState />;
  if (!data) return <p className="text-sm text-slate-400">Loading…</p>;
  if (data.emptyReason) return <WidgetEmptyState boardId={boardId} reason={data.emptyReason} />;
  return (
    <SortableTable<Row>
      rows={data.rows}
      defaultSortKey="commits"
      columns={[
        { key: 'name', label: 'Developer', sortable: true },
        { key: 'commits', label: 'Commits', sortable: true, align: 'right' },
        {
          key: 'additions',
          label: 'Lines',
          align: 'right',
          render: (r) => (
            <span>
              <span className="text-emerald-700">+{r.additions}</span>{' '}
              <span className="text-rose-700">−{r.deletions}</span>
            </span>
          ),
        },
        {
          key: 'ai_pct',
          label: 'AI %',
          sortable: true,
          align: 'right',
          render: (r) => <span>{r.ai_pct.toFixed(1)}%</span>,
        },
        {
          key: 'trend',
          label: 'Trend',
          render: (r) => <SparklineCell points={r.trend} showLast />,
        },
      ]}
    />
  );
}

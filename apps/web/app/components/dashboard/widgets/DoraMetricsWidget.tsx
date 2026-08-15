'use client';

import type { DoraMetric } from '@deckgauge/shared';
import { useWidgetConfigWithBoardPeriod } from '../useWidgetConfigWithBoardPeriod';
import { useWidgetData } from './useWidgetData';
import { WidgetErrorState } from './WidgetErrorState';
import { WidgetEmptyState } from './WidgetEmptyState';

interface Props {
  boardId: string;
  config: Record<string, unknown>;
}

interface Data {
  metrics: DoraMetric[];
  weeks: number;
  deploySource?: 'deployments' | 'merge_proxy';
  changeFailureSource?: 'deployments' | 'commit_proxy';
  emptyReason?: string;
}

// Two of the four DORA metrics can be either measured or estimated, and each has
// its own source and its own reason for falling back — so they are labelled
// independently. An unlabelled proxy reads as an observed number and gets quoted
// in board decks as one; a blanket caveat over the whole card would be the
// opposite error, discrediting the metrics that ARE observed.
function proxyNoteFor(metricKey: string, data: Data): string | null {
  if (metricKey === 'deploy_frequency') {
    return data.deploySource === 'deployments'
      ? null
      : 'Proxied from merged-PR count — no deployment source on this board, or none of its release stages could be identified as production.';
  }
  if (metricKey === 'change_failure_rate') {
    return data.changeFailureSource === 'deployments'
      ? null
      : 'Proxied from the share of commits whose message looks corrective — no production release on this board carried a pass/fail outcome.';
  }
  return null;
}

const TIER_STYLE: Record<string, { label: string; cls: string }> = {
  elite: { label: 'Elite', cls: 'bg-emerald-100 text-emerald-700' },
  high: { label: 'High', cls: 'bg-sky-100 text-sky-700' },
  medium: { label: 'Medium', cls: 'bg-amber-100 text-amber-700' },
  low: { label: 'Low', cls: 'bg-rose-100 text-rose-700' },
};

function formatValue(m: DoraMetric): string {
  if (m.value == null) return '—';
  switch (m.unit) {
    case 'hours':
      return m.value >= 48 ? `${(m.value / 24).toFixed(1)}d` : `${m.value}h`;
    case 'percent':
      return `${m.value}%`;
    case 'count':
      return `${m.value}/wk`;
    default:
      return String(m.value);
  }
}

export default function DoraMetricsWidget({ boardId, config }: Props) {
  const merged = useWidgetConfigWithBoardPeriod(config);
  const { data, error } = useWidgetData<Data>(boardId, 'DORA_METRICS', merged);

  if (error) return <WidgetErrorState />;
  if (!data) return <p className="text-sm text-slate-400">Loading…</p>;
  if (data.emptyReason) return <WidgetEmptyState boardId={boardId} reason={data.emptyReason} />;
  return (
    <div className="grid grid-cols-2 gap-2 p-1">
      {data.metrics.map((m) => {
        const tier = m.tier ? TIER_STYLE[m.tier] : null;
        const proxyNote = proxyNoteFor(m.key, data);
        return (
          <div
            key={m.key}
            className="flex flex-col justify-between rounded-lg border border-slate-200 p-3"
          >
            <div className="text-xs font-medium text-slate-500">
              {m.label}
              {proxyNote ? (
                <span className="ml-1 cursor-help text-slate-400" title={proxyNote}>
                  (proxy)
                </span>
              ) : null}
            </div>
            <div className="mt-1 flex items-baseline justify-between">
              <span className="text-2xl font-semibold text-slate-800">{formatValue(m)}</span>
              <span
                className={`ml-2 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                  tier ? tier.cls : 'bg-slate-100 text-slate-400'
                }`}
              >
                {tier ? tier.label : 'N/A'}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

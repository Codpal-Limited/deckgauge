'use client';

import type { JSX } from 'react';

import type { BenchmarkConfig, Tier } from '@deckgauge/shared';
import { WIDGET_HELP } from './widgetHelp';
import { widgetRegistry } from './widgetRegistry';
import { docUrlFor } from './widgetDocs';

interface Props {
  widgetType: string;
}

const TIER_META: Record<Tier, { label: string; cls: string }> = {
  elite: { label: 'Elite', cls: 'bg-emerald-100 text-emerald-700' },
  high: { label: 'High', cls: 'bg-sky-100 text-sky-700' },
  medium: { label: 'Medium', cls: 'bg-amber-100 text-amber-700' },
  low: { label: 'Low', cls: 'bg-rose-100 text-rose-700' },
};

const TIER_ORDER: Tier[] = ['elite', 'high', 'medium', 'low'];

function unitSuffix(unit: BenchmarkConfig['unit']): string {
  switch (unit) {
    case 'hours':
      return 'h';
    case 'days':
      return 'd';
    case 'percent':
      return '%';
    case 'lines':
      return ' lines';
    default:
      return '';
  }
}

// Human-readable threshold range per tier, derived from the benchmark config so
// the numbers stay in lockstep with BENCHMARKS_V1 and are never re-typed here.
function tierRange(tier: Tier, cfg: BenchmarkConfig): string {
  const s = unitSuffix(cfg.unit);
  const { elite, high, medium, direction } = cfg;
  if (direction === 'lower_is_better') {
    switch (tier) {
      case 'elite':
        return `< ${elite}${s}`;
      case 'high':
        return `${elite}–${high}${s}`;
      case 'medium':
        return `${high}–${medium}${s}`;
      case 'low':
        return `≥ ${medium}${s}`;
    }
  }
  switch (tier) {
    case 'elite':
      return `≥ ${elite}${s}`;
    case 'high':
      return `${high}–${elite}${s}`;
    case 'medium':
      return `${medium}–${high}${s}`;
    case 'low':
      return `< ${medium}${s}`;
  }
}

export default function WidgetHelpPopover({ widgetType }: Props): JSX.Element | null {
  const help = WIDGET_HELP[widgetType];
  if (!help) return null;

  const benchmarks = widgetRegistry[widgetType]?.benchmarks;
  const docUrl = docUrlFor(widgetType);

  return (
    <div className="space-y-3 text-sm text-slate-600">
      <section>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-1">
          How to read
        </h4>
        <p className="leading-snug">{help.howToRead}</p>
      </section>

      <section>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-1">
          What to look for
        </h4>
        <ul className="list-disc pl-4 space-y-1">
          {help.whatToLookFor.map((item, i) => (
            <li key={i} className="leading-snug">
              {item}
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-1">
          Use cases
        </h4>
        <ul className="space-y-2">
          {help.useCases.map((uc, i) => (
            <li key={i} className="leading-snug">
              <span className="font-medium text-slate-700">{uc.scenario}</span>
              <span className="block text-slate-500">{uc.signal}</span>
            </li>
          ))}
        </ul>
      </section>

      {benchmarks && (
        <section>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-1">
            Benchmarks
          </h4>
          <ul className="space-y-1">
            {TIER_ORDER.map((tier) => (
              <li key={tier} className="flex items-center gap-2">
                <span
                  className={`inline-block px-1.5 py-0.5 rounded text-xs font-medium ${TIER_META[tier].cls}`}
                >
                  {TIER_META[tier].label}
                </span>
                <span className="text-xs tabular-nums text-slate-500">
                  {tierRange(tier, benchmarks)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {help.rawData && (
        <section>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-1">
            Check the raw data
          </h4>
          <p className="leading-snug">{help.rawData}</p>
        </section>
      )}

      {docUrl && (
        <a
          href={docUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="block pt-1 text-xs font-medium text-indigo-600 hover:text-indigo-700"
        >
          Read the full guide →
        </a>
      )}
    </div>
  );
}

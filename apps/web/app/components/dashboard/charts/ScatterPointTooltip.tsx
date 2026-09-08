'use client';
import type { Tier } from '@deckgauge/shared';
import { CHART_TOOLTIP } from './chartTheme';
import { formatCycleTime } from './formatDuration';

export interface ScatterPoint {
  x: string;
  y: number;
  /** The identity a reader can act on — e.g. `acme/api #482`. */
  label: string;
  /** Optional second line; the PR title for the cycle-time scatter. */
  subtitle?: string;
  href: string;
  tier: Tier;
  author?: string;
}

interface TooltipEntry {
  payload?: ScatterPoint;
}

interface Props {
  active?: boolean;
  payload?: TooltipEntry[];
}

/**
 * Theme-aware tooltip content for {@link ScatterChart}.
 *
 * Recharts' default tooltip renders one row per axis dataKey, so a scatter gets
 * `x` and `y` and nothing else — the rest of the datum is present on
 * `payload[0].payload` and simply never read. That is why this widget could show
 * you an outlier without telling you which PR it was. This component reads the
 * whole point instead of the axis keys.
 *
 * ChartTooltip is the entry-based sibling (`name : value` per series) and is the
 * right shape for line and bar charts; a scatter dot is one record, not a set of
 * series values, so it gets its own.
 */
export function ScatterPointTooltip({ active, payload }: Props) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;

  // Author is absent for bot- and unauthored PRs; the cycle time and merge date
  // are always present, so the line never renders empty.
  const meta = [point.author, formatCycleTime(point.y), `merged ${point.x}`].filter(Boolean);

  return (
    <div
      style={{
        ...CHART_TOOLTIP.contentStyle,
        padding: '8px 12px',
        fontSize: 12,
        maxWidth: 320,
        // PR titles are unbounded and frequently carry an unbroken branch name
        // or URL, which overflows a fixed-width box rather than wrapping.
        overflowWrap: 'anywhere',
      }}
    >
      <div style={{ ...CHART_TOOLTIP.itemStyle, fontWeight: 600 }}>{point.label}</div>
      {point.subtitle ? (
        <div style={{ ...CHART_TOOLTIP.itemStyle, marginTop: 2 }}>{point.subtitle}</div>
      ) : null}
      <div style={{ ...CHART_TOOLTIP.labelStyle, marginTop: 4 }}>{meta.join(' · ')}</div>
    </div>
  );
}

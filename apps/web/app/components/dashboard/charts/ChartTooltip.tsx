'use client';
import { CHART_TOOLTIP } from './chartTheme';

interface TooltipEntry {
  name?: string | number;
  value?: number | string;
  color?: string;
  dataKey?: string | number;
}

interface Props {
  active?: boolean;
  payload?: TooltipEntry[];
  label?: string | number;
}

/**
 * Theme-aware Recharts tooltip content. Uses the shared surface/text tokens so the
 * box flips with light/dark mode (the Recharts default is a hardcoded white box, which
 * reads as white-on-dark), and hides internal helper series whose dataKey starts with
 * `__` (e.g. the confidence-band `__band` range area) so the user never sees raw keys.
 */
export function ChartTooltip({ active, payload, label }: Props) {
  if (!active || !payload || payload.length === 0) return null;
  const items = payload.filter(
    (p) => !String(p.dataKey ?? p.name ?? '').startsWith('__')
  );
  if (items.length === 0) return null;
  return (
    <div style={{ ...CHART_TOOLTIP.contentStyle, padding: '8px 12px', fontSize: 12 }}>
      {label != null && label !== '' && (
        <div style={{ ...CHART_TOOLTIP.labelStyle, marginBottom: 4 }}>{label}</div>
      )}
      {items.map((it, i) => (
        <div key={i} style={CHART_TOOLTIP.itemStyle}>
          {it.name} : {it.value}
        </div>
      ))}
    </div>
  );
}

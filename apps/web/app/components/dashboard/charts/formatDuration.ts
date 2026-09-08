// Duration formatting for chart labels and tooltips.
//
// The break to days at 48h is deliberate rather than aesthetic: DoraMetricsWidget
// renders lead time for changes with the same break, and the PR cycle-time
// scatter colours its dots from the same BENCHMARKS_V1.LEAD_TIME_FOR_CHANGES
// tiers. One number should not read as "312h" in one widget and "13d" in another.

// `toFixed` always emits the decimal, so a whole number arrives as "4.0h".
// Trim it — the precision is meaningless there and the noise is not.
function trimDecimal(value: number, digits: number): string {
  return value.toFixed(digits).replace(/\.0$/, '');
}

export function formatCycleTime(hours: number): string {
  // NaN reaches here when a provider left cycle_time_hours unset; an em dash
  // says "unknown" where "0h" would claim the PR merged instantly.
  if (!Number.isFinite(hours)) return '—';
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${trimDecimal(hours, 1)}h`;
  return `${trimDecimal(hours / 24, 1)}d`;
}

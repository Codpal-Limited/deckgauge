// Shared Recharts styling so charts respect the app's light/dark theme.
//
// Recharts' default tooltip has a hardcoded white background baked into the
// library, which reads as a jarring white box on the dark card. These styles
// use the same CSS variables the rest of the app themes with (defined in
// globals.css and reversed under `.dark`), so tooltips, grid lines, and axis
// ticks flip with the theme. CSS variables resolve in inline styles, so this
// works even though Recharts applies them as element styles.

// Grid lines, axis lines, and tick/label text are themed globally in globals.css
// (via the .recharts-* element classes) rather than per-chart props, because
// Recharts renders those as SVG presentation attributes where CSS variables can't
// resolve. This constant only styles the tooltip, whose contentStyle is an inline
// style (where CSS variables DO resolve).
export const CHART_TOOLTIP = {
  contentStyle: {
    background: 'rgb(var(--surface-1))',
    border: '1px solid rgb(var(--slate-200))',
    borderRadius: '8px',
    boxShadow: '0 4px 16px rgba(0, 0, 0, 0.12)',
    color: 'rgb(var(--slate-800))',
  },
  labelStyle: { color: 'rgb(var(--slate-500))' },
  itemStyle: { color: 'rgb(var(--slate-700))' },
} as const;

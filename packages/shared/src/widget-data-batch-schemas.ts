import { z } from 'zod';

// Batch widget-data contract. The dashboard sends one request listing every
// widget it needs to render; the API resolves them in parallel server-side
// (sharing one auth pass, one board-scope lookup, and the widget cache) and
// returns one result per requested widget. This collapses N per-widget
// round-trips (which Next.js serializes as separate server actions) into one.

export const WidgetDataBatchItemSchema = z.object({
  widgetType: z.string().min(1),
  // Each builder owns its own config shape and tolerates {}; we don't validate
  // the inner shape here (mirrors the single-widget GET route).
  config: z.record(z.string(), z.unknown()).default({}),
});

export const WidgetDataBatchRequestSchema = z.object({
  // Upper bound guards against a pathological request; real boards top out
  // around ~25 widgets.
  widgets: z.array(WidgetDataBatchItemSchema).min(1).max(200),
});

export type WidgetDataBatchItem = z.infer<typeof WidgetDataBatchItemSchema>;
export type WidgetDataBatchRequest = z.infer<typeof WidgetDataBatchRequestSchema>;

// One result per requested widget. `widgetType` + `config` are echoed so the
// client can key results by the same `${widgetType}:${JSON.stringify(config)}`
// string `useWidgetData` already uses. A failed widget carries `error` and
// `data: null` — one bad widget never fails the whole batch.
export interface WidgetDataBatchResultEntry {
  widgetType: string;
  config: Record<string, unknown>;
  data: unknown | null;
  error?: string;
}

export interface WidgetDataBatchResponse {
  results: WidgetDataBatchResultEntry[];
}

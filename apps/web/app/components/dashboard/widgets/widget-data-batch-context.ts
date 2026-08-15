'use client';

import { createContext } from 'react';

export interface WidgetBatchEntry {
  data: unknown;
  error?: string;
}

// Shared batch result for a dashboard render. `status` is 'loading' until the
// single batch request resolves; `entries` maps
// `${widgetType}:${JSON.stringify(config)}` → its result. When this context is
// present, useWidgetData reads from it instead of firing per-widget requests.
export interface WidgetDataBatch {
  status: 'loading' | 'ready';
  entries: Map<string, WidgetBatchEntry>;
}

export const WidgetDataBatchContext = createContext<WidgetDataBatch | null>(null);

export function widgetBatchKey(widgetType: string, config: Record<string, unknown>): string {
  return `${widgetType}:${JSON.stringify(config)}`;
}

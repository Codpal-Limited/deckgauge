'use server';

import { revalidateTag } from 'next/cache';
import type { WidgetDataBatchItem, WidgetDataBatchResponse } from '@deckgauge/shared';
import { apiRequest, authFetch } from './api';
import { widgetsTag } from '../utils/cache-tags';

export async function fetchWidgets(boardId: string, viewId: string) {
  const res = await apiRequest(`/boards/${boardId}/views/${viewId}/widgets`);
  return res.json();
}

// Fetch data for many widgets in a single request. The dashboard uses this
// instead of one fetchWidgetData call per widget: N per-widget server actions
// (which Next.js serializes) collapse into one round-trip, and the API resolves
// them in parallel behind it. Callers key results by
// `${widgetType}:${JSON.stringify(config)}`.
export async function fetchWidgetDataBatch(
  boardId: string,
  widgets: WidgetDataBatchItem[]
): Promise<WidgetDataBatchResponse> {
  const res = await authFetch(`/boards/${boardId}/widgets/data`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ widgets }),
  });
  if (!res.ok) throw new Error(`Widget batch fetch failed: ${res.status}`);
  return res.json();
}

export async function createWidget(
  boardId: string,
  viewId: string,
  data: {
    widgetType: string;
    title: string;
    config: Record<string, unknown>;
    layout: { x: number; y: number; w: number; h: number };
  }
) {
  const res = await apiRequest(`/boards/${boardId}/views/${viewId}/widgets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  revalidateTag(widgetsTag(boardId, viewId));
  return res.json();
}

export async function updateWidget(
  boardId: string,
  viewId: string,
  widgetId: string,
  data: Record<string, unknown>
) {
  const res = await apiRequest(`/boards/${boardId}/views/${viewId}/widgets/${widgetId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  revalidateTag(widgetsTag(boardId, viewId));
  return res.json();
}

export async function deleteWidget(boardId: string, viewId: string, widgetId: string) {
  await apiRequest(`/boards/${boardId}/views/${viewId}/widgets/${widgetId}`, {
    method: 'DELETE',
  });
  revalidateTag(widgetsTag(boardId, viewId));
}

export async function updateWidgetLayouts(
  boardId: string,
  viewId: string,
  layouts: { id: string; layout: { x: number; y: number; w: number; h: number } }[]
) {
  await apiRequest(`/boards/${boardId}/views/${viewId}/widgets/layout`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ layouts }),
  });
}

export async function fetchWidgetData(
  boardId: string,
  widgetType: string,
  config: Record<string, unknown> = {}
) {
  const params =
    Object.keys(config).length > 0
      ? `?config=${encodeURIComponent(JSON.stringify(config))}`
      : '';
  const res = await authFetch(`/boards/${boardId}/widgets/${widgetType}/data${params}`);
  if (!res.ok) throw new Error(`Widget data fetch failed: ${res.status}`);
  return res.json();
}

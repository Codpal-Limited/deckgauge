import type { StatusSpan } from './types.js';

/** Intersect a span with the half-open window [fromMs, toMs). Null if empty. */
export function clipToWindow(span: StatusSpan, fromMs: number, toMs: number): StatusSpan | null {
  const startMs = Math.max(span.startMs, fromMs);
  const endMs = Math.min(span.endMs, toMs);
  if (endMs <= startMs) return null;
  return { ...span, startMs, endMs };
}

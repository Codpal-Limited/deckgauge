import type { StatusSpan } from './types.js';

export interface WeightedSpan {
  span: StatusSpan;
  seconds: number;
}

/**
 * Weight one employee's in-progress spans. 'raw' = full duration each.
 * 'normalized' = sweep-line; each elementary sub-interval's wall-clock is
 * divided equally among the spans active in it, so the per-employee total
 * never exceeds elapsed wall-clock.
 */
export function normalizeConcurrent(spans: StatusSpan[], mode: 'normalized' | 'raw'): WeightedSpan[] {
  if (mode === 'raw') {
    return spans.map((span) => ({ span, seconds: (span.endMs - span.startMs) / 1000 }));
  }

  const acc = new Array<number>(spans.length).fill(0); // ms per span

  const points = new Set<number>();
  for (const s of spans) {
    points.add(s.startMs);
    points.add(s.endMs);
  }
  const sorted = [...points].sort((a, b) => a - b);

  for (let i = 0; i + 1 < sorted.length; i++) {
    const segStart = sorted[i]!;
    const segEnd = sorted[i + 1]!;
    const segMs = segEnd - segStart;
    if (segMs <= 0) continue;
    const activeIdx: number[] = [];
    for (let j = 0; j < spans.length; j++) {
      const s = spans[j]!;
      if (s.startMs <= segStart && s.endMs >= segEnd) activeIdx.push(j);
    }
    if (activeIdx.length === 0) continue;
    const share = segMs / activeIdx.length;
    for (const j of activeIdx) acc[j]! += share;
  }

  return spans.map((span, j) => ({ span, seconds: acc[j]! / 1000 }));
}

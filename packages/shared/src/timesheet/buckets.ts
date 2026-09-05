import type { StatusSpan } from './types.js';

export type Granularity = 'day' | 'week' | 'month';

export interface BucketSlice {
  bucketKey: string;
  startMs: number;
  endMs: number;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** UTC start-of-day for a timestamp. */
function startOfDayUtc(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** The bucket-start timestamp containing `ms` for the given granularity. */
function bucketStart(ms: number, granularity: Granularity): number {
  const day = startOfDayUtc(ms);
  if (granularity === 'day') return day;
  if (granularity === 'week') {
    const dow = new Date(day).getUTCDay(); // 0=Sun..6=Sat
    const backToMonday = (dow + 6) % 7; // days since Monday
    return day - backToMonday * 86_400_000;
  }
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/** The start of the bucket immediately after the one containing `ms`. */
function nextBucketStart(ms: number, granularity: Granularity): number {
  const start = bucketStart(ms, granularity);
  if (granularity === 'day') return start + 86_400_000;
  if (granularity === 'week') return start + 7 * 86_400_000;
  const d = new Date(start);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

/** Format a bucket-start timestamp as its key. */
function keyFor(startMs: number, granularity: Granularity): string {
  const d = new Date(startMs);
  const ymd = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  return granularity === 'month' ? ymd.slice(0, 7) : ymd;
}

/** The bucket key containing `ms` for the given granularity (e.g. "2026-07-13", "2026-07"). */
export function bucketKeyFor(ms: number, granularity: Granularity): string {
  return keyFor(bucketStart(ms, granularity), granularity);
}

/** Split a span into per-bucket slices at UTC bucket boundaries. */
export function splitIntoBuckets(span: StatusSpan, granularity: Granularity): BucketSlice[] {
  const slices: BucketSlice[] = [];
  let cursor = span.startMs;
  while (cursor < span.endMs) {
    const boundary = nextBucketStart(cursor, granularity);
    const sliceEnd = Math.min(boundary, span.endMs);
    slices.push({ bucketKey: keyFor(bucketStart(cursor, granularity), granularity), startMs: cursor, endMs: sliceEnd });
    cursor = sliceEnd;
  }
  return slices;
}

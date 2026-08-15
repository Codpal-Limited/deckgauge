'use client';
import { ReferenceArea, ReferenceDot } from 'recharts';

// Reusable annotation layer for line/composed charts: shaded calendar-event
// bands (release freezes, migrations) plus a single clickable peak marker.
// Composed as children inside a recharts chart, mirroring BenchmarkBands —
// keep this generic (x-domain agnostic) so Phase 2/3 trend widgets can opt in
// without a hard dependency on this widget's shape.
export interface AnnotationEvent {
  label: string;
  kind: string;
  startsAt: string;
  endsAt: string;
  color: string | null;
}

export interface AnnotationPeak {
  period: string;
  value: number;
}

interface Props {
  events?: AnnotationEvent[];
  peak?: AnnotationPeak | null;
  onPeakClick?: (peak: AnnotationPeak) => void;
  // Category values actually present on the chart's x-axis (period buckets).
  // The x-axis is categorical (string dataKey), so a ReferenceArea whose
  // x1/x2 isn't one of these values resolves to no pixel position and
  // silently fails to render — clamp event bounds onto this domain first.
  periods: string[];
}

const DEFAULT_EVENT_FILL = 'rgba(245, 158, 11, 0.12)';
const PEAK_FILL = '#dc2626';

function toDateKey(iso: string): string {
  return iso.slice(0, 10);
}

// Clamps an arbitrary date key onto the nearest in-domain period bucket:
// the last bucket <= target, falling back to the first bucket when the
// target precedes every bucket. Returns null when periods is empty.
function clampToDomain(dateKey: string, periods: string[]): string | null {
  if (periods.length === 0) return null;
  const sorted = [...periods].sort();
  let candidate = sorted[0];
  for (const p of sorted) {
    if (p <= dateKey) candidate = p;
  }
  return candidate;
}

export function AnnotationLayer({ events, peak, onPeakClick, periods }: Props) {
  return (
    <>
      {(events ?? []).map((event, i) => {
        const x1 = clampToDomain(toDateKey(event.startsAt), periods);
        const x2 = clampToDomain(toDateKey(event.endsAt), periods);
        if (x1 === null || x2 === null) return null;
        return (
          <ReferenceArea
            key={`${event.label}-${i}`}
            x1={x1}
            x2={x2}
            fill={event.color ?? DEFAULT_EVENT_FILL}
            strokeOpacity={0}
            ifOverflow="extendDomain"
          />
        );
      })}
      {peak ? (
        <ReferenceDot
          x={peak.period}
          y={peak.value}
          r={6}
          fill={PEAK_FILL}
          stroke="none"
          onClick={() => onPeakClick?.(peak)}
          style={onPeakClick ? { cursor: 'pointer' } : undefined}
        />
      ) : null}
    </>
  );
}

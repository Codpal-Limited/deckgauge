const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function parseIsoDate(value: unknown): Date | null {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return null;
  const d = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export interface ResolvedPeriod {
  from: Date;
  to: Date;
}

export function resolvePeriod(
  config: Record<string, unknown>,
  now: () => number = Date.now,
  defaultDays = 30,
): ResolvedPeriod {
  const fromDate = parseIsoDate(config.from);
  const toDate = parseIsoDate(config.to);
  if (fromDate && toDate && toDate.getTime() > fromDate.getTime()) {
    return { from: fromDate, to: toDate };
  }
  const days =
    typeof config.days === 'number' && config.days > 0 ? config.days : defaultDays;
  const to = new Date(now());
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  return { from, to };
}

// Resolve the two windows a period-comparison widget compares. config.periodA
// and config.periodB each accept { from, to } ISO dates. When omitted, default
// to two adjacent 90-day windows: B = the last 90 days, A = the 90 before that.
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

export function resolveComparePeriods(
  config: Record<string, unknown>,
  now: () => number = Date.now,
): { a: ResolvedPeriod; b: ResolvedPeriod } {
  const rawA = (config.periodA ?? {}) as Record<string, unknown>;
  const rawB = (config.periodB ?? {}) as Record<string, unknown>;
  const hasA = typeof rawA.from === 'string' && typeof rawA.to === 'string';
  const hasB = typeof rawB.from === 'string' && typeof rawB.to === 'string';
  if (hasA && hasB) {
    return { a: resolvePeriod(rawA, now), b: resolvePeriod(rawB, now) };
  }
  const toB = new Date(now());
  const fromB = new Date(toB.getTime() - NINETY_DAYS_MS);
  const toA = fromB;
  const fromA = new Date(toA.getTime() - NINETY_DAYS_MS);
  return { a: { from: fromA, to: toA }, b: { from: fromB, to: toB } };
}

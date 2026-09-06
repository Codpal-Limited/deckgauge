/**
 * Mulberry32 — a 32-bit PRNG in seven lines.
 *
 * Hand-rolled rather than a dependency because `packages/db` publishes to the
 * community repo and this is the entire requirement: seeded, deterministic,
 * uniform enough for demo data. Nothing here is cryptographic.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform integer in [min, max]. */
export function intBetween(rand: () => number, min: number, max: number): number {
  return min + Math.floor(rand() * (max - min + 1));
}

/** Uniform element of a non-empty array. */
export function pick<T>(rand: () => number, items: readonly T[]): T {
  // `items[...]` is `T | undefined` under noUncheckedIndexedAccess. Provably
  // in range: Math.floor(rand() * items.length) is an integer in
  // [0, items.length - 1] for items.length > 0 (rand() is in [0, 1)), and this
  // function's contract is that `items` is non-empty.
  return items[Math.floor(rand() * items.length)]!;
}

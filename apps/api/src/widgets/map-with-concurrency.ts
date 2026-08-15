// Run an async mapper over `items` with at most `limit` in flight at once,
// preserving input order in the result. Used by the batch widget-data route so
// a board with ~25 widgets doesn't fire 25 concurrent ClickHouse + Prisma
// queries at once (which exhausts the Postgres connection pool: "too many
// clients already") — it fans out in bounded waves instead.
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const bound = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      // Bounds-checked above, so the element is present (satisfies
      // noUncheckedIndexedAccess).
      results[index] = await fn(items[index] as T, index);
    }
  }

  await Promise.all(Array.from({ length: bound }, () => worker()));
  return results;
}

import { createHash } from 'node:crypto';

/**
 * Fixed for the life of the feature. Every demo row's id derives from it, and
 * `remove.ts` re-derives the same set to delete exactly what was seeded — so
 * changing this value orphans every previously seeded install's rows rather
 * than upgrading them.
 */
export const DEMO_NAMESPACE = 'd3300000-0000-5000-8000-000000000000';

/**
 * RFC 4122 v5 (SHA-1) id for a demo row.
 *
 * v5 rather than a readable `dg-demo-…` string because
 * `packages/shared/src/connections-schemas.ts` validates `boardId`,
 * `jiraInstanceId` and `targetGroupId` with `z.string().uuid()`. The columns are
 * TEXT, so a readable id would INSERT happily and then fail Zod on the very
 * routes the demo's source rows live on.
 *
 * `key` must never contain a date. Ids have to be stable across runs for the
 * re-seed to upsert and for `--remove` to find its rows; the DATA is anchored to
 * the run's clock, the IDENTITY is not.
 */
export function demoId(key: string): string {
  if (key.trim() === '') {
    throw new Error('demoId: key must be non-empty — an empty key hashes the bare namespace');
  }
  const namespaceBytes = Buffer.from(DEMO_NAMESPACE.replace(/-/g, ''), 'hex');
  const hash = createHash('sha1')
    .update(Buffer.concat([namespaceBytes, Buffer.from(key, 'utf8')]))
    .digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

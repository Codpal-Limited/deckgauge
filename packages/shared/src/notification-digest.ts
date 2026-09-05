import type { NotificationKindValue } from "./notification-schemas.js";

/**
 * The digest release rule.
 *
 * A user's pending rows are released once THE OLDEST is older than the window —
 * a rolling 24h grouping that needs no `lastDigestAt` column and no timezone
 * handling, because the grouping state lives in the rows themselves. Releasing
 * on the oldest (rather than on a clock time) also means a quiet user produces
 * nothing at all.
 *
 * Pure and synchronous: `now` is passed in, so the whole rule is testable without
 * a database or a fake clock. It lives in `shared` rather than in the API because
 * the WORKER is what runs it, and the worker has no dependency on `apps/api`.
 */

export interface PendingNotificationRow {
  id: string;
  userId: string;
  organizationId: string;
  kind: NotificationKindValue;
  createdAt: Date;
}

export interface DigestPayload {
  total: number;
  byKind: Record<string, number>;
}

export interface DigestRelease {
  userId: string;
  organizationId: string;
  /** Every pending row for this user — not only the ones past the window. */
  memberIds: string[];
  payload: DigestPayload;
}

export const DEFAULT_DIGEST_WINDOW_MS = 24 * 60 * 60 * 1000;

export function selectDigestReleases(
  pending: readonly PendingNotificationRow[],
  now: Date,
  windowMs: number = DEFAULT_DIGEST_WINDOW_MS,
): DigestRelease[] {
  const buckets = new Map<string, PendingNotificationRow[]>();
  for (const row of pending) {
    const key = `${row.userId}::${row.organizationId}`;
    // Immutable append: never mutate the caller's array.
    buckets.set(key, [...(buckets.get(key) ?? []), row]);
  }

  const releases: DigestRelease[] = [];
  for (const rows of buckets.values()) {
    const first = rows[0];
    if (!first) continue;

    const oldest = Math.min(...rows.map((r) => r.createdAt.getTime()));
    if (now.getTime() - oldest < windowMs) continue;

    const byKind: Record<string, number> = {};
    for (const r of rows) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;

    releases.push({
      userId: first.userId,
      organizationId: first.organizationId,
      memberIds: rows.map((r) => r.id),
      payload: { total: rows.length, byKind },
    });
  }
  return releases;
}

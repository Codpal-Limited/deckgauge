import { z } from "zod/v4";

/**
 * In-app notifications. IN-APP ONLY — email and push are out of scope
 * (VP-Cockpit-PRD.md:84, planning/REQUIREMENTS.md:41).
 */

/**
 * Mirrors the `NotificationKind` enum in the Prisma schema. The two are kept in
 * step by hand; `apps/api/src/notifications/notification-schema.test.ts` asserts
 * the member lists match, so a migration that adds a kind without updating this
 * fails a test rather than failing a write in production.
 */
export const NotificationKindSchema = z.enum([
  "MENTION",
  "ITEM_ASSIGNED",
  "ITEM_STATUS_CHANGED",
  "ITEM_DUE_DATE_CHANGED",
  "ITEM_COMMENT_ADDED",
  "ITEM_DUE_SOON",
  "ITEM_OVERDUE",
  "ENTITY_SHARED",
  "ACCESS_ROLE_CHANGED",
  "ORG_MEMBER_INVITED",
  "AUTOMATION_NOTIFY",
  "DIGEST",
]);
export type NotificationKindValue = z.infer<typeof NotificationKindSchema>;

/**
 * What the bell renders. Everything here is resolved server-side at READ time
 * from the notification's references — nothing is denormalised into the row
 * itself, because a stored label would be a frozen copy of what the recipient is
 * allowed to see.
 *
 * `href` is required, not optional: a notification you cannot navigate to is a
 * dead row, and making it optional would let one ship silently.
 */
export const NotificationDtoSchema = z.object({
  id: z.string().uuid(),
  kind: NotificationKindSchema,
  /**
   * Display name of whoever caused it. Null when the actor's user row is gone
   * (the FK is ON DELETE SET NULL) — "you were mentioned" still means something,
   * so the UI shows "Someone" rather than dropping the row.
   */
  actorName: z.string().nullable(),
  /** What it is about: a project's name, or an employee's name. */
  subjectLabel: z.string(),
  /**
   * Where clicking it goes. Required, not optional: a notification you cannot
   * navigate to is a dead row, and making it optional would let one ship
   * silently. A DIGEST row expands inline in the panel rather than navigating,
   * so its href is only the middle-click / keyboard fallback — still real.
   */
  href: z.string().min(1),
  /** Kind-specific extras for rendering — never labels or hrefs. */
  payload: z.record(z.string(), z.unknown()).nullable().default(null),
  /** Present only on a DIGEST row: how many events it folded in. */
  digestCount: z.number().int().nonnegative().nullable().default(null),
  /**
   * The board the subject belongs to, for the panel's grouping header. Null for
   * kinds with no board (an org-tree comment, a workspace invite). Resolved at
   * read time like every other label — never stored.
   */
  boardName: z.string().nullable().default(null),
  readAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
});

export type NotificationDto = z.infer<typeof NotificationDtoSchema>;

export const NotificationListResponseSchema = z.object({
  notifications: z.array(NotificationDtoSchema),
  /**
   * The unread count AFTER access filtering — so opening the menu is what
   * reconciles a badge left stale by revoked access. The cheap polled count
   * (`/notifications/unread-count`) does not filter; this one does, and this one
   * is the truth.
   */
  unreadCount: z.number().int().nonnegative(),
});

export type NotificationListResponse = z.infer<typeof NotificationListResponseSchema>;

export const UnreadCountResponseSchema = z.object({
  count: z.number().int().nonnegative(),
});

export type UnreadCountResponse = z.infer<typeof UnreadCountResponseSchema>;

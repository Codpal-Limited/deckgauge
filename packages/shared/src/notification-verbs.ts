import type { NotificationKindValue } from "./notification-schemas";

/**
 * The verb phrase each kind renders as.
 *
 * In `shared` rather than in the API because the web panel renders the same
 * phrases: two copies of a verb table drift the moment a kind is added, and the
 * drift is invisible until someone reads a notification that says the wrong
 * thing.
 *
 * Two shapes, deliberately. Most kinds are actor-first ("Dana assigned you
 * Checkout"). The date-driven kinds and the digest have no actor at all — they
 * are written by the hourly job — so they read subject-first ("Checkout is
 * overdue") and `isSubjectFirst` tells the renderer which sentence to build.
 */
const VERBS: Record<NotificationKindValue, string> = {
  MENTION: "mentioned you in",
  ITEM_ASSIGNED: "assigned you",
  ITEM_STATUS_CHANGED: "changed the status of",
  ITEM_DUE_DATE_CHANGED: "moved the due date of",
  ITEM_COMMENT_ADDED: "commented on",
  ITEM_DUE_SOON: "is due soon",
  ITEM_OVERDUE: "is overdue",
  ENTITY_SHARED: "shared",
  ACCESS_ROLE_CHANGED: "changed your role on",
  ORG_MEMBER_INVITED: "added you to",
  AUTOMATION_NOTIFY: "automation fired on",
  DIGEST: "while you were away",
};

/** Kinds written by the hourly job, which has no actor to name. */
const SUBJECT_FIRST_KINDS: ReadonlySet<NotificationKindValue> = new Set([
  "ITEM_DUE_SOON",
  "ITEM_OVERDUE",
  "DIGEST",
]);

export function verbFor(kind: NotificationKindValue): string {
  return VERBS[kind];
}

export function isSubjectFirst(kind: NotificationKindValue): boolean {
  return SUBJECT_FIRST_KINDS.has(kind);
}

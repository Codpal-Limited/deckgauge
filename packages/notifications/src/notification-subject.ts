import type { AccessEntityKind } from '@deckgauge/shared';

/**
 * What a notification is about. Each variant matches a subject column on the row
 * and carries the parent the access check needs — the caller already loaded it,
 * so re-deriving it here would be a second query for something we were just
 * handed.
 *
 * `none` exists for the two kinds with nothing to point at: a released DIGEST
 * summary, and a workspace invite (the organization is already on the row).
 *
 * Its own module, not `notification.service.ts`, so the dispatcher and the
 * service can both name it without importing each other.
 */
export type NotificationSubject =
  | { kind: 'projectComment'; id: string; boardId: string }
  | { kind: 'orgEmployeeComment'; id: string; orgTreeId: string }
  | { kind: 'project'; id: string; boardId: string }
  | { kind: 'share'; shareKind: AccessEntityKind; entityId: string }
  | { kind: 'none' };

/**
 * The two comment variants alone. A mention can only come from a comment, so the
 * mention path takes THIS rather than the full union — the narrowing is what
 * lets the compiler prove both branches are handled.
 */
export type NotificationCommentSubject = Extract<
  NotificationSubject,
  { kind: 'projectComment' } | { kind: 'orgEmployeeComment' }
>;

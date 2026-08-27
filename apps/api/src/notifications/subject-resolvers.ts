import type { AccessEntityKind } from '@deckgauge/shared';

/**
 * Where a notification goes when it is clicked, per kind.
 *
 * Hrefs are BUILT, never stored — a stored href is a frozen copy of a route, and
 * this repo has already moved one (the board's canonical URL is `/?boardId=`; the
 * `/boards/:id` path has no index page).
 */

export type ResolvedSubject =
  | { kind: 'projectComment'; boardId: string; projectId: string; commentId: string }
  | { kind: 'project'; boardId: string; projectId: string }
  | { kind: 'orgEmployeeComment'; orgTreeId: string }
  | { kind: 'share'; shareKind: AccessEntityKind; entityId: string; orgTreeId?: string }
  | { kind: 'none' };

/**
 * Where a notification with nothing to open goes. A workspace invite has no
 * subject, and a released DIGEST expands INLINE in the panel rather than
 * navigating — so this is the middle-click / keyboard fallback, not the primary
 * action. Somewhere real beats a dead row or an href of "#".
 */
const SETTINGS_HREF = '/settings/notifications';

export function buildHref(subject: ResolvedSubject): string {
  switch (subject.kind) {
    case 'projectComment':
      return `/?boardId=${subject.boardId}&itemId=${subject.projectId}&commentId=${subject.commentId}`;
    case 'project':
      return `/?boardId=${subject.boardId}&itemId=${subject.projectId}`;
    case 'orgEmployeeComment':
      return `/org/${subject.orgTreeId}`;
    case 'share':
      switch (subject.shareKind) {
        case 'board':
          return `/?boardId=${subject.entityId}`;
        case 'orgTree':
          return `/org/${subject.entityId}`;
        case 'roadmap':
          return `/roadmap/${subject.entityId}`;
        case 'comparison':
          return `/comparison/${subject.entityId}`;
        case 'employeeBoard':
          // No page of its own — an employee board is rendered inside its tree.
          return subject.orgTreeId ? `/org/${subject.orgTreeId}` : SETTINGS_HREF;
      }
    case 'none':
      return SETTINGS_HREF;
  }
}

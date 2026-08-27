import type { PrismaClient } from '@deckgauge/db';
import {
  ACCESS_ENTITIES,
  type AccessEntityKind,
  type NotificationDto,
  type NotificationKindValue,
  type NotificationListResponse,
  type OrgRoleValue,
} from '@deckgauge/shared';
import { accessibleBoardIds, accessibleOrgTreeIds, type BoardAccessLog } from '../auth/board-access.js';
import { NotificationDispatcher } from './notification-dispatcher.js';
import type {
  NotificationCommentSubject,
  NotificationSubject,
} from './notification-subject.js';
import { buildHref } from './subject-resolvers.js';

/** Newest-first, capped. No paging: a bell menu is not a mailbox. */
const LIST_LIMIT = 50;

/**
 * What a share notification calls its subject. Generic on purpose: the entity's
 * own NAME is not read here, because the row that would supply it may have been
 * deleted and the kind is what the reader actually needs ("shared a roadmap with
 * you"). The href still lands on the real thing when it exists.
 */
const SHARE_LABELS: Record<AccessEntityKind, string> = {
  board: 'a board',
  orgTree: 'an org tree',
  roadmap: 'a roadmap',
  employeeBoard: 'an employee board',
  comparison: 'a comparison',
};

/** Namespaced so a roadmap id can never satisfy a comparison's access check. */
function shareKey(kind: AccessEntityKind, entityId: string): string {
  return `${kind}::${entityId}`;
}

/**
 * Prisma hands JSON back as `JsonValue`, which includes arrays and scalars. The
 * DTO promises an object or null, so anything else is normalised away rather than
 * shipped to a renderer that would treat it as a record.
 */
function asPayload(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

// Re-exported so the many existing importers of `NotificationSubject` from this
// module keep working; the definition lives in notification-subject.ts.
export type { NotificationSubject, NotificationCommentSubject };

export interface NotifyMentionsInput {
  organizationId: string;
  /** Null only where no user is resolved (single-user mode bypasses every policy). */
  actorId: string | null;
  /** Ids read out of the STORED comment body — never an address list from the client. */
  mentionIds: readonly string[];
  subject: NotificationCommentSubject;
}

interface ListOptions {
  unreadOnly?: boolean;
  log?: BoardAccessLog;
}

export class NotificationService {
  private readonly dispatcher: NotificationDispatcher;

  constructor(private readonly prisma: PrismaClient) {
    this.dispatcher = new NotificationDispatcher(prisma);
  }

  /**
   * Turn the mentions in a comment into notifications.
   *
   * Two filters, in this order: who can actually reach the subject (design D2),
   * then drop the actor (D4). Order matters only for clarity — but doing the
   * access check first keeps "I mentioned myself" from ever reaching a query.
   */
  async notifyMentions(input: NotifyMentionsInput): Promise<number> {
    // Straight through the dispatcher, like every other kind. Mentions predate
    // it and used to write their own rows; routing them here is what makes a
    // per-board MENTIONS_ONLY / NONE level and an explicit `MENTION: OFF`
    // preference apply to mentions too, instead of only to the newer kinds.
    return this.dispatcher.dispatch({
      kind: 'MENTION',
      organizationId: input.organizationId,
      actorId: input.actorId,
      recipientIds: input.mentionIds,
      subject: input.subject,
    });
  }

  /**
   * The recipient's newest notifications, with everything they render resolved
   * here rather than stored (design D1) — and with anything they can no longer
   * reach dropped.
   *
   * `orgRole` is the caller's role in `organizationId`, passed in rather than
   * re-queried: the route already holds it on `req.membership`.
   */
  async list(
    userId: string,
    organizationId: string,
    orgRole: OrgRoleValue,
    opts: ListOptions = {},
  ): Promise<NotificationListResponse> {
    const rows = await this.prisma.notification.findMany({
      where: {
        userId,
        organizationId,
        // A DIGEST-mode row awaiting release must never appear here. That
        // exclusion IS what makes the digest a digest: without it the reader
        // sees every event AND the summary of them.
        digestPending: false,
        ...(opts.unreadOnly ? { readAt: null } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: LIST_LIMIT,
      select: {
        id: true,
        kind: true,
        readAt: true,
        createdAt: true,
        payload: true,
        shareKind: true,
        shareEntityId: true,
        actor: { select: { name: true } },
        _count: { select: { members: true } },
        projectComment: {
          select: {
            id: true,
            project: {
              select: { id: true, name: true, boardId: true, board: { select: { name: true } } },
            },
          },
        },
        orgEmployeeComment: {
          select: { employee: { select: { name: true, orgTreeId: true } } },
        },
        project: {
          select: { id: true, name: true, boardId: true, board: { select: { name: true } } },
        },
      },
    });
    if (rows.length === 0) return { notifications: [], unreadCount: 0 };

    // `Project.boardId` is nullable — a project can outlive its board. Such a
    // notification has nothing to check access against, so it is dropped in
    // `resolve` rather than being admitted by a permissive check here.
    const boardIds = [
      ...new Set(
        rows.flatMap((r) => {
          const ids = [r.projectComment?.project.boardId, r.project?.boardId];
          // A `board` share points at a board too, and it is checked by the same
          // one call — not by a second, looser path.
          if (r.shareKind === 'board' && r.shareEntityId) ids.push(r.shareEntityId);
          return ids.filter((id): id is string => !!id);
        }),
      ),
    ];
    const treeIds = [
      ...new Set(
        rows.flatMap((r) => {
          const ids = [r.orgEmployeeComment?.employee.orgTreeId];
          if (r.shareKind === 'orgTree' && r.shareEntityId) ids.push(r.shareEntityId);
          return ids.filter((id): id is string => !!id);
        }),
      ),
    ];

    const membership = { organizationId, role: orgRole };
    // One call for the whole page, not one per row. `accessibleBoardIds` already
    // applies the org-role ceiling AND floor, so an org admin holding no grant
    // still sees their own notifications.
    const okBoards = boardIds.length
      ? await accessibleBoardIds(this.prisma, userId, boardIds, 'VIEWER', opts.log, membership)
      : new Set<string>();
    // `accessibleOrgTreeIds` has no admin floor of its own (its other callers
    // rely on grant-only semantics), so the floor is applied here — otherwise an
    // admin mentioned on an employee card could never see the notification.
    //
    // **Invariant: `okTrees` contains only trees the caller may reach while acting
    // in `organizationId`.** It is consumed below as a REACHABILITY predicate, so
    // anything in it that the caller cannot reach here is an admission waiting for
    // a matching row — a grant narrows reach inside a tenant, it never establishes
    // reach into one.
    //
    // The GRANT arm establishes that itself, because the scope is passed: a user's
    // grants span organizations whenever they hold concurrent memberships (a
    // supported state) or carry grants orphaned before the offboarding revoke,
    // which is not retroactive.
    //
    // The ADMIN arm deliberately does NOT go through that predicate, and it is not
    // an oversight. The whole point of the floor is that an org admin holds no
    // grant row, so scoping them through a grant query returns nothing and their
    // own notifications become invisible to them. What bounds the arm instead is
    // narrower and worth stating as a condition rather than as a fact about
    // another module: **every tree id derivable from a notification row must
    // belong to that row's organization.** Both derivations satisfy it by
    // construction — an `orgEmployeeComment`'s tree and an `orgTree` share's
    // `shareEntityId` are each written through a policed, organization-scoped
    // route — so the row filter is the boundary here and this arm adds no reach
    // beyond it.
    //
    // That is a real condition, so name what would break it: a row whose tree FK
    // crosses tenants. Nothing can currently write one, and if something ever
    // could, the defect would be at the write and this arm would need its own
    // predicate — not the other way round.
    const okTrees =
      treeIds.length === 0
        ? new Set<string>()
        : orgRole === 'ADMIN'
          ? new Set(treeIds)
          : new Set(await accessibleOrgTreeIds(this.prisma, userId, { organizationId }, opts.log));

    const okShares = await this.reachableShares(rows, userId, orgRole);

    const notifications: NotificationDto[] = [];
    for (const row of rows) {
      const resolved = this.resolve(row, okBoards, okTrees, okShares);
      if (resolved) notifications.push(resolved);
    }

    return {
      notifications,
      unreadCount: notifications.filter((n) => n.readAt === null).length,
    };
  }

  /**
   * Which of this page's SHARE subjects the caller can still reach.
   *
   * `board` and `orgTree` shares are deliberately absent: they are answered by
   * `okBoards` / `okTrees` above, so there is exactly one access path per entity
   * type rather than two that can disagree. The remaining three are checked
   * against the descriptor's own ACL, one query per kind — a grant row is what
   * admits, and a revoked grant drops the row exactly as it drops a comment.
   *
   * An org ADMIN is admitted without a grant, matching the floor that
   * `effectiveBoardRole` applies everywhere else; without it an admin who shared
   * something with themselves could never see the confirmation.
   */
  private async reachableShares(
    rows: ReadonlyArray<{ shareKind: string | null; shareEntityId: string | null }>,
    userId: string,
    orgRole: OrgRoleValue,
  ): Promise<ReadonlySet<string>> {
    const DELEGATED_KINDS: readonly AccessEntityKind[] = [
      'roadmap',
      'employeeBoard',
      'comparison',
    ];

    const wanted = new Map<AccessEntityKind, string[]>();
    for (const row of rows) {
      const kind = row.shareKind as AccessEntityKind | null;
      if (!kind || !row.shareEntityId) continue;
      if (!DELEGATED_KINDS.includes(kind)) continue;
      wanted.set(kind, [...(wanted.get(kind) ?? []), row.shareEntityId]);
    }
    if (wanted.size === 0) return new Set();

    const reachable = new Set<string>();
    for (const [kind, entityIds] of wanted) {
      if (orgRole === 'ADMIN') {
        for (const id of entityIds) reachable.add(shareKey(kind, id));
        continue;
      }
      const descriptor = ACCESS_ENTITIES[kind];
      if (!descriptor) continue;
      const delegate = this.prisma[descriptor.delegate] as unknown as {
        findMany(args: unknown): Promise<Array<Record<string, unknown>>>;
      };
      const grants = await delegate.findMany({
        where: { [descriptor.entityIdField]: { in: entityIds }, userId },
        select: { [descriptor.entityIdField]: true },
      });
      for (const grant of grants) {
        const id = grant[descriptor.entityIdField];
        if (typeof id === 'string') reachable.add(shareKey(kind, id));
      }
    }
    return reachable;
  }

  /**
   * Maps one row to a DTO, or `null` when the caller may no longer see its
   * subject. A row whose subject resolves to no branch is also dropped — a
   * silently-skipped row beats a half-rendered one.
   */
  private resolve(
    row: {
      id: string;
      kind: NotificationKindValue;
      readAt: Date | null;
      createdAt: Date;
      payload: unknown;
      shareKind: string | null;
      shareEntityId: string | null;
      actor: { name: string | null } | null;
      _count: { members: number };
      projectComment: {
        id: string;
        project: { id: string; name: string; boardId: string | null; board: { name: string } | null };
      } | null;
      orgEmployeeComment: { employee: { name: string; orgTreeId: string } } | null;
      project: {
        id: string;
        name: string;
        boardId: string | null;
        board: { name: string } | null;
      } | null;
    },
    okBoards: ReadonlySet<string>,
    okTrees: ReadonlySet<string>,
    okShares: ReadonlySet<string>,
  ): NotificationDto | null {
    const base = {
      id: row.id,
      kind: row.kind,
      // Null rather than a placeholder string: the UI decides how to word an
      // absent actor, and the schema documents that it may be absent.
      actorName: row.actor?.name ?? null,
      payload: asPayload(row.payload),
      // Only a DIGEST row has members. Reported so the summary can say how many
      // events it folded in without the panel counting them itself.
      digestCount: row.kind === 'DIGEST' ? row._count.members : null,
      boardName: null as string | null,
      readAt: row.readAt,
      createdAt: row.createdAt,
    };

    if (row.projectComment) {
      const { id: commentId, project } = row.projectComment;
      // No board means no way to ask whether the caller may see this.
      if (!project.boardId || !okBoards.has(project.boardId)) return null;
      return {
        ...base,
        subjectLabel: project.name,
        boardName: project.board?.name ?? null,
        href: buildHref({
          kind: 'projectComment',
          boardId: project.boardId,
          projectId: project.id,
          commentId,
        }),
      };
    }

    if (row.project) {
      const project = row.project;
      if (!project.boardId || !okBoards.has(project.boardId)) return null;
      return {
        ...base,
        subjectLabel: project.name,
        boardName: project.board?.name ?? null,
        href: buildHref({
          kind: 'project',
          boardId: project.boardId,
          projectId: project.id,
        }),
      };
    }

    if (row.orgEmployeeComment) {
      const { name, orgTreeId } = row.orgEmployeeComment.employee;
      if (!okTrees.has(orgTreeId)) return null;
      return {
        ...base,
        subjectLabel: name,
        href: buildHref({ kind: 'orgEmployeeComment', orgTreeId }),
      };
    }

    if (row.shareKind && row.shareEntityId) {
      const kind = row.shareKind as AccessEntityKind;
      const entityId = row.shareEntityId;
      const admitted =
        kind === 'board'
          ? okBoards.has(entityId)
          : kind === 'orgTree'
            ? okTrees.has(entityId)
            : okShares.has(shareKey(kind, entityId));
      // A deleted entity resolves to nothing, and so does a revoked grant — the
      // same mechanism, which is why the pair needs no foreign key.
      if (!admitted) return null;
      return {
        ...base,
        subjectLabel: SHARE_LABELS[kind],
        href: buildHref({ kind: 'share', shareKind: kind, entityId }),
      };
    }

    // No subject at all. Legal for exactly two kinds: a released DIGEST summary
    // and a workspace invite. Anything else with no subject is a bug, and
    // dropping it is safer than rendering a row that points nowhere.
    if (row.kind === 'DIGEST' || row.kind === 'ORG_MEMBER_INVITED') {
      return {
        ...base,
        subjectLabel: row.kind === 'DIGEST' ? 'your notifications' : 'this workspace',
        href: buildHref({ kind: 'none' }),
      };
    }

    return null;
  }

  /** Cheap and deliberately UNFILTERED — see the design's §5 note on divergence. */
  async unreadCount(userId: string, organizationId: string): Promise<number> {
    return this.prisma.notification.count({
      // `digestPending` is excluded here as well as in `list`. The count staying
      // unfiltered by ACCESS is a deliberate divergence (the badge is a hint, the
      // list is the truth) — but a pending row is not hidden by access, it is not
      // delivered yet, so counting it would badge something the panel cannot show.
      where: { userId, organizationId, readAt: null, digestPending: false },
    });
  }

  /**
   * `false` rather than a throw when the row is not the caller's: the route maps
   * it to 404, which makes another user's id indistinguishable from a
   * non-existent one.
   */
  async markRead(id: string, userId: string, organizationId: string): Promise<boolean> {
    const { count } = await this.prisma.notification.updateMany({
      where: { id, userId, organizationId, readAt: null },
      data: { readAt: new Date() },
    });
    if (count > 0) return true;
    // Already-read is success, not "not yours" — otherwise a double click on the
    // same row would 404 the second time.
    const existing = await this.prisma.notification.count({
      where: { id, userId, organizationId },
    });
    return existing > 0;
  }

  async markAllRead(userId: string, organizationId: string): Promise<number> {
    const { count } = await this.prisma.notification.updateMany({
      where: { userId, organizationId, readAt: null },
      data: { readAt: new Date() },
    });
    return count;
  }
}

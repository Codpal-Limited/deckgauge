import type { PrismaClient } from '@deckgauge/db';
import type { OrgRoleValue } from '@deckgauge/shared';
import { effectiveBoardRole } from '../authz/policy.js';

export interface ComparisonSummary {
  id: string;
  name: string;
  memberCount: number;
}

/** The caller's standing in their organization, or `null` pre-bootstrap. */
export type CallerMembership = { organizationId: string; role: OrgRoleValue } | null;

const SUMMARY_SELECT = {
  id: true,
  name: true,
  _count: { select: { members: true } },
} as const;

/**
 * CRUD for standalone Comparison entities.
 *
 * Comparisons used to be creator-only: every method here carried
 * `where: { createdBy: userId }`, and that clause WAS the authorization. As of
 * design D15 they have a real ACL (`ComparisonAccess`) and `createdBy` is
 * provenance — so the single-row methods below carry no access predicate at all.
 * The route's `comparison(role)` policy authorized the caller before the handler
 * ran; re-checking here with a *different* rule is how two authorization axes
 * drift apart, which is the whole failure §1 catalogues.
 *
 * `listForUser` is the exception, and not an exception to that principle: no
 * declarative policy can gate it, because the set to return IS the answer.
 */
export class ComparisonService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * The comparisons this caller may see.
   *
   * An org ADMIN sees every comparison in their organization with no grant —
   * the ceiling's implicit-owner half, applied to a list rather than a row. An
   * org VIEWER needs no special case: the ceiling caps them at VIEWER, and
   * VIEWER is enough to appear in a list.
   */
  async listForUser(userId: string, membership: CallerMembership): Promise<ComparisonSummary[]> {
    // Fails closed on a missing userId for the same reason `accessibleBoardIds`
    // does: Prisma treats `undefined` in a `where` as "no filter on this
    // column", so a caller reaching here without one must get nothing rather
    // than everyone's comparisons.
    if (!userId) return [];

    const where =
      membership === null
        ? { access: { some: { userId } } }
        : membership.role === 'ADMIN'
          ? { organizationId: membership.organizationId }
          : { organizationId: membership.organizationId, access: { some: { userId } } };

    const rows = await this.prisma.comparison.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      select: SUMMARY_SELECT,
    });
    return rows.map((r) => ({ id: r.id, name: r.name, memberCount: r._count.members }));
  }

  /**
   * No access predicate: the route's policy decided. `null` still means "no
   * such comparison", which the route turns into a 404.
   */
  async getById(id: string): Promise<ComparisonSummary | null> {
    const row = await this.prisma.comparison.findUnique({ where: { id }, select: SUMMARY_SELECT });
    return row ? { id: row.id, name: row.name, memberCount: row._count.members } : null;
  }

  /**
   * Creates the comparison AND its creator's OWNER grant, in one transaction.
   *
   * Without the grant the next comparison anyone creates would be immediately
   * unreachable — the backfill covers history, not the future. Doing both in a
   * transaction is what stops a half-created comparison existing with no owner,
   * which is the state the last-owner invariants exist to prevent.
   */
  async create(
    organizationId: string,
    userId: string,
    name: string,
  ): Promise<ComparisonSummary> {
    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.comparison.create({
        data: { organizationId, name, createdBy: userId },
        select: SUMMARY_SELECT,
      });
      await tx.comparisonAccess.create({
        data: { comparisonId: created.id, userId, role: 'OWNER' },
      });
      return created;
    });
    return { id: row.id, name: row.name, memberCount: row._count.members };
  }

  /** `false` when no such comparison — the route 404s. */
  async rename(id: string, name: string): Promise<boolean> {
    const res = await this.prisma.comparison.updateMany({ where: { id }, data: { name } });
    return res.count > 0;
  }

  async delete(id: string): Promise<boolean> {
    const res = await this.prisma.comparison.deleteMany({ where: { id } });
    return res.count > 0;
  }

  /** Does this comparison exist? The member routes 404 on `false`. */
  async exists(id: string): Promise<boolean> {
    const row = await this.prisma.comparison.findUnique({ where: { id }, select: { id: true } });
    return row !== null;
  }

  /**
   * The caller's effective role, for `my-role` and for a handler that needs to
   * branch on it. Mirrors the `comparison` policy branch, including the ceiling.
   */
  async roleFor(
    id: string,
    userId: string,
    membership: CallerMembership,
  ): Promise<'OWNER' | 'EDITOR' | 'VIEWER' | null> {
    const grant = await this.prisma.comparisonAccess.findUnique({
      where: { comparisonId_userId: { comparisonId: id, userId } },
      select: { role: true },
    });
    if (!membership) return grant?.role ?? null;
    return effectiveBoardRole(membership.role, grant?.role ?? null);
  }
}

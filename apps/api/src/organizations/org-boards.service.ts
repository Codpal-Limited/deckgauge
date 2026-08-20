import type { PrismaClient } from '@deckgauge/db';
import type { AccessEntry, OrgBoardDto } from '@deckgauge/shared';

/**
 * The admin All-boards read (tenancy spec §5.4).
 *
 * Deliberately separate from `BoardService`, which is grant-scoped by design:
 * `BoardService.list(userId)` answers "which boards may this person see?" and
 * must keep answering exactly that (spec §5.4 — an admin's sidebar does not
 * become every board in the company). This service answers the different
 * question "which boards does this organization own?", and every method takes
 * `organizationId` as its first parameter so a caller cannot forget the tenant.
 *
 * Read-only on purpose. The table's writes ride the existing board routes, which
 * an org ADMIN already reaches through the role ceiling — see the plan's D-1.
 */
export class OrgBoardsService {
  constructor(private readonly prisma: PrismaClient) {}

  async list(organizationId: string): Promise<OrgBoardDto[]> {
    const boards = await this.prisma.board.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        name: true,
        description: true,
        kind: true,
        createdAt: true,
        _count: { select: { projects: true } },
        accessEntries: {
          orderBy: { createdAt: 'asc' },
          select: {
            userId: true,
            role: true,
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                avatarUrl: true,
                // Scoped to THIS organization: a user may hold memberships
                // elsewhere once the multi-org cap lifts, and the ceiling the
                // share dialog enforces is the one from the board's own tenant.
                orgMemberships: {
                  where: { organizationId, status: 'ACTIVE' },
                  select: { role: true },
                  take: 1,
                },
              },
            },
          },
        },
      },
    });

    return boards.map((board) => ({
      id: board.id,
      name: board.name,
      description: board.description,
      kind: board.kind,
      createdAt: board.createdAt.toISOString(),
      projectCount: board._count.projects,
      access: board.accessEntries.map(
        (entry): AccessEntry => ({
          userId: entry.userId,
          role: entry.role,
          // Null rather than a guess when the grantee has no ACTIVE membership
          // here — a suspended or removed member still has a grant row, and
          // reporting a role they no longer hold would let the dialog offer a
          // promotion the API then refuses.
          orgRole: entry.user.orgMemberships[0]?.role ?? null,
          user: {
            id: entry.user.id,
            name: entry.user.name,
            email: entry.user.email,
            avatarUrl: entry.user.avatarUrl,
          },
        }),
      ),
    }));
  }
}

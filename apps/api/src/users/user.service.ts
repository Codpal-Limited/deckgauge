import type { PrismaClient, User } from '@deckgauge/db';
import type { OrgPerson } from '@deckgauge/shared';

export interface UpsertInput {
  keycloakId: string;
  email: string | undefined;
  name: string | undefined;
  firstName?: string;
  lastName?: string;
}

export class UserService {
  constructor(private readonly prisma: PrismaClient) {}

  async upsertFromKeycloak(input: UpsertInput): Promise<User> {
    const email = input.email ?? `${input.keycloakId}@keycloak.local`;
    const firstName = input.firstName?.trim() || null;
    const lastName = input.lastName?.trim() || null;
    // Prefer the explicit `name` claim; fall back to the parts. Without the
    // fallback a realm with registrationEmailAsUsername displays everyone as
    // their email address, because preferred_username IS the email.
    const derivedName = [firstName, lastName].filter(Boolean).join(' ');
    const name = input.name?.trim() || derivedName || 'Unknown';

    // Names are written only when the token carried them: a token that omits
    // them must not blank out what a previous login stored.
    const names = {
      ...(firstName ? { firstName } : {}),
      ...(lastName ? { lastName } : {}),
    };

    return this.prisma.user.upsert({
      where: { keycloakId: input.keycloakId },
      create: { keycloakId: input.keycloakId, email, name, ...names },
      update: { email, name, ...names },
    });
  }

  /**
   * Grant the database admin flag to this user IF they are the only user on
   * the instance — i.e. a genuinely fresh install, where the first person to
   * authenticate is the installer.
   *
   * Deliberately does NOT fire when other users already exist. A rule like
   * "grant admin when no admin exists" would hand admin to whichever employee
   * logged in first after an upgrade. Existing installs use the explicit
   * `bootstrap:admin` CLI instead.
   *
   * One conditional statement rather than count-then-write, so two simultaneous
   * first authentications cannot both win: the second matches zero rows.
   *
   * Runs on every authenticated request, so the "sole row" check is a
   * `NOT EXISTS` existence probe rather than `count(*)`: `count(*)` always
   * scans every row in the table to produce an exact count, while
   * `NOT EXISTS (... WHERE id <> userId)` can stop as soon as it finds one
   * other row — the common case on any instance with more than a handful of
   * users. The sole-row guarantee is unchanged: this only grants when no row
   * other than `userId` exists, identical to the original `count(*) = 1`.
   *
   * @returns true when this call granted admin; false otherwise.
   */
  async bootstrapFirstAdmin(userId: string): Promise<boolean> {
    const affected = await this.prisma.$executeRaw`
      UPDATE users
         SET is_admin = true
       WHERE id = ${userId}
         AND is_admin = false
         AND NOT EXISTS (SELECT 1 FROM users other WHERE other.id <> ${userId})
    `;
    return affected > 0;
  }

  /** Users holding the database admin flag. Does not see Keycloak realm roles. */
  async countAdmins(): Promise<number> {
    return this.prisma.user.count({ where: { isAdmin: true } });
  }

  /**
   * ACTIVE members of ONE organization, for the sharing people picker.
   *
   * `organizationId` is not optional and not decoration: the previous version
   * searched every User row in the deployment, so a board owner could grant
   * access to a user in another organization (design §1.3). The route's
   * `orgRole('VIEWER')` policy guarantees a membership, so there is no
   * null-organization case to fall back to here.
   *
   * `userId: { not: null }` excludes PENDING invites: no bound user means
   * nothing that can hold an access row, so offering them would produce a
   * grant that cannot be created.
   */
  /**
   * ACTIVE members of one organization, optionally narrowed to those who can
   * actually reach a given board.
   *
   * `boardId` is what makes the mention picker honour R5.8 ("users WITH BOARD
   * ACCESS can be @mentioned") — without it the picker offers colleagues who
   * would receive a notification pointing at a 403. It is OPTIONAL because the
   * employee-comment editor has no board to pass, and other callers must not
   * break; the producer applies the same intersection server-side regardless, so
   * omitting it is a UX wart rather than a hole.
   */
  async search(
    query: string,
    organizationId: string,
    boardId?: string,
  ): Promise<OrgPerson[]> {
    const memberships = await this.prisma.orgMembership.findMany({
      where: {
        organizationId,
        status: 'ACTIVE',
        userId: { not: null },
        ...(query
          ? {
              user: {
                OR: [
                  { name: { contains: query, mode: 'insensitive' as const } },
                  { email: { contains: query, mode: 'insensitive' as const } },
                ],
              },
            }
          : {}),
      },
      select: {
        role: true,
        user: { select: { id: true, name: true, email: true, avatarUrl: true } },
      },
      take: 20,
      orderBy: { user: { name: 'asc' } },
    });

    const people = memberships.flatMap((m) =>
      m.user ? [{ ...m.user, orgRole: m.role as OrgPerson['orgRole'] }] : [],
    );
    if (!boardId) return people;

    // Starting from org members, so this collapses to one predicate per person:
    // they hold a grant on this board, OR their org role is ADMIN. The admin half
    // is the floor rule `effectiveBoardRole` applies everywhere else — dropping it
    // would hide your own org admin from the picker while the producer would
    // happily notify them.
    //
    // The board is read THROUGH the organization, so naming a board in another
    // tenant narrows to nobody instead of leaking that tenant's grants.
    const board = await this.prisma.board.findFirst({
      where: { id: boardId, organizationId },
      // `accessEntries`, not `access`: Board and EmployeeBoard spell the same
      // relation differently.
      select: { accessEntries: { select: { userId: true } } },
    });
    if (!board) return [];
    const granted = new Set(board.accessEntries.map((a) => a.userId));
    return people.filter((p) => p.orgRole === 'ADMIN' || granted.has(p.id));
  }
}

import type { PrismaClient, User } from '@deckgauge/db';
import type { OrgPerson } from '@deckgauge/shared';

export interface UpsertInput {
  keycloakId: string;
  email: string | undefined;
  name: string | undefined;
}

export class UserService {
  constructor(private readonly prisma: PrismaClient) {}

  async upsertFromKeycloak(input: UpsertInput): Promise<User> {
    const email = input.email ?? `${input.keycloakId}@keycloak.local`;
    const name = input.name ?? 'Unknown';
    return this.prisma.user.upsert({
      where: { keycloakId: input.keycloakId },
      create: { keycloakId: input.keycloakId, email, name },
      update: { email, name },
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
  async search(query: string, organizationId: string): Promise<OrgPerson[]> {
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

    return memberships.flatMap((m) =>
      m.user ? [{ ...m.user, orgRole: m.role as OrgPerson['orgRole'] }] : [],
    );
  }
}

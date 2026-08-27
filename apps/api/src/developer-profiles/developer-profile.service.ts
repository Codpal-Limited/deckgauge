import type { PrismaClient } from '@deckgauge/db';
import type { DeveloperProvider, DeveloperProfileDto } from '@deckgauge/shared';
import { TargetNotInOrganizationError } from '../access/last-owner.error.js';

export interface DeveloperProfileUpsert {
  organizationId: string;
  provider: DeveloperProvider;
  login: string;
  displayName: string | null;
  avatarUrl: string | null;
  email: string | null;
}

/**
 * Every method takes `organizationId`, and takes it as a REQUIRED parameter so
 * a caller who forgets the boundary fails to compile — the same device as
 * `PageStateDeps.organizationId` and the three promote services' `instanceId`.
 *
 * `DeveloperProfile` used to be described here as "deliberately untenanted
 * (§4.2 class C)". That classification is true of a LOGIN and false of this
 * ROW, which is a per-tenant assertion about one: which of MY users it is, what
 * MY sync saw, what email MY provider returned. The model now carries
 * `organizationId` and is unique per `(organizationId, provider, login)`, so
 * the predicate that could not be written before is the compound key below.
 */
export class DeveloperProfileService {
  constructor(private readonly prisma: PrismaClient) {}

  async upsertOnSync(input: DeveloperProfileUpsert): Promise<{ id: string }> {
    return this.prisma.developerProfile.upsert({
      // The tenant is part of identity. On the old global `(provider, login)`
      // key two organizations syncing the same login — one contractor, or any
      // common public login — resolved to ONE row, and whichever synced last
      // owned its display name and email.
      where: {
        organizationId_provider_login: {
          organizationId: input.organizationId,
          provider: input.provider,
          login: input.login,
        },
      },
      create: input,
      update: { displayName: input.displayName, avatarUrl: input.avatarUrl, email: input.email },
    });
  }

  async list(organizationId: string): Promise<DeveloperProfileDto[]> {
    const rows = await this.prisma.developerProfile.findMany({
      where: { organizationId },
      orderBy: { login: 'asc' },
    });
    return rows.map(toDto);
  }

  async searchByLoginOrName(q: string, organizationId: string): Promise<DeveloperProfileDto[]> {
    const rows = await this.prisma.developerProfile.findMany({
      where: {
        organizationId,
        OR: [
          { login: { contains: q, mode: 'insensitive' } },
          { displayName: { contains: q, mode: 'insensitive' } },
        ],
      },
      orderBy: { login: 'asc' },
      take: 20,
    });
    return rows.map(toDto);
  }

  /**
   * `findUnique` on the OLD key was itself a cross-tenant read: one row per
   * `(provider, login)` deployment-wide means every tenant asking about a shared
   * login got back whichever tenant's PII won the last upsert.
   */
  async findByLogin(
    provider: DeveloperProvider,
    login: string,
    organizationId: string,
  ): Promise<DeveloperProfileDto | null> {
    const r = await this.prisma.developerProfile.findUnique({
      where: { organizationId_provider_login: { organizationId, provider, login } },
    });
    return r ? toDto(r) : null;
  }

  /**
   * Binds a developer profile to a local user, or clears the binding.
   *
   * `organizationId` bounds BOTH halves, and they are separate checks:
   *
   * 1. the PROFILE — `updateMany`'s `organizationId` predicate. Without it an
   *    `ORG_ADMIN` of one tenant could rebind, or blank, any tenant's mapping.
   *    The unlink path is the sharper case: a null target skips the membership
   *    check entirely (there is nothing to verify), so before this predicate it
   *    was a wholly unguarded cross-tenant write;
   * 2. the VALUE written — a user id the caller's own organization actually
   *    holds. The body supplies that id and nothing else consults it, so an
   *    `ORG_ADMIN` gate alone still admits pointing a profile at a stranger.
   *
   * `updateMany` rather than `update`: a missing profile is a 404, and `update`
   * throws P2025 for it, which surfaces as a 500 unless every caller classifies
   * that code. The count carries the same fact with no error path. Returns false
   * when no such profile exists IN THIS ORGANIZATION — which is the 404 a
   * cross-tenant read must answer (§6), and deliberately indistinguishable from
   * a profile that does not exist at all.
   */
  async linkToUser(id: string, userId: string | null, organizationId: string): Promise<boolean> {
    if (userId) {
      const membership = await this.prisma.orgMembership.findFirst({
        where: { organizationId, userId, status: 'ACTIVE' },
        select: { id: true },
      });
      // PENDING is excluded on purpose and not as an accident of reusing
      // `status: 'ACTIVE'`: an invite has no bound user yet, so binding a
      // developer to it would name a row that cannot act.
      if (!membership) throw new TargetNotInOrganizationError();
    }
    const { count } = await this.prisma.developerProfile.updateMany({
      where: { id, organizationId },
      data: { userId },
    });
    return count > 0;
  }
}

interface ProfileRow {
  id: string;
  provider: string;
  login: string;
  displayName: string | null;
  avatarUrl: string | null;
  email: string | null;
  userId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function toDto(r: ProfileRow): DeveloperProfileDto {
  return {
    id: r.id,
    provider: r.provider as DeveloperProvider,
    login: r.login,
    displayName: r.displayName,
    avatarUrl: r.avatarUrl,
    email: r.email,
    userId: r.userId,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

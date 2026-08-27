import type { ChStatementExecutor, PrismaClient, Organization } from '@deckgauge/db';
import { provisionOrganizationAnalytics } from '@deckgauge/db';
import { BootstrapOrganizationSchema, type BootstrapOrganizationInput } from '@deckgauge/shared';
import type { FeatureFlag } from '../enterprise-contract.js';

/** Thrown when a deployment already has an organization and multi-org is off. */
export class OrganizationExistsError extends Error {
  constructor() {
    super('An organization already exists on this deployment');
    this.name = 'OrganizationExistsError';
  }
}

/**
 * Whether this deployment may hold more than one organization.
 *
 * TWO independent conditions, and neither alone is sufficient:
 *
 * - the LICENCE must carry `multi_org`. Multi-tenancy is an enterprise
 *   entitlement; the open-source edition is one organization per installation.
 *   Before this check the environment variable was the entire gate, so an
 *   open-source install could hold as many organizations as it liked.
 * - the OPERATOR must still set `DECKGAUGE_MULTI_ORG`. Without that half, renewing
 *   into a tier that happens to include `multi_org` would silently convert a
 *   single-tenant deployment into a multi-tenant one, with no action by whoever
 *   runs it and no reason for them to expect it.
 *
 * Community edition therefore answers false however the environment is set, which
 * is also what an api image built without `packages/enterprise` resolves to — the
 * safe direction for a mis-built image to fail in.
 */
function multiOrgEnabled(features: readonly FeatureFlag[]): boolean {
  return process.env.DECKGAUGE_MULTI_ORG === 'true' && features.includes('multi_org');
}

export interface OrganizationServiceDeps {
  prisma: PrismaClient;
  /**
   * Runs one ClickHouse statement. Injected, never imported: `clickhouse.ts`
   * builds its client at import time with a hard-coded fallback URL of
   * localhost:8123 — the STAGING server holding real data — so a test that
   * constructed the real client would provision against it. Omit it and
   * analytics provisioning is reported as not done rather than attempted.
   */
  chExec?: ChStatementExecutor;
  /**
   * The features this deployment's licence currently entitles it to.
   *
   * A getter rather than a value because the licence is resolved asynchronously at
   * boot; the FEATURES rather than the whole `LicenseStatus` because that is all
   * this service needs, and because the module derives the effective set itself
   * (`enabledFeatures`) — an expired licence yields none even though its status
   * still lists them.
   *
   * Injected, never imported, for the same reason as `chExec`: a test must be able
   * to state an entitlement with no module on disk. Defaults to NONE, so an absent
   * licence refuses the paid feature.
   */
  entitledFeatures?: () => readonly FeatureFlag[];
}

/**
 * The outcome of bootstrap: the organization, plus whether its ClickHouse
 * identity was provisioned.
 *
 * Two fields rather than one because the second is explicitly allowed to be
 * false on a successful bootstrap — see the comment on bootstrap().
 */
export interface BootstrapResult {
  organization: Organization;
  analyticsProvisioned: boolean;
  /** Why provisioning did not happen, when it did not. For logs and diagnostics. */
  analyticsError?: string;
}

export class OrganizationService {
  private readonly prisma: PrismaClient;
  private readonly chExec?: ChStatementExecutor;
  private readonly entitledFeatures: () => readonly FeatureFlag[];

  constructor(deps: OrganizationServiceDeps) {
    this.prisma = deps.prisma;
    this.entitledFeatures = deps.entitledFeatures ?? (() => []);
    this.chExec = deps.chExec;
  }

  async count(): Promise<number> {
    return this.prisma.organization.count();
  }

  async getById(id: string): Promise<Organization | null> {
    return this.prisma.organization.findUnique({ where: { id } });
  }

  /**
   * The deployment's organization, or null. Unscoped by design — it answers
   * "does this deployment have a tenant at all", which is not a tenant-scoped
   * question. Ordered so the answer is stable if the one-org cap is ever lifted.
   */
  async getFirst(): Promise<Organization | null> {
    return this.prisma.organization.findFirst({ orderBy: { createdAt: 'asc' } });
  }

  /**
   * Makes the caller the deployment's first ACTIVE ADMIN, in one transaction.
   * Three outcomes (spec §5.2):
   *
   *   - zero organizations              → create one, enrol the caller
   *   - an organization with no ACTIVE ADMIN → adopt it, enrol the caller
   *   - an organization with a living ADMIN  → OrganizationExistsError
   *
   * The adopt branch closes a real lockout: §7 step 3 seeds an organization when
   * tenant roots hold rows, but if `users` was empty nobody was enrolled, and
   * that state answers 403 to every login and 409 to bootstrap. Adoption grants
   * nothing creation does not — both are gated on the same Keycloak realm admin
   * role — but it must never attach to an organization that still has a living
   * admin, which would be a takeover.
   *
   * The one-org cap lives here rather than in a database constraint so lifting it
   * needs no migration (spec D5).
   *
   * Once the Postgres transaction commits, the organization gets its ClickHouse
   * role and row policies. That happens OUTSIDE the transaction and its failure
   * is reported, not thrown: a brand-new organization has no synced analytics
   * rows yet, so there is nothing to isolate, and refusing the very first screen
   * of a fresh install because the analytics server is down would be wrong.
   * `analyticsProvisioned: false` is the signal, and provisionAnalytics() is the
   * repair.
   */
  async bootstrap(input: BootstrapOrganizationInput, userId: string): Promise<BootstrapResult> {
    const validated = BootstrapOrganizationSchema.parse(input);

    const organization = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user) throw new Error(`Bootstrap user ${userId} not found`);

      // Two separate questions, deliberately not one flag:
      //   1. Does the one-org cap apply?         — only in single-org mode.
      //   2. Is there an organization to adopt?  — only meaningful when exactly
      //      one exists, i.e. also only in single-org mode.
      //
      // In multi-org mode bootstrap means "create MY organization": there is no
      // single "the" organization, and picking one by createdAt would enrol the
      // caller as ADMIN of an arbitrary tenant.
      //
      // But an admin-less organization must still be recoverable there, so the
      // caller may NAME one — and the input already names it: the slug. Adoption
      // is subject to the identical living-admins gate below, so naming an
      // organization you have no relationship to gains nothing; if it has an
      // admin you get the same 409 you would have got from the unique
      // constraint. A slug that names nothing falls through to create, which is
      // the ordinary case and must stay unchanged.
      const singleOrgMode = !multiOrgEnabled(this.entitledFeatures());
      const adoptable = singleOrgMode
        ? await tx.organization.findFirst({ orderBy: { createdAt: 'asc' } })
        : await tx.organization.findUnique({ where: { slug: validated.slug } });

      if (adoptable) {
        // Must agree with MembershipService.assertNotLastAdmin's definition of
        // "living admin" (role ADMIN, status ACTIVE, userId bound) — otherwise
        // an ACTIVE ADMIN row with no User bound to it would count as cover
        // there (refusing every guarded mutation) while counting as adoption-
        // blocking cover here (refusing bootstrap with 409), leaving the
        // organization unrecoverable by either path.
        const livingAdmins = await tx.orgMembership.count({
          where: {
            organizationId: adoptable.id,
            role: 'ADMIN',
            status: 'ACTIVE',
            userId: { not: null },
          },
        });
        if (livingAdmins > 0) throw new OrganizationExistsError();
      }

      const organization =
        adoptable ??
        (await tx.organization.create({
          data: { name: validated.name, slug: validated.slug },
        }));

      await tx.orgMembership.upsert({
        where: {
          organizationId_email: {
            organizationId: organization.id,
            email: user.email.toLowerCase(),
          },
        },
        create: {
          organizationId: organization.id,
          email: user.email.toLowerCase(),
          userId: user.id,
          role: 'ADMIN',
          status: 'ACTIVE',
          activatedAt: new Date(),
        },
        update: {
          userId: user.id,
          role: 'ADMIN',
          status: 'ACTIVE',
          activatedAt: new Date(),
        },
      });

      return organization;
    });

    const provisioning = await this.provisionAnalytics(organization.id);
    return { organization, ...provisioning };
  }

  /**
   * Gives one organization its ClickHouse identity, and never throws.
   *
   * Also the re-provisioning entry point for organizations that already exist:
   * staging's `Deckgauge` organization predates this code and never passes
   * through bootstrap(), so without this it would hold no role and no policies —
   * and with the catch-all deny in place that means its users read nothing at
   * all. Safe to call repeatedly; the DDL converges.
   */
  async provisionAnalytics(
    organizationId: string,
  ): Promise<{ analyticsProvisioned: boolean; analyticsError?: string }> {
    if (!this.chExec) {
      return {
        analyticsProvisioned: false,
        analyticsError: 'no ClickHouse executor is configured for this service',
      };
    }
    try {
      await provisionOrganizationAnalytics(this.chExec, organizationId);
      return { analyticsProvisioned: true };
    } catch (error) {
      return {
        analyticsProvisioned: false,
        analyticsError: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Re-provisions every organization on the deployment. The rollout calls this
   * once, for the organizations that predate ClickHouse provisioning.
   */
  async provisionAllAnalytics(): Promise<
    Array<{ organizationId: string; analyticsProvisioned: boolean; analyticsError?: string }>
  > {
    const organizations = await this.prisma.organization.findMany({
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    const results = [];
    for (const { id } of organizations) {
      results.push({ organizationId: id, ...(await this.provisionAnalytics(id)) });
    }
    return results;
  }

  async rename(id: string, name: string): Promise<Organization> {
    return this.prisma.organization.update({ where: { id }, data: { name } });
  }
}

/**
 * The `test@test.com` account an open-source install can create in one command.
 *
 * WHY THIS EXISTS AT ALL. The public README has advertised
 * `test@test.com` / `test` since the demo launched, but that account was made by
 * hand on the demo VM and nothing in the repository created it. A clone could
 * not reproduce it for two reasons that compound:
 *
 * - `DemoProvisioningService` — the hook that grants a first-time visitor board
 *   access — lives in `packages/enterprise`, which is NEVER published. On the
 *   community edition it does not load, and a user with no grants lands on
 *   `/no-organization`.
 * - `seedDemo` deliberately refuses to create an organization, and the script
 *   that does (`demo/seed-demo.ts`) is in `demo/`, hard-excluded from the OSS
 *   publish.
 *
 * WHAT THIS DOES NOT DO, and why that is the design. It does not grant
 * BoardAccess, OrgTreeAccess, RoadmapAccess or ComparisonAccess. `seedDemo`
 * already grants its owner OWNER on all four, and `resolveOwner` identifies that
 * owner as the earliest-activated ACTIVE ADMIN membership in the organization.
 * So creating the membership is what makes the grants happen — duplicating them
 * here would be a second definition of the same thing, and would drift.
 *
 * The one grant the seeder does not set is `OrgTreeAccess.canViewSalary`, which
 * defaults false. The demo org chart carries salary data and the schema makes
 * that flag orthogonal to `role` on purpose, so it is set here, for this user
 * only, after the seed.
 *
 * The corollary, and it is a REFUSAL rather than a caveat: if the organization
 * already has an ACTIVE ADMIN activated earlier than this one, `resolveOwner`
 * picks THEM and every grant lands on them instead. This account then exists,
 * signs in, and holds nothing — an empty product behind a ✓. That case is
 * detectable on the seeding path and is reported as a failure; see the check
 * below the seed call.
 */
import type { PrismaClient } from '../generated/prisma/client.js';
import { createPrismaClient } from '../client.js';
import { clickhouse as clickhouseSingleton, type ClickHouseClient } from '../clickhouse.js';
import { isMainModule } from '../esm-main.js';
import { DEFAULT_SEED } from './generate.js';
import { seedDemo } from './seed-demo.js';

export const TEST_ACCOUNT_EMAIL = 'test@test.com';
export const TEST_ACCOUNT_NAME = 'Test User';
export const DEFAULT_ORG_SLUG = 'deckgauge';
export const DEFAULT_ORG_NAME = 'Deckgauge';

export interface TestAccountCliOptions {
  remove: boolean;
  /** Absent only on the removal path, which finds the user by email. */
  keycloakId: string | undefined;
  orgSlug: string;
  orgName: string;
  seed: number;
  skipSeed: boolean;
}

export type ParsedTestAccountArgs =
  | { ok: true; options: TestAccountCliOptions }
  | { ok: false; message: string };

/**
 * Parses this CLI's flags out of an argv slice (no `node`/script path), and
 * REFUSES anything it cannot parse.
 *
 * Deliberately the same shape as `parseSeedDemoArgs` in ./seed-demo.ts — read
 * its doc comment for the reasoning, which is that every silent fallback is "a
 * wrong answer delivered confidently". The consequence is HEAVIER here than for
 * the seeder, because `ensureTestAccount` UPSERTS the organization rather than
 * resolving an existing one: `--org` with no value, or `--org --no-seed`, used
 * to fall back to "deckgauge" — creating a brand-new empty tenant, making
 * test@test.com its ADMIN, and (without --no-seed) seeding a full dataset into
 * it. The installer's typo would be invisible and the product would look right.
 */
export function parseTestAccountArgs(argv: readonly string[]): ParsedTestAccountArgs {
  const valueOf = (name: string): { given: false } | { given: true; value: string | undefined } => {
    const i = argv.indexOf(`--${name}`);
    if (i === -1) return { given: false };
    const next = argv[i + 1];
    // A value that is itself a flag is a MISSING value, not a value: `--org
    // --no-seed` must refuse rather than upsert an organization called
    // "--no-seed".
    return { given: true, value: next === undefined || next.startsWith('--') ? undefined : next };
  };

  const remove = argv.includes('--remove');

  const keycloakArg = valueOf('keycloak-id');
  if (keycloakArg.given && keycloakArg.value === undefined) {
    return {
      ok: false,
      message: '--keycloak-id needs the Keycloak subject id, e.g. --keycloak-id 0f3c…-b21a.',
    };
  }
  if (!remove && !keycloakArg.given) {
    return {
      ok: false,
      message:
        '--keycloak-id is required: the Keycloak subject id a JWT resolves to a local user by.\n' +
        'scripts/test-account.sh reads it back from kcadm and passes it for you.',
    };
  }

  const orgArg = valueOf('org');
  if (orgArg.given && orgArg.value === undefined) {
    return { ok: false, message: '--org needs an organization slug, e.g. --org acme.' };
  }

  const orgNameArg = valueOf('org-name');
  if (orgNameArg.given && orgNameArg.value === undefined) {
    return { ok: false, message: '--org-name needs a display name, e.g. --org-name "Acme Inc".' };
  }

  const seedArg = valueOf('seed');
  if (seedArg.given && seedArg.value === undefined) {
    return { ok: false, message: '--seed needs an integer, e.g. --seed 20260905.' };
  }
  let seed = DEFAULT_SEED;
  if (seedArg.given && seedArg.value !== undefined) {
    const parsed = Number(seedArg.value);
    if (!Number.isInteger(parsed)) {
      return {
        ok: false,
        message: `--seed must be an integer, not "${seedArg.value}". Example: --seed 20260905.`,
      };
    }
    seed = parsed;
  }

  return {
    ok: true,
    options: {
      remove,
      keycloakId: keycloakArg.given ? keycloakArg.value : undefined,
      // `given && value !== undefined` rather than `?? DEFAULT`: the union has no
      // `value` on its not-given arm, and the refusals above have already ruled
      // out given-but-empty.
      orgSlug: orgArg.given && orgArg.value !== undefined ? orgArg.value : DEFAULT_ORG_SLUG,
      orgName:
        orgNameArg.given && orgNameArg.value !== undefined ? orgNameArg.value : DEFAULT_ORG_NAME,
      seed,
      skipSeed: argv.includes('--no-seed'),
    },
  };
}

export interface EnsureOptions {
  /** The Keycloak subject id. A JWT resolves to a local User by THIS, not email. */
  keycloakId: string;
  orgSlug: string;
  orgName: string;
  seed: number;
  /** True on the hosted demo, where the deploy has already seeded. */
  skipSeed: boolean;
}

export type TestAccountResult = { ok: true; message: string } | { ok: false; message: string };

/** The seeder's shape, so a caller can substitute one. See `seeder` below. */
export type SeedDemoFn = typeof seedDemo;

export async function ensureTestAccount(
  prisma: PrismaClient,
  ch: ClickHouseClient,
  opts: EnsureOptions,
  /**
   * The dataset write, defaulted to the real one — a parameter for the same
   * reason `seedDemo` takes `now`: so a test can exercise a decision that is
   * otherwise only observable through a live ClickHouse and a full dataset.
   * The decision in question is WHO the seeder grants ownership to, which is
   * what the refusal below turns on.
   */
  seeder: SeedDemoFn = seedDemo,
): Promise<TestAccountResult> {
  if (!opts.keycloakId) {
    return { ok: false, message: 'No Keycloak subject id given — cannot bind a local user to it.' };
  }

  // Idempotent on the slug, which is @unique. Adopts an existing organization
  // rather than creating a second one whose boards nothing would be granted on.
  const organization = await prisma.organization.upsert({
    where: { slug: opts.orgSlug },
    create: { name: opts.orgName, slug: opts.orgSlug },
    update: {},
  });

  const user = await prisma.user.upsert({
    where: { keycloakId: opts.keycloakId },
    create: { keycloakId: opts.keycloakId, email: TEST_ACCOUNT_EMAIL, name: TEST_ACCOUNT_NAME },
    update: { email: TEST_ACCOUNT_EMAIL, name: TEST_ACCOUNT_NAME },
  });

  // ADMIN and ACTIVE with a bound userId, or resolveOwner refuses with
  // "Organization ... has no active administrator to own the demo boards".
  // ADMIN rather than MEMBER because this is the install's only user and must
  // be able to create as well as read.
  await prisma.orgMembership.upsert({
    where: {
      organizationId_email: { organizationId: organization.id, email: TEST_ACCOUNT_EMAIL },
    },
    create: {
      organizationId: organization.id,
      email: TEST_ACCOUNT_EMAIL,
      userId: user.id,
      role: 'ADMIN',
      status: 'ACTIVE',
      activatedAt: new Date(),
    },
    // NOT `activatedAt` — it means when this member was activated, and
    // `resolveOwner` (./resolve-target.ts) picks the EARLIEST-activated ACTIVE
    // ADMIN. Re-stamping it on every run would move this account to the back of
    // that ordering and hand ownership of the demo boards to a later admin.
    update: { userId: user.id, role: 'ADMIN', status: 'ACTIVE' },
  });

  if (!opts.skipSeed) {
    const seeded = await seeder(prisma, ch, {
      remove: false,
      // Inference, deliberately: an OSS install has exactly one admin, and this
      // account IS it. The demo VM names its owner instead (deploy-demo.sh).
      ownerEmail: undefined,
      org: opts.orgSlug,
      seed: opts.seed,
    });
    if (!seeded.ok) return seeded;
  }

  // After the seed, because the rows it upserts are the ones being amended.
  // Scoped to this user: nobody else's salary visibility changes.
  const salary = await prisma.orgTreeAccess.updateMany({
    where: { userId: user.id, orgTree: { organizationId: organization.id } },
    data: { canViewSalary: true },
  });

  // The seeder always writes exactly one org tree and one OWNER grant on it
  // (write-postgres.ts:432-441), so on the seeding path zero rows for THIS user
  // does not mean "no trees" — it means the grants went to somebody else, and
  // with them the BoardAccess, RoadmapAccess and ComparisonAccess this function
  // deliberately does not duplicate. Reporting ok here would hand the installer
  // a ✓ on an account that signs in to an empty product.
  //
  // Not checked on the --no-seed path: there no seed ran, so no grants were
  // expected, and the demo VM's deploy grants them separately.
  if (!opts.skipSeed && salary.count === 0) {
    return {
      ok: false,
      message:
        `The demo dataset is seeded, but ${TEST_ACCOUNT_EMAIL} was granted nothing in ` +
        `"${organization.slug}" — no boards, org chart, roadmap or comparison. Another ` +
        'ACTIVE ADMIN of that organization was activated earlier, so the seeder made THEM ' +
        'the owner of everything it wrote (resolve-target.ts picks the earliest-activated ' +
        'ACTIVE ADMIN). This account can sign in and will see an empty product.\n' +
        '  Two ways out: remove or suspend that earlier membership and re-run, or use a ' +
        'fresh organization — --org <new-slug> here, DECKGAUGE_ORG_SLUG=<new-slug> for ' +
        'scripts/test-account.sh.',
    };
  }

  return {
    ok: true,
    message:
      `✓ ${TEST_ACCOUNT_EMAIL} is an ADMIN of "${organization.slug}"` +
      (opts.skipSeed ? '' : ', and the demo dataset is seeded') +
      `. Salary visibility set on ${salary.count} org tree(s).`,
  };
}

/**
 * Deletes the test USER, and nothing else.
 *
 * Every grant follows by cascade: BoardAccess, OrgTreeAccess, RoadmapAccess,
 * ComparisonAccess and OrgMembership all declare
 * `user User @relation(..., onDelete: Cascade)`.
 *
 * The organization and the seeded content are deliberately left standing. The
 * demo data has its own `--remove`, and making the removal of a LOGIN also
 * destroy a DATASET is the kind of surprise an installer only discovers
 * afterwards.
 */
export async function removeTestAccount(prisma: PrismaClient): Promise<{ removed: boolean }> {
  const user = await prisma.user.findUnique({ where: { email: TEST_ACCOUNT_EMAIL } });
  if (!user) return { removed: false };
  await prisma.user.delete({ where: { id: user.id } });
  return { removed: true };
}

async function main() {
  const parsed = parseTestAccountArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(`✗ ${parsed.message}`);
    process.exitCode = 1;
    return;
  }
  const options = parsed.options;

  const prisma = createPrismaClient();
  try {
    if (options.remove) {
      const { removed } = await removeTestAccount(prisma);
      console.log(
        removed
          ? `✓ ${TEST_ACCOUNT_EMAIL} removed. Its grants went with it; the seeded data did not.`
          : `Nothing to do — no ${TEST_ACCOUNT_EMAIL} user exists.`,
      );
      return;
    }

    const result = await ensureTestAccount(prisma, clickhouseSingleton, {
      // Non-undefined on this path: the parser refuses a create run without it.
      keycloakId: options.keycloakId ?? '',
      orgSlug: options.orgSlug,
      orgName: options.orgName,
      seed: options.seed,
      skipSeed: options.skipSeed,
    });
    if (result.ok) {
      console.log(result.message);
    } else {
      console.error(`✗ ${result.message}`);
      process.exitCode = 1;
    }
  } finally {
    // BOTH clients, as seed-demo.ts's main() does. Leaving the ClickHouse
    // client open held the process alive past the last line of output — and
    // scripts/test-account.sh runs this MID-INSTALL, so the hang reads as a
    // stuck install rather than as a socket waiting to time out.
    await prisma.$disconnect();
    await clickhouseSingleton.close();
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

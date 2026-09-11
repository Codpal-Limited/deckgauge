/**
 * Which organization and which user the seed attaches to.
 *
 * Pure, and separated from the CLI, because every branch here is a refusal an
 * installer will read at a moment when something is already confusing. A
 * refusal that names the fix is the whole value; that is testable, and a live
 * database is not needed to test it.
 *
 * Split into two functions rather than one `resolveTarget` that tries both
 * resolutions in a single call: the organization query and the membership
 * query are two separate round trips against the database (the second can
 * only be built once the first has named an organization id), and a caller
 * that matched on `message.includes('no active administrator')` to tell
 * "which step failed" apart is matching on PROSE — brittle the moment anyone
 * rewords a message, and silently wrong the moment it does. Two functions,
 * each with its own result type, make that distinction a type rather than a
 * string comparison.
 */
export interface TargetOrg {
  id: string;
  slug: string;
  name: string;
}

export interface TargetMembership {
  userId: string | null;
  /** Lowercased invite key. Only read when an owner is named by email. */
  email: string;
  role: 'ADMIN' | 'MEMBER' | 'VIEWER';
  status: 'PENDING' | 'ACTIVE' | 'SUSPENDED';
  activatedAt: Date | null;
}

export type OrganizationResult =
  | { ok: true; organization: TargetOrg }
  | { ok: false; message: string };

export type OwnerResult = { ok: true; ownerUserId: string } | { ok: false; message: string };

/**
 * Picks the organization to seed into.
 *
 * - No organization at all: refuse, and say to create one — the seeder never
 *   creates one itself.
 * - `requestedSlug` given: it must match exactly, or the refusal names what
 *   does exist rather than falling back to guessing.
 * - No `requestedSlug`, exactly one organization: use it without asking.
 * - No `requestedSlug`, more than one organization: refuse rather than guess,
 *   and list the slugs so the installer knows what to pass to `--org`.
 */
export function resolveOrganization(
  organizations: readonly TargetOrg[],
  requestedSlug: string | undefined,
): OrganizationResult {
  if (organizations.length === 0) {
    return {
      ok: false,
      message:
        'No organization exists yet. Sign in and create your organization first, then re-run ' +
        'this command. (The seeder never creates one: the name is yours to choose.)',
    };
  }

  if (requestedSlug !== undefined) {
    const organization = organizations.find((o) => o.slug === requestedSlug);
    if (organization === undefined) {
      return {
        ok: false,
        message:
          `No organization with slug "${requestedSlug}". Available: ` +
          organizations.map((o) => o.slug).join(', '),
      };
    }
    return { ok: true, organization };
  }

  if (organizations.length === 1) {
    // Non-empty per the length check above, so index 0 is provably present.
    return { ok: true, organization: organizations[0]! };
  }

  return {
    ok: false,
    message:
      'More than one organization exists — name the one to seed with --org <slug>. ' +
      `Available: ${organizations.map((o) => o.slug).join(', ')}`,
  };
}

/**
 * Picks the user the demo boards, roadmap, comparison and org tree are
 * granted OWNER access under.
 *
 * `ownerEmail` NAMES that user, and is the path every automated caller should
 * take: `demo/deploy-demo.sh` has always known who the owner is
 * (`DEMO_SEED_OWNER_EMAIL`), so it can state it instead of leaving it to be
 * re-derived. A named owner that cannot be used is a REFUSAL, never a fall
 * back — see the body.
 *
 * Without it, the owner is the earliest-activated ACTIVE ADMIN of the
 * already-resolved `organization`. That inference is kept for callers with
 * nobody to name — an OSS install has exactly one admin, so it is right there
 * by construction — but it is a guess, and deploy #12 is what the guess cost
 * when two admins existed and one had its `activatedAt` re-stamped.
 *
 * Takes the resolved organization (not just its id) purely so the refusal
 * message can name it — the same reason `resolveOrganization`'s refusals name
 * the slugs it saw.
 */
export function resolveOwner(
  memberships: readonly TargetMembership[],
  organization: TargetOrg,
  // REQUIRED, not optional. `SeedDemoOptions.ownerEmail` is a required key for
  // the same reason: an omitted argument means "guess", and silence meaning
  // guess is the shape of the bug this parameter exists to remove. Callers that
  // genuinely have nobody to name pass `undefined` and say so.
  ownerEmail: string | undefined,
): OwnerResult {
  const admins = memberships
    .filter(
      (m): m is TargetMembership & { userId: string } =>
        m.role === 'ADMIN' && m.status === 'ACTIVE' && m.userId !== null,
    )
    .sort((a, b) => (a.activatedAt?.getTime() ?? 0) - (b.activatedAt?.getTime() ?? 0));

  // A NAMED owner short-circuits the ordering entirely — that is the point.
  // `OrgMembership.email` is stored lowercase (the invite key), and the callers
  // that supply this read it from an operator-set environment variable, so
  // compare lowercased rather than trusting the caller's casing.
  // `!== undefined` ONLY. An empty or whitespace-only value is a caller that
  // meant to name an owner and failed to, which must refuse — treating it as
  // "nobody named" is what let the inference back in. The parser refuses it too;
  // this is the boundary a programmatic caller crosses.
  if (ownerEmail !== undefined) {
    const wanted = ownerEmail.trim().toLowerCase();
    const named = admins.find((m) => m.email.toLowerCase() === wanted);
    if (named !== undefined) return { ok: true, ownerUserId: named.userId };

    // NO fall back to `admins[0]`. Guessing is what this parameter exists to
    // replace, and a caller that named an owner and got a different one would
    // be back in deploy #12: the seed writes under an identity nobody chose,
    // and the failure surfaces later as a primary-key collision rather than
    // here as a refusal. See planning/STATE.md, 2026-09-11.
    const present = memberships.find((m) => m.email.toLowerCase() === wanted);
    // An ADMIN/ACTIVE membership with no bound `userId` gets its own branch: the
    // combined sentence read "is a member but not an active administrator (role
    // ADMIN, status ACTIVE, not yet bound to a user)", whose parenthetical
    // contradicts the clause it follows. This is read mid-incident.
    const why =
      present === undefined
        ? 'is not a member of it'
        : present.role === 'ADMIN' && present.status === 'ACTIVE' && present.userId === null
          ? 'is an administrator of it but has never signed in, so no user record is bound ' +
            'to that membership yet'
          : `is a member but not an active administrator (role ${present.role}, status ` +
            `${present.status})`;
    return {
      ok: false,
      message:
        `The demo owner was named as "${ownerEmail}", but that account ${why} in ` +
        `organization "${organization.slug}". Refusing rather than falling back to another ` +
        'administrator — the owner decides who every seeded board, roadmap and org tree ' +
        'belongs to.\n' +
        '  Fix the account (or correct DEMO_SEED_OWNER_EMAIL) and re-run.',
    };
  }

  if (admins.length === 0) {
    return {
      ok: false,
      message:
        `Organization "${organization.slug}" has no active administrator to own the demo ` +
        'boards. Sign in as an admin once, then re-run this command.',
    };
  }

  // Non-empty per the check above, so index 0 is provably present.
  return { ok: true, ownerUserId: admins[0]!.userId };
}

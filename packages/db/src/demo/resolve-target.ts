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
 * granted OWNER access under: the earliest-activated ACTIVE ADMIN of the
 * already-resolved `organization`.
 *
 * Takes the resolved organization (not just its id) purely so the refusal
 * message can name it — the same reason `resolveOrganization`'s refusals name
 * the slugs it saw.
 */
export function resolveOwner(
  memberships: readonly TargetMembership[],
  organization: TargetOrg,
): OwnerResult {
  const admins = memberships
    .filter(
      (m): m is TargetMembership & { userId: string } =>
        m.role === 'ADMIN' && m.status === 'ACTIVE' && m.userId !== null,
    )
    .sort((a, b) => (a.activatedAt?.getTime() ?? 0) - (b.activatedAt?.getTime() ?? 0));

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

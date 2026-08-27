import type { PrismaClient } from '@deckgauge/db';

/**
 * Best-effort: link unlinked `BoardOwner` labels to a real account on login.
 *
 * `BoardOwner.name` is a free-text label. Until first and last name existed on
 * the account, email was the only thing it could be matched against — and a
 * label is far more often a person's NAME, which is why assignment
 * notifications never had anyone to notify (design §4).
 *
 * Two passes, both EXACT and case-insensitive — never fuzzy, because a wrong
 * link silently redirects someone else's notifications to this account:
 *
 *   - **Email**, deployment-wide. `User.email` is unique, so an email label
 *     cannot match a different person.
 *   - **Display name**, narrowed to boards in the organization this request is
 *     acting in. Names are NOT unique: an unscoped name pass would link one
 *     tenant's "Dana Levi" to another tenant's owner label, and that tenant's
 *     items would then resolve to an account the access check drops — notifying
 *     nobody at all.
 *
 * One raw statement rather than two Prisma calls, because this runs on every
 * authenticated request: `updateMany` accepts scalar filters only, so the
 * organization scope (a join through `boards`) cannot be expressed there.
 * `lower() =` is also stricter than Prisma's `mode: 'insensitive'`, which
 * compiles to ILIKE and would treat `_` and `%` inside an email as wildcards.
 * Both sides are `btrim`ed so a padded label behaves the same here as it does in
 * `resolveOwnerUserId`, which trims before matching — otherwise a label could be
 * resolvable at notification time yet permanently unlinkable at login.
 *
 * @returns how many owner labels this call linked.
 */
export interface LinkBoardOwnersInput {
  userId: string;
  email: string;
  /** `User.name`, when the account has a usable display name. */
  name: string | null;
  /** The organization this request is acting in, or null when there is none. */
  organizationId: string | null;
}

export async function linkBoardOwnersToUser(
  prisma: PrismaClient,
  input: LinkBoardOwnersInput,
): Promise<number> {
  const name = input.name?.trim() || null;
  return prisma.$executeRaw`
    UPDATE board_owners bo
       SET user_id = ${input.userId}
     WHERE bo.user_id IS NULL
       AND (
         lower(btrim(bo.name)) = lower(btrim(${input.email}))
         OR (
           ${name}::text IS NOT NULL
           AND ${input.organizationId}::text IS NOT NULL
           AND lower(btrim(bo.name)) = lower(${name}::text)
           AND EXISTS (
             SELECT 1 FROM boards b
              WHERE b.id = bo.board_id
                AND b.organization_id = ${input.organizationId}::text
           )
         )
       )
  `;
}

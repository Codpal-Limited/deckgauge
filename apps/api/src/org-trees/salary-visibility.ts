import type { PrismaClient } from '@deckgauge/db';

/**
 * Who may see pay — one resolver, called by every salary gate.
 *
 * There are two gates (`GET /org-trees/:id` and `GET /employee-boards/:boardId`),
 * and they used to make the decision independently, both as `req.isAdmin`. Two
 * places deciding the same thing drift, and the drift shows up here as a column
 * that renders on one surface and not the other.
 */

/**
 * Whether being an organization ADMIN is, by itself, enough to see salary.
 *
 * **Ships `true`, deliberately, and this is the decision to revisit.**
 *
 * The obvious reading of "salary visibility as a grant" is that an explicit grant
 * REPLACES the admin path, so being an admin no longer means seeing everyone's
 * pay. That is probably where this ends up. It is not what ships, because the two
 * directions are not equally reversible:
 *
 *   - Additive (`true`) adds a way to give a non-admin exactly this one
 *     capability. Nobody loses anything, and nothing needs announcing.
 *   - Exclusive (`false`) silently REMOVES a payroll-adjacent column from every
 *     admin who relies on it today. Somebody opens a board next week and the
 *     column is gone, with nothing to explain it.
 *
 * Flipping this constant is a one-line change and the exclusive behaviour is
 * already covered by tests (`canViewSalary(..., { adminImplicit: false })`), so
 * the flip is an owner's decision rather than an implementation. Un-hiding data
 * that quietly disappeared, after people have built workarounds, is not.
 */
export const SALARY_ADMIN_IMPLICIT = true;

export interface SalaryVisibilityOptions {
  /** Overrides `SALARY_ADMIN_IMPLICIT`. Tests use it to cover both positions. */
  readonly adminImplicit?: boolean;
}

/**
 * `userId` is null in single-user mode, which bypasses every policy, populates no
 * user and reports `isAdmin` — so that mode keeps working exactly as before. A
 * null user who is NOT an admin sees no salary, which is the fail-closed
 * direction.
 */
export async function canViewSalary(
  prisma: PrismaClient,
  userId: string | null,
  orgTreeId: string,
  isAdmin: boolean,
  opts: SalaryVisibilityOptions = {},
): Promise<boolean> {
  const adminImplicit = opts.adminImplicit ?? SALARY_ADMIN_IMPLICIT;
  if (adminImplicit && isAdmin) return true;
  if (!userId) return false;

  try {
    // The grant is read THROUGH an ACTIVE membership in the tree's own
    // organization. A grant row can outlive the membership that justified it, and
    // an ex-colleague's stale row must not carry pay visibility — the same rule
    // `notifiableOnBoard` applies by iterating memberships rather than grants.
    const tree = await prisma.orgTree.findFirst({
      where: {
        id: orgTreeId,
        organization: { memberships: { some: { userId, status: 'ACTIVE' } } },
      },
      select: {
        access: { where: { userId }, select: { canViewSalary: true } },
      },
    });
    return tree?.access[0]?.canViewSalary === true;
  } catch {
    // Fail closed, the same contract as the policy layer: a malformed id reaches
    // Prisma before any route-level validation and must answer "no" rather than
    // surface as a 500 out of a PII gate.
    return false;
  }
}

/**
 * The same question for an employee board, whose tree is the scope. Resolves the
 * tree and then defers, so the two gates cannot answer differently.
 */
export async function canViewSalaryForBoard(
  prisma: PrismaClient,
  userId: string | null,
  employeeBoardId: string,
  isAdmin: boolean,
  opts: SalaryVisibilityOptions = {},
): Promise<boolean> {
  const adminImplicit = opts.adminImplicit ?? SALARY_ADMIN_IMPLICIT;
  // Checked before the lookup: an admin needs no tree resolution, and this keeps
  // the common path to zero queries.
  if (adminImplicit && isAdmin) return true;
  if (!userId) return false;

  try {
    const board = await prisma.employeeBoard.findUnique({
      where: { id: employeeBoardId },
      select: { orgTreeId: true },
    });
    if (!board) return false;
    return canViewSalary(prisma, userId, board.orgTreeId, isAdmin, opts);
  } catch {
    return false;
  }
}

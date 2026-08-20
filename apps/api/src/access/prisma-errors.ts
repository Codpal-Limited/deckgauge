import { LastOwnerError, RoleExceedsOrgRoleError, TargetNotInOrganizationError } from './last-owner.error.js';

/**
 * The Prisma error classification every access route family shares, and the
 * write-error mapping built on it.
 *
 * Extracted from `board-access.routes.ts` when org trees joined the shared
 * mechanism. Two copies of an error classifier drift, and the drift is silent:
 * a `P2034` classified in one file and not the other turns a 409
 * CONCURRENT_UPDATE into a 500 on exactly one entity, and nothing fails to
 * compile.
 */
function hasCode(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === code;
}

export const isUniqueViolation = (err: unknown) => hasCode(err, 'P2002');
/** Serializable rollback (P2034) and transaction-closed (P2028). */
export const isWriteConflict = (err: unknown) => hasCode(err, 'P2034') || hasCode(err, 'P2028');
/** Foreign-key violation — the referenced row (e.g. the entity itself) does not exist. */
export const isForeignKeyViolation = (err: unknown) => hasCode(err, 'P2003');

interface ReplyLike {
  status: (n: number) => { send: (b: unknown) => unknown };
}

/**
 * The shared mapping for PATCH and DELETE, which cannot hit a unique or
 * foreign-key violation — the row they act on already exists. POST maps its own
 * errors inline because it must also answer ALREADY_HAS_ACCESS and
 * "entity not found", and those two answers are entity-specific nouns.
 *
 * Rethrows anything it does not recognise: an unclassified write error is a
 * 500, not a silently swallowed 409.
 */
export function mapWriteError(err: unknown, reply: ReplyLike) {
  if (err instanceof LastOwnerError) return reply.status(409).send({ error: 'LAST_OWNER' });
  if (err instanceof TargetNotInOrganizationError) {
    return reply.status(404).send({ error: 'User not found' });
  }
  if (err instanceof RoleExceedsOrgRoleError) {
    return reply.status(409).send({ error: 'ROLE_EXCEEDS_ORG_ROLE' });
  }
  if (isWriteConflict(err)) return reply.status(409).send({ error: 'CONCURRENT_UPDATE' });
  throw err;
}

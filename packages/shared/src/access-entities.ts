import type { AccessEntityKind } from './access';

/**
 * What the generic service needs to know about one shareable entity: which
 * Prisma model holds its grants, what the entity's own id column is called, and
 * what Prisma named the composite unique key.
 *
 * This map is the ONLY place a kind's storage shape appears. Phases C and D add
 * `employeeBoard` and `comparison` here plus a policy branch — and nothing else,
 * which is the point of the generic service.
 */
export interface AccessEntityDescriptor {
  /**
   * Prisma delegate name on PrismaClient, e.g. `boardAccess`.
   *
   * All five delegates now exist. Each joined this union WITH its table —
   * naming a delegate before the model exists would not type-check.
   */
  delegate:
    | 'boardAccess'
    | 'orgTreeAccess'
    | 'roadmapAccess'
    | 'employeeBoardAccess'
    | 'comparisonAccess';
  /** The FK column on that model, e.g. `boardId`. */
  entityIdField: string;
  /**
   * Column on the ENTITY that marks it personal, when the kind has one — only
   * `employeeBoard` does (`isPersonal`). When the flag is set on a row, BOTH
   * implicit-owner rules are skipped and the entity's own grant alone decides
   * (org-tree privacy D5).
   *
   * Named rather than boolean so the descriptor stays the single place that knows
   * which column to read, exactly like `accessRelation` — and so a kind that
   * later grows its own differently-named flag needs no new branch here.
   */
  personalFlagField?: string;
  /** Prisma's generated name for `@@unique([entityId, userId])`, e.g. `boardId_userId`. */
  compoundKey: string;

  /**
   * The ENTITY's own Prisma delegate — not its ACL's. Needed to read the entity
   * through the caller's organization, which is what stops a role decision
   * crossing a tenant boundary (tenancy §11 precondition 7).
   */
  entityDelegate: 'board' | 'orgTree' | 'employeeBoard' | 'roadmap' | 'comparison';

  /** What the entity calls its ACL relation. Two spellings exist; both are real. */
  accessRelation: 'access' | 'accessEntries';

  /**
   * The reverse of `accessRelation`: what the ACL model calls its relation back
   * to the entity. Lets a query filter GRANT rows by a property of the entity
   * they point at — which is how offboarding revokes only the grants that belong
   * to the organization being left, in one indexed statement per kind rather
   * than by first listing every entity id in the tenant.
   *
   * Carried explicitly rather than reusing `entityDelegate`, even though all five
   * currently spell it the same way. `accessRelation` above exists precisely
   * because two spellings of the FORWARD relation are both real, and the
   * `ORG_ENTITY_PATH` hop in `auth/policy.ts` carries its FK name for the same
   * reason — a previous version of that file assumed one column name for every
   * hop and silently 403'd an entire model.
   *
   * **What the type does and does not buy you.** The union rejects a MISSPELLED
   * value (`'bord'`), but not a valid-but-wrong one: putting `'board'` on the
   * `orgTree` descriptor typechecks, because the consumer
   * (`apps/api/src/access/revoke-grants.ts`) reaches its Prisma delegate through
   * an `unknown`-typed `deleteMany`, so no relation name is checked against the
   * model it is used on. Such a swap matches no rows and leaves grants behind
   * SILENTLY. What actually catches it is the real-Postgres test
   * "removing a member revokes the grants they held in that organization" in
   * `organizations/membership.service.test.ts`, which asserts a count per kind —
   * so keep that test paired with this map.
   */
  entityRelation: 'board' | 'orgTree' | 'employeeBoard' | 'roadmap' | 'comparison';

  /**
   * How the entity reaches an `organizationId`. `own` means the column is on the
   * entity (tenancy D6 puts it on tenant roots); `viaOrgTree` means it inherits
   * through its parent tree, which is why `EmployeeBoardAccess` carries no
   * tenant column of its own.
   */
  orgScope: 'own' | 'viaOrgTree';

  /**
   * Design D12: an OWNER grant on the parent org tree makes the caller an OWNER
   * of every board in it. Only `employeeBoard` has a parent entity to inherit
   * from, so only it sets this.
   */
  implicitOwnerFromOrgTree?: true;
}

type PartialEntities = Partial<Record<AccessEntityKind, AccessEntityDescriptor>>;

/**
 * All five shareable kinds, each routed by a route family: `board` (phase A),
 * `orgTree` (B), `employeeBoard` (C), `roadmap` and `comparison` (D). This map
 * is the only place a kind's storage shape appears — adding a sixth entity is a
 * row here plus a policy branch, which is the whole point of the generic
 * service. A kind with no descriptor throws on use rather than silently allowing
 * or denying — see `describe` in access.service.ts.
 */
export const ACCESS_ENTITIES: PartialEntities = {
  board: {
    delegate: 'boardAccess',
    entityIdField: 'boardId',
    compoundKey: 'boardId_userId',
    entityDelegate: 'board',
    entityRelation: 'board',
    accessRelation: 'accessEntries',
    orgScope: 'own',
  },
  orgTree: {
    delegate: 'orgTreeAccess',
    entityIdField: 'orgTreeId',
    compoundKey: 'orgTreeId_userId',
    entityDelegate: 'orgTree',
    entityRelation: 'orgTree',
    accessRelation: 'access',
    orgScope: 'own',
  },
  roadmap: {
    delegate: 'roadmapAccess',
    entityIdField: 'roadmapId',
    compoundKey: 'roadmapId_userId',
    entityDelegate: 'roadmap',
    entityRelation: 'roadmap',
    accessRelation: 'accessEntries',
    orgScope: 'own',
  },
  employeeBoard: {
    delegate: 'employeeBoardAccess',
    entityIdField: 'employeeBoardId',
    compoundKey: 'employeeBoardId_userId',
    entityDelegate: 'employeeBoard',
    entityRelation: 'employeeBoard',
    accessRelation: 'access',
    orgScope: 'viaOrgTree',
    implicitOwnerFromOrgTree: true,
    personalFlagField: 'isPersonal',
  },
  comparison: {
    delegate: 'comparisonAccess',
    entityIdField: 'comparisonId',
    compoundKey: 'comparisonId_userId',
    entityDelegate: 'comparison',
    entityRelation: 'comparison',
    accessRelation: 'access',
    orgScope: 'own',
  },
};

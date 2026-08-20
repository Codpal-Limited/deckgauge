import type { AccessEntityKind } from '@deckgauge/shared';

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
  /** Prisma's generated name for `@@unique([entityId, userId])`, e.g. `boardId_userId`. */
  compoundKey: string;
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
  board: { delegate: 'boardAccess', entityIdField: 'boardId', compoundKey: 'boardId_userId' },
  orgTree: { delegate: 'orgTreeAccess', entityIdField: 'orgTreeId', compoundKey: 'orgTreeId_userId' },
  roadmap: { delegate: 'roadmapAccess', entityIdField: 'roadmapId', compoundKey: 'roadmapId_userId' },
  employeeBoard: {
    delegate: 'employeeBoardAccess',
    entityIdField: 'employeeBoardId',
    compoundKey: 'employeeBoardId_userId',
  },
  comparison: {
    delegate: 'comparisonAccess',
    entityIdField: 'comparisonId',
    compoundKey: 'comparisonId_userId',
  },
};

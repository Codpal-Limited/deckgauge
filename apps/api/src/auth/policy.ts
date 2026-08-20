import type { PrismaClient, BoardAccessRole, RoadmapAccessRole } from '@deckgauge/db';
import type { OrgRoleValue } from '@deckgauge/shared';
import { ROLE_RANK as RANK } from './board-access.js';
import { effectiveBoardRole, meetsBoardRole, meetsOrgRole } from '../authz/policy.js';

/**
 * Models a board is reachable from without the board id already being a route
 * param. Verified against packages/db/prisma/schema.prisma:
 *   - direct `boardId` column: Group (L196), BoardColumn (L297),
 *     AutomationRule (L325), BoardStatus (L159), Project (L221 — nullable),
 *     BoardOwner (L137-139 — `boardId String @map("board_id")`)
 *   - one hop through `projectId` → Project.boardId: ProjectComment
 *     (L277 — projectId required), Upload (L383 — projectId nullable)
 * A model whose row is missing, or whose resolved boardId/projectId is null,
 * resolves to `undefined` — the caller must treat that as "deny", never as
 * "no board required".
 */
export type SubEntityModel =
  | 'group'
  | 'boardColumn'
  | 'automationRule'
  | 'boardStatus'
  | 'project'
  | 'projectComment'
  | 'upload'
  | 'boardOwner';

const SUB_ENTITY_PATH: Record<SubEntityModel, { hop?: 'project' }> = {
  group: {},
  boardColumn: {},
  automationRule: {},
  boardStatus: {},
  project: {},
  projectComment: { hop: 'project' },
  upload: { hop: 'project' },
  boardOwner: {},
};

/**
 * Models an org tree is reachable from without the tree id already being a
 * route param. Verified against packages/db/prisma/schema.prisma:
 *   - direct `orgTreeId` column: EmployeeBoard (model L1111, column L1113),
 *     OrgEmployee (model L985, column L987)
 *   - one hop through `employeeBoardId` → EmployeeBoard.orgTreeId:
 *     EmployeeBoardMember.employeeBoardId (L1149),
 *     EmployeeGroup.employeeBoardId (model L1131, column L1133),
 *     EmployeeColumn.employeeBoardId (model L1164, column L1166)
 *   - one hop through OrgEmployee.orgTreeId, via a foreign key that is
 *     *not* spelled the same way on every model:
 *     OrgEmployeeAlias.employeeId (L1082 — NOT `orgEmployeeId`),
 *     OrgEmployeeComment.orgEmployeeId (L1095)
 * The FK field name is carried in `hop.fk` below rather than assumed by the
 * resolver, precisely because it differs between these two models — a
 * previous version of this file hardcoded `row.orgEmployeeId` for every
 * `orgEmployee` hop, which silently 403'd every `orgEmployeeAlias` lookup
 * since that model has no `orgEmployeeId` column at all. Do not "simplify"
 * this back to a single assumed column name.
 * A missing row, or a null hop column, resolves to `undefined` — deny.
 */
export type OrgEntityModel =
  | 'employeeBoard'
  | 'employeeBoardMember'
  | 'employeeGroup'
  | 'employeeColumn'
  | 'orgEmployee'
  | 'orgEmployeeAlias'
  | 'orgEmployeeComment';

/**
 * The set of FK column names any hop can read. Kept as a literal union
 * (mirroring `SUB_ENTITY_PATH`'s `hop?: 'project'` above it) rather than
 * `string`, so a typo'd column name — e.g. a stray `'TYPO_orgEmployeeId'` —
 * fails `tsc`, not just silently 403ing every lookup through that hop until
 * someone notices in production.
 */
type OrgEntityFk = 'employeeBoardId' | 'employeeId' | 'orgEmployeeId';

const ORG_ENTITY_PATH: Record<
  OrgEntityModel,
  { hop?: { via: 'employeeBoard' | 'orgEmployee'; fk: OrgEntityFk } }
> = {
  employeeBoard: {},
  orgEmployee: {},
  employeeBoardMember: { hop: { via: 'employeeBoard', fk: 'employeeBoardId' } },
  employeeGroup: { hop: { via: 'employeeBoard', fk: 'employeeBoardId' } },
  employeeColumn: { hop: { via: 'employeeBoard', fk: 'employeeBoardId' } },
  orgEmployeeAlias: { hop: { via: 'orgEmployee', fk: 'employeeId' } },
  orgEmployeeComment: { hop: { via: 'orgEmployee', fk: 'orgEmployeeId' } },
};

/**
 * Two shapes: the extracted value(s) already ARE org tree ids (`orgTreeId`),
 * or they are ids of one of the five sub-entities above that must be resolved
 * first (`orgEntity`). `orgTreeId` exists because the no-source default reads
 * `ctx.params` only — a route that carries the tree id in the QUERY (e.g.
 * `?orgTreeId=`) needs an explicit source to have it checked at all.
 */
export type OrgTreeSource =
  | { kind: 'orgTreeId'; ids: IdExtractor }
  | { kind: 'orgEntity'; model: OrgEntityModel; ids: IdExtractor };

/** The extracted value(s) already ARE org tree ids — no sub-entity hop. */
export const viaOrgTreeId = (ids: IdExtractor): OrgTreeSource => ({ kind: 'orgTreeId', ids });

export const viaOrgEntity = (model: OrgEntityModel, ids: IdExtractor): OrgTreeSource => ({
  kind: 'orgEntity',
  model,
  ids,
});

/** Pulls one or more ids out of a request. `undefined` means "not present here" — never `[]`. */
export type IdExtractor = (ctx: PolicyContext) => string[] | undefined;

/** A single route param, e.g. the `:id` in `/columns/:id`. */
export const fromParam = (key: string): IdExtractor => (ctx) => {
  const v = ctx.params[key];
  return v ? [v] : undefined;
};

/** A single query-string value, e.g. `?projectId=` on `/api/uploads`. */
export const fromQuery = (key: string): IdExtractor => (ctx) => {
  const v = ctx.query?.[key];
  return v ? [v] : undefined;
};

/**
 * A comma-separated query-string value, e.g. `?projectIds=a,b,c`.
 *
 * Fastify hands back an **array** when the same param repeats
 * (`?projectIds=a&projectIds=b`), so a caller — hostile or not — can turn this
 * value into something with no `.split`. Both shapes are flattened here; any
 * other shape yields `undefined`, which the caller treats as deny. Calling
 * `.split` blind would throw out of the authz layer as a 500 instead.
 */
export const fromQueryCsv = (key: string): IdExtractor => (ctx) => {
  const ids = parseCsvParam(ctx.query?.[key]);
  return ids.length > 0 ? ids : undefined;
};

/**
 * The parsing half of `fromQueryCsv`, exported so a route HANDLER reading the
 * same param reads it the same way the policy did.
 *
 * The rule: any handler that re-reads a CSV query param a `fromQueryCsv`
 * policy already resolved must go through this, never `raw.split(',')` — a
 * repeated param (`?ids=a&ids=b`) arrives as an array, and `.split` on it
 * throws a 500 out of a route the policy layer had already handled correctly.
 * Returns `[]`, never `undefined`, so callers branch on emptiness.
 */
export function parseCsvParam(raw: unknown): string[] {
  if (!raw) return [];
  const parts = Array.isArray(raw) ? raw : [raw];
  return parts
    .filter((p): p is string => typeof p === 'string')
    .flatMap((p) => p.split(','))
    .map((s) => s.trim())
    .filter(Boolean);
}

/** A single field on the JSON body, e.g. `{ boardId }` on `POST /groups`. */
export const fromBodyField = (key: string): IdExtractor => (ctx) => {
  const body = ctx.body as Record<string, unknown> | undefined;
  const v = body?.[key];
  return typeof v === 'string' && v ? [v] : undefined;
};

/** An array field on the JSON body, e.g. `{ ids: [...] }` on `POST /projects/bulk-delete`. */
export const fromBodyFieldArray = (key: string): IdExtractor => (ctx) => {
  const body = ctx.body as Record<string, unknown> | undefined;
  const v = body?.[key];
  if (!Array.isArray(v)) return undefined;
  const ids = v.filter((x): x is string => typeof x === 'string' && x.length > 0);
  return ids.length === v.length && ids.length > 0 ? ids : undefined;
};

/**
 * The body itself is an array of objects, e.g. `[{ id, position }, ...]` on
 * `POST /groups/reorder`. Any element missing `idKey` makes the whole batch
 * unresolvable (deny) rather than silently dropping it from the check.
 */
export const fromBodyArray = (idKey: string): IdExtractor => (ctx) => {
  const body = ctx.body;
  if (!Array.isArray(body)) return undefined;
  const ids = body.map((el) => (el as Record<string, unknown> | null)?.[idKey]).filter((x): x is string => typeof x === 'string' && x.length > 0);
  return ids.length === body.length && ids.length > 0 ? ids : undefined;
};

/**
 * One arm of a `viaBranch` — evaluated in order, first match wins (never
 * OR'd together; see `viaBranch`'s doc for why that distinction matters).
 * `then: 'authenticated'` means "this arm needs nothing beyond being signed
 * in" — safe because `evaluatePolicy` has already denied unauthenticated
 * callers by the time a `board` policy's source is resolved. `then:
 * 'boardId'` means the extracted value(s) already ARE board ids — the
 * per-arm equivalent of a top-level `viaBoardId` source, needed when only
 * SOME shapes of a request carry a board id directly (e.g. a comparison
 * widget's request shares its `:boardId` slot with a real board's, and only
 * one arm's ids are literal board ids). `then: 'comparisonAccess'` means
 * the extracted value(s) are Comparison ids and the caller must be each
 * one's creator — no board is involved at all, mirroring how the
 * `comparison` policy kind checks `Comparison.createdBy` (see
 * `hasComparisonRole`, shared by both).
 *
 * `then: 'orgEntity'` means the extracted value(s) are ids of an
 * `OrgEntityModel` whose **org tree** must be resolved and checked — the
 * caller must hold at least the `board` policy's declared role on every tree
 * so resolved (see `hasOrgTreeRole`). It exists because one request shape can
 * legitimately address either a board-owned resource or an org-tree-owned one
 * (`POST /api/uploads?projectId=` vs `?orgEmployeeId=`), and the org-tree arm
 * must be gated on `OrgTreeAccess` rather than waved through. Reach for this
 * — never `'authenticated'` — whenever an arm's ids name a row that some
 * org tree owns.
 */
export type BoardBranch =
  | { when: IdExtractor; then: SubEntityModel }
  | { when: IdExtractor; then: 'boardId' }
  | { when: IdExtractor; then: 'authenticated' }
  | { when: IdExtractor; then: 'comparisonAccess' }
  | { when: IdExtractor; then: 'orgEntity'; orgModel: OrgEntityModel };

/**
 * One recipe for locating the board(s) a `board` policy should check: either
 * the extracted value(s) already ARE board ids, or they are ids of a
 * `SubEntityModel` whose board must be resolved first. A policy may list
 * several — e.g. `POST /projects/:id/move-to-board` needs EDITOR on both the
 * project's current board and the target group's board — in which case every
 * source must resolve and the role check runs against every distinct board.
 *
 * `branch` is different: it's for one request shape that can mean two
 * *unrelated* things depending on which discriminator is present (e.g.
 * `POST /api/uploads?projectId=` vs `?orgEmployeeId=`). Branches are tried in
 * order and only the first one whose `when` extracts something is evaluated
 * — never OR'd together. An OR-of-full-checks would be actively wrong here:
 * a failed board check on one branch must not fall through and let a
 * different, weaker branch decide instead. No matching branch denies.
 */
export type BoardSource =
  | { kind: 'boardId'; ids: IdExtractor }
  | { kind: 'entity'; model: SubEntityModel; ids: IdExtractor }
  | { kind: 'branch'; branches: BoardBranch[] };

export const viaBoardId = (ids: IdExtractor): BoardSource => ({ kind: 'boardId', ids });
export const viaEntity = (model: SubEntityModel, ids: IdExtractor): BoardSource => ({ kind: 'entity', model, ids });
export const viaBranch = (branches: BoardBranch[]): BoardSource => ({ kind: 'branch', branches });

export type Policy =
  | { kind: 'public' }
  | { kind: 'authenticated' }
  | { kind: 'board'; role: BoardAccessRole; source?: BoardSource | BoardSource[] }
  | { kind: 'roadmap'; role: BoardAccessRole }
  | { kind: 'orgTree'; role: BoardAccessRole; source?: OrgTreeSource | OrgTreeSource[] }
  | { kind: 'comparison'; role: BoardAccessRole }
  | { kind: 'analytics' }
  | { kind: 'admin' }
  | { kind: 'orgRole'; role: OrgRoleValue }
  | { kind: 'employeeBoard'; role: BoardAccessRole; source?: EmployeeBoardSource }
  | { kind: 'employeeBoardInTree'; role: BoardAccessRole }
  | { kind: 'all'; policies: Policy[] }
  | { kind: 'any'; policies: Policy[] };

export const PUBLIC: Policy = { kind: 'public' };
export const AUTHENTICATED: Policy = { kind: 'authenticated' };
/**
 * Cross-cutting people-analytics reads that carry no board or org-tree id —
 * per-developer PR/commit/hours data. Gated on a Keycloak realm role rather
 * than a row, because there is no entity in the request to scope against.
 */
export const ANALYTICS: Policy = { kind: 'analytics' };
/** Global settings with no per-entity owner: timesheet status rules, LLM provider config. */
export const ADMIN: Policy = { kind: 'admin' };
/**
 * A comparison, as a tiered decision (design D15). Replaces
 * `COMPARISON_CREATOR`, which answered one boolean — "did you make this?" — and
 * so could not express "you may read this but not change which boards it
 * compares".
 */
export const comparison = (role: BoardAccessRole): Policy => ({ kind: 'comparison', role });
/**
 * `board(role)` — board id is already a route param (`boardId`, falling back
 * to `id`); unchanged from before this file grew sub-entity resolution.
 * `board(role, source)` — the board is reachable via one or more
 * `BoardSource` recipes (see that type for why more than one is ever needed).
 */
export const board = (role: BoardAccessRole, source?: BoardSource | BoardSource[]): Policy => ({ kind: 'board', role, source });
export const roadmap = (role: BoardAccessRole): Policy => ({ kind: 'roadmap', role });
/**
 * `orgTree(role)` — the tree id is already a route param (`orgTreeId`,
 * `treeId`, falling back to `id`). `orgTree(role, source)` — the tree is
 * reachable via one or more `OrgTreeSource` recipes.
 */
export const orgTree = (
  role: BoardAccessRole,
  source?: OrgTreeSource | OrgTreeSource[],
): Policy => ({ kind: 'orgTree', role, source });

/**
 * How to find the employee board a request is about. Absent means the board id
 * is already a route param (`boardId`, falling back to `id`); `VIA_MEMBER` is
 * the one hop this phase needs — two routes carry a member id and no board id.
 *
 * Reuses `ORG_ENTITY_PATH` rather than re-deriving the hop. That table carries
 * the FK name PER MODEL for a reason recorded in its own comment: a previous
 * version hardcoded one column name and silently 403'd every lookup through a
 * model that does not have it.
 */
export type EmployeeBoardSource = { model: OrgEntityModel; ids: IdExtractor };

export const VIA_MEMBER: EmployeeBoardSource = {
  model: 'employeeBoardMember',
  ids: (ctx) => (ctx.params.memberId ? [ctx.params.memberId] : undefined),
};

/**
 * A board INSIDE an org tree, as its own access decision (design D12).
 *
 * Org-tree access deliberately does not reach it — that separation is the
 * requirement. Two implicit-owner rules keep administration working: an org
 * ADMIN is an implicit OWNER of every board in their organization, and an
 * OWNER grant on the PARENT TREE makes the caller an OWNER of every board in
 * it, so an org-tree owner can never create a board they cannot then open.
 * Note the second is OWNER specifically: a tree EDITOR gets nothing here.
 */
export const employeeBoard = (
  role: BoardAccessRole,
  source?: EmployeeBoardSource,
): Policy => ({ kind: 'employeeBoard', role, source });

/**
 * The caller holds `role` on AT LEAST ONE board inside the tree named by the
 * route param.
 *
 * Exists for one route — `GET /org-trees/:id` (design D14) — so a board-only
 * grantee can load the org page shell and reach their board. 403ing the shell
 * would make the board unreachable, which would make per-board sharing useless.
 */
export const employeeBoardInTree = (role: BoardAccessRole): Policy => ({
  kind: 'employeeBoardInTree',
  role,
});

/**
 * Every listed policy must pass. Evaluated in order; the FIRST denial is
 * returned, so a 401 from an unauthenticated caller still wins over a 403.
 * Use when a route needs two independent grants — e.g. the analytics realm
 * role AND access to the org tree named in the request.
 */
/**
 * Requires an ACTIVE organization membership of at least `role`.
 *
 * This is the policy that makes `request.membership` non-null for the handler
 * behind it — which is what lets a route create a tenant root without carrying
 * its own guard. It answers a question about the caller's standing *inside a
 * tenant*, so it deliberately ignores `ctx.isAdmin`: that flag can come from the
 * Keycloak realm role or `users.is_admin`, neither of which is tenant-scoped,
 * and accepting it here would turn an instance-level break-glass bit into an
 * org-admin grant in every organization at once.
 */
export const orgRole = (role: OrgRoleValue): Policy => ({ kind: 'orgRole', role });

/**
 * ANY active membership, VIEWER included — the floor for a read that is scoped
 * to the caller's organization.
 *
 * Distinct from `AUTHENTICATED` in the one way that matters: it guarantees
 * `request.membership`, so the handler may call `requireOrganizationId` and
 * filter by tenant. `AUTHENTICATED` cannot, because it resolves no membership,
 * which is why the reads that carried it returned every organization's rows.
 *
 * Distinct from `ORG_MEMBER` in the other way that matters: a VIEWER passes.
 * VIEWER exists to be read-only, so gating a READ on MEMBER would deny the role
 * whose entire purpose is reading — and the board Sources tab is one of the
 * screens that would go blank. Pinned by sync-config-enforcement.test.ts.
 *
 * Reach for this on any tenant-scoped read; reach for ORG_MEMBER the moment the
 * route writes.
 */
export const ORG_VIEWER: Policy = orgRole('VIEWER');

/** An organization member — the floor for creating anything owned by a tenant. */
export const ORG_MEMBER: Policy = orgRole('MEMBER');
/**
 * Organization administration: members, connections, org-wide settings.
 *
 * Connection management (create/edit/delete/test/reconnect, all four providers)
 * lives here as of Phase C. It replaced a `connectionOwner` kind that decided on
 * the row's `created_by_id` instead of the caller's standing in the tenant — a
 * second authorization axis that could disagree with this one, and one that
 * returned ALLOW on an unclaimed row before any membership was resolved. Note
 * that `orgRole` establishes membership FIRST (see its branch in
 * `evaluatePolicy`), so a membership-less caller is denied rather than reaching a
 * handler that needs `request.membership`.
 *
 * `created_by_id` is still written; it is ownership metadata, not a gate.
 */
export const ORG_ADMIN: Policy = orgRole('ADMIN');

export const all = (...policies: Policy[]): Policy => ({ kind: 'all', policies });

/**
 * At least one listed policy must pass — the OR to `all`'s AND.
 *
 * Denial reporting is the whole subtlety. When every branch denies, returning
 * the first denial would let a bare `Forbidden` mask a `NO_ORGANIZATION`, and
 * `NO_ORGANIZATION` is the one denial that tells the caller what to DO (join or
 * bootstrap an organization) rather than merely that they may not. So the most
 * specific denial wins.
 *
 * Deliberately does NOT report which branch admitted the caller. A combinator
 * that returned provenance would invite handlers to re-implement authorization
 * from it; a handler that needs to know asks its own question instead — see
 * `GET /org-trees/:id`, which re-reads the caller's tree role to decide whether
 * to send the chart.
 */
export const any = (...policies: Policy[]): Policy => ({ kind: 'any', policies });

export interface PolicyDeps {
  prisma: PrismaClient;
  singleUser: boolean;
}

export interface PolicyContext {
  user: { id: string } | null;
  params: Record<string, string | undefined>;
  query?: Record<string, string | undefined>;
  body?: unknown;
  /**
   * Request-scoped logger. Board resolution runs before the route's own Zod
   * validation, so a malformed id (e.g. a non-UUID `:cid`) reaches a Prisma
   * lookup directly; resolution catches that and denies rather than 500ing,
   * but still wants this to be debuggable.
   */
  log?: { error: (obj: unknown, msg?: string) => void };
  /** Keycloak realm-role signals, resolved by the auth plugin. Absent means false. */
  isAdmin?: boolean;
  canViewAnalytics?: boolean;
  /**
   * The caller's ACTIVE organization membership, resolved by the auth plugin, or
   * null when they have none. Null is a real state, not a missing value: a
   * first-run admin has no membership until `POST /organizations/bootstrap`
   * creates one, and a break-glass admin (realm role or `users.is_admin`) never
   * gets one implicitly — see the plugin's `request.isAdmin` union.
   */
  membership?: { organizationId: string; role: OrgRoleValue } | null;
}

export type PolicyDenial = { ok: false; status: 401 | 403; error: string };
export type PolicyResult = { ok: true } | PolicyDenial;

const DENY_401: PolicyResult = { ok: false, status: 401, error: 'Authentication required' };
const DENY_403: PolicyDenial = { ok: false, status: 403, error: 'Forbidden' };
/**
 * Distinct from a plain 403 on purpose: the caller is authenticated and their
 * request is well-formed, they simply belong to no organization yet. The web app
 * routes this to `/no-organization` rather than showing a permission error.
 */
const DENY_NO_ORG: PolicyResult = { ok: false, status: 403, error: 'NO_ORGANIZATION' };
const ALLOW: PolicyResult = { ok: true };

/** First route param that can carry the entity id, in priority order. */
function entityId(params: PolicyContext['params'], ...names: string[]): string | undefined {
  for (const n of names) if (params[n]) return params[n];
  return undefined;
}

/**
 * Sentinel meaning "this id resolved to an org-tree resource the caller has
 * ALREADY been authorized against — there is no board to check a role on."
 * Org trees have their own access model (`OrgTreeAccess`); the check that
 * earns this sentinel happens inline where it's produced, not here. The only
 * producer today is `upload`'s org-employee branch below; every other model
 * only ever returns a board id or `undefined`.
 */
const ORG_OK = 'org-ok' as const;
type Resolved = string | typeof ORG_OK | undefined;

/**
 * Resolves one sub-entity id to its board id. Returns `undefined` — deny —
 * for a missing row, a null `boardId`/`projectId`, or a failed/uncheckable/
 * insufficient org-tree access check; returns `ORG_OK` for the one documented
 * exception (see the `upload` branch below), which requires the caller's
 * `OrgTreeAccess` role to rank at or above `requiredRole` — the same bar the
 * `board` and `orgTree` evaluator branches hold everyone else to, not mere
 * row existence; never throws — a malformed id reaches this straight from
 * route params/query/body, before the route's own Zod validation runs, so a
 * DB error here is caught and denied rather than surfacing as an unhandled
 * 500 from the authz layer.
 */
async function resolveBoardId(
  prisma: PrismaClient,
  model: SubEntityModel,
  id: string,
  ctx: PolicyContext,
  requiredRole: BoardAccessRole,
): Promise<Resolved> {
  try {
    const row = await (
      prisma[model] as {
        findUnique: (a: unknown) => Promise<{ boardId?: string | null; projectId?: string | null; orgEmployeeId?: string | null } | null>;
      }
    ).findUnique({ where: { id } });
    if (!row) return undefined;

    const path = SUB_ENTITY_PATH[model];
    if (!path.hop) return row.boardId ?? undefined;

    if (!row.projectId) {
      // `upload` is the only two-hop model with a legitimate second parent:
      // an Upload with no `projectId` is attached to an `OrgEmployee`
      // instead (see the schema — `projectId` and `orgEmployeeId` are both
      // nullable, mutually exclusive). Org trees now have their own access
      // model (`OrgTreeAccess`), so this is a real permission check, not a
      // "being signed in is enough" shortcut: resolve the employee's tree
      // and require the caller to hold a role on it (or be an admin) before
      // treating the upload as reachable.
      if (model === 'upload' && row.orgEmployeeId) {
        const treeId = await resolveOrgTreeId(prisma, 'orgEmployee', row.orgEmployeeId, ctx);
        if (!treeId) return undefined;
        return (await hasOrgTreeRole(prisma, treeId, ctx, requiredRole)) ? ORG_OK : undefined;
      }
      return undefined;
    }
    const project = await prisma.project.findUnique({ where: { id: row.projectId } });
    return project?.boardId ?? undefined;
  } catch (err) {
    ctx.log?.error(err, `policy: failed to resolve board for ${model} id "${id}" — denying`);
    return undefined;
  }
}

/**
 * Resolves one org sub-entity id to its org tree id. Same fail-closed
 * contract as `resolveBoardId`: `undefined` for a missing row, a null hop
 * column, or any lookup failure — never throws, never falls through.
 */
async function resolveOrgTreeId(
  prisma: PrismaClient,
  model: OrgEntityModel,
  id: string,
  ctx: PolicyContext,
): Promise<string | undefined> {
  try {
    const row = await (
      prisma[model] as {
        findUnique: (a: unknown) => Promise<Record<string, string | null | undefined> | null>;
      }
    ).findUnique({ where: { id } });
    if (!row) return undefined;

    const path = ORG_ENTITY_PATH[model];
    if (!path.hop) return row.orgTreeId ?? undefined;

    // The FK column name is read generically off the path map (`hop.fk`)
    // rather than assumed — see the `ORG_ENTITY_PATH` doc comment for why a
    // single hardcoded name is wrong here.
    const fkValue = row[path.hop.fk];
    if (!fkValue) return undefined;

    if (path.hop.via === 'employeeBoard') {
      const parent = await prisma.employeeBoard.findUnique({ where: { id: fkValue } });
      return parent?.orgTreeId ?? undefined;
    }

    const employee = await prisma.orgEmployee.findUnique({ where: { id: fkValue } });
    return employee?.orgTreeId ?? undefined;
  } catch (err) {
    ctx.log?.error(err, `policy: failed to resolve org tree for ${model} id "${id}" — denying`);
    return undefined;
  }
}

/**
 * Does the caller hold at least `requiredRole` on this org tree?
 *
 * The rule — not a snapshot of today's call sites: an org-tree-owned row is
 * gated on `OrgTreeAccess` at the same rank a direct edit of that row would
 * need. Mere row existence, and merely being signed in, are never enough.
 *
 * Carries the same org-role ceiling as `evaluatePolicy`'s `orgTree` branch: an
 * org ADMIN is OWNER-equivalent on this tree, and an org VIEWER is capped at
 * VIEWER however generous the grant row is. The instance-level break-glass
 * (`ctx.isAdmin`) short-circuits the lookup entirely, but only when there is
 * no membership to consult — the pre-bootstrap admin, exactly as the
 * evaluator branch admits them.
 *
 * Like the evaluator branch, this does NOT verify `orgTreeId`'s own
 * `organizationId` against the caller's — closing that is a
 * `DECKGAUGE_MULTI_ORG=true` precondition recorded in the design doc, not
 * something either function does today.
 *
 * Fail-closed and never throws: a lookup failure denies rather than surfacing
 * as a 500 out of the authz layer. Shared by every org-tree check that happens
 * *inside* board-source resolution — the `upload` read hop and the
 * `then: 'orgEntity'` branch arm — so the read and write sides cannot drift
 * apart from each other or from the evaluator.
 */
async function hasOrgTreeRole(
  prisma: PrismaClient,
  orgTreeId: string,
  ctx: PolicyContext,
  requiredRole: BoardAccessRole,
): Promise<boolean> {
  if (!ctx.user) return false;
  if (!ctx.membership && ctx.isAdmin) return true;
  try {
    const access: { role: BoardAccessRole } | null = await prisma.orgTreeAccess.findUnique({
      where: { orgTreeId_userId: { orgTreeId, userId: ctx.user.id } },
    });
    if (ctx.membership) {
      const effective = effectiveBoardRole(ctx.membership.role, access?.role ?? null);
      return meetsBoardRole(effective, requiredRole);
    }
    return !!access && RANK[access.role] >= RANK[requiredRole];
  } catch (err) {
    ctx.log?.error(err, `policy: failed to check org-tree access for tree "${orgTreeId}" — denying`);
    return false;
  }
}

/**
 * Resolves an `orgTree` policy's source(s) to the distinct set of tree ids the
 * requester must hold the required role on. `undefined` means deny — no source
 * and no param carrying a tree id, an extractor finding nothing, or any id
 * failing to resolve.
 */
/**
 * The employee-board ids a request is about. `undefined` means "could not
 * resolve" — deny. Never `[]`, which a caller could mistake for "nothing to
 * check, so allow".
 *
 * `resolveOrgTreeId` above resolves the same hop but answers with a TREE id,
 * which is precisely what this kind must not do — so the hop is walked here
 * with the FK name read off `ORG_ENTITY_PATH`, not a second hardcoded column.
 */
async function resolveEmployeeBoardIds(
  prisma: PrismaClient,
  source: EmployeeBoardSource | undefined,
  ctx: PolicyContext,
): Promise<string[] | undefined> {
  if (!source) {
    const id = ctx.params.boardId ?? ctx.params.id;
    return id ? [id] : undefined;
  }
  const ids = source.ids(ctx);
  if (!ids || ids.length === 0) return undefined;

  const path = ORG_ENTITY_PATH[source.model];
  if (!path.hop) return ids;

  try {
    // Same `as unknown as` shape `resolveOrgTreeId` uses for its own generic
    // delegate lookup: the seven org-entity delegates have no common structural
    // type, so a direct assertion is rejected.
    const delegate = prisma[source.model] as unknown as {
      findMany: (a: unknown) => Promise<Record<string, string | null | undefined>[]>;
    };
    const rows = await delegate.findMany({ where: { id: { in: ids } } });
    const resolved = rows
      .map((row) => row[path.hop!.fk])
      .filter((v): v is string => typeof v === 'string' && v.length > 0);
    // A missing row or a null hop resolves to nothing — deny, never fall
    // through to "no ids to check, so allow".
    return resolved.length === ids.length ? resolved : undefined;
  } catch (err) {
    ctx.log?.error(err, `policy: failed to resolve ${source.model} hop — denying`);
    return undefined;
  }
}

async function resolveOrgTreeIds(
  prisma: PrismaClient,
  source: OrgTreeSource | OrgTreeSource[] | undefined,
  ctx: PolicyContext,
): Promise<string[] | undefined> {
  if (!source) {
    const treeId = entityId(ctx.params, 'orgTreeId', 'treeId', 'id');
    return treeId ? [treeId] : undefined;
  }

  const sources = Array.isArray(source) ? source : [source];
  const treeIds = new Set<string>();

  for (const s of sources) {
    const ids = s.ids(ctx);
    if (!ids || ids.length === 0) return undefined;

    if (s.kind === 'orgTreeId') {
      for (const id of ids) treeIds.add(id);
      continue;
    }

    const resolved = await Promise.all(ids.map((id) => resolveOrgTreeId(prisma, s.model, id, ctx)));
    if (resolved.some((t) => t === undefined)) return undefined;
    for (const t of resolved) treeIds.add(t as string);
  }

  return [...treeIds];
}

/**
 * Does the caller hold at least `requiredRole` on this comparison?
 *
 * Was `isComparisonCreator`, comparing `Comparison.createdBy`. As of design D15
 * comparisons have a real ACL and `createdBy` is provenance only — so this reads
 * `ComparisonAccess` under the org-role ceiling, exactly as the `comparison`
 * policy kind does. Shared by that kind and by the `comparisonAccess` branch
 * arm (`BoardBranch`) so the two cannot drift: a comparison shared with someone
 * must also let them read the widget data built from it.
 *
 * The comparison is read THROUGH the caller's organization when there is one, so
 * a foreign comparison and a missing one are indistinguishable. Returns `false`
 * — never throws — for a missing row or a lookup failure, the same fail-closed
 * reasoning as `resolveBoardId`.
 */
async function hasComparisonRole(
  prisma: PrismaClient,
  comparisonId: string,
  ctx: PolicyContext,
  requiredRole: BoardAccessRole,
): Promise<boolean> {
  if (!ctx.user) return false;
  try {
    if (!ctx.membership) {
      if (ctx.isAdmin) return true;
      const grant = await prisma.comparisonAccess.findUnique({
        where: { comparisonId_userId: { comparisonId, userId: ctx.user.id } },
        select: { role: true },
      });
      return !!grant && RANK[grant.role] >= RANK[requiredRole];
    }
    const scoped = await prisma.comparison.findFirst({
      where: { id: comparisonId, organizationId: ctx.membership.organizationId },
      select: { access: { where: { userId: ctx.user.id }, select: { role: true } } },
    });
    if (!scoped) return false;
    return meetsBoardRole(
      effectiveBoardRole(ctx.membership.role, scoped.access[0]?.role ?? null),
      requiredRole,
    );
  } catch (err) {
    ctx.log?.error(err, `policy: failed to resolve comparison access for id "${comparisonId}" — denying`);
    return false;
  }
}

/**
 * Resolves a `board` policy's source(s) to the distinct set of board ids the
 * requester must hold the required role on. Returns `undefined` — meaning
 * "deny" — when no source is configured and no param carries a board id
 * directly, when an extractor finds nothing, when no `branch` arm matches,
 * or when any extracted id fails to resolve to a board. A missing/
 * unresolvable id never falls through to "no board required"; it always
 * denies. An empty (but non-`undefined`) result is legitimate — it means
 * every source resolved and none of them needed a board (every id resolved
 * to `ORG_OK`, a `branch` arm matched `then: 'authenticated'`, or a
 * `branch` arm matched `then: 'comparisonAccess'` and every extracted id
 * passed its access check) — the caller allows outright in that case.
 */
async function resolveBoardIds(
  prisma: PrismaClient,
  source: BoardSource | BoardSource[] | undefined,
  ctx: PolicyContext,
  requiredRole: BoardAccessRole,
): Promise<string[] | undefined> {
  if (!source) {
    const boardId = entityId(ctx.params, 'boardId', 'id');
    return boardId ? [boardId] : undefined;
  }

  const sources = Array.isArray(source) ? source : [source];
  const boardIds = new Set<string>();

  const applyResolved = (resolved: Resolved[]): boolean => {
    if (resolved.some((b) => b === undefined)) return false;
    for (const b of resolved) if (b !== ORG_OK) boardIds.add(b as string);
    return true;
  };

  for (const s of sources) {
    if (s.kind === 'boardId') {
      const ids = s.ids(ctx);
      if (!ids || ids.length === 0) return undefined;
      for (const id of ids) boardIds.add(id);
      continue;
    }

    if (s.kind === 'entity') {
      const ids = s.ids(ctx);
      if (!ids || ids.length === 0) return undefined;
      const resolved = await Promise.all(ids.map((id) => resolveBoardId(prisma, s.model, id, ctx, requiredRole)));
      if (!applyResolved(resolved)) return undefined;
      continue;
    }

    // s.kind === 'branch': first arm whose discriminator extracts something
    // wins; its ids are resolved (or, for `then: 'authenticated'`, just
    // accepted). No arm matching denies — it never falls through to a
    // weaker check. Whichever arm commits, a failed check inside it denies
    // outright — it never tries a later arm instead.
    let matched = false;
    for (const arm of s.branches) {
      const armIds = arm.when(ctx);
      if (!armIds || armIds.length === 0) continue;
      matched = true;
      if (arm.then === 'authenticated') break;
      if (arm.then === 'boardId') {
        for (const id of armIds) boardIds.add(id);
        break;
      }
      if (arm.then === 'orgEntity') {
        // The arm's ids name org-tree-owned rows, not board-owned ones.
        // Resolve each to its tree and require the policy's role on every
        // distinct tree, exactly as the `upload` read hop does. Contributing
        // no board ids is correct — and safe — only because the check has
        // already happened right here.
        const treeIds = await Promise.all(armIds.map((id) => resolveOrgTreeId(prisma, arm.orgModel, id, ctx)));
        if (treeIds.some((t) => t === undefined)) return undefined;
        const granted = await Promise.all(
          [...new Set(treeIds as string[])].map((treeId) => hasOrgTreeRole(prisma, treeId, ctx, requiredRole)),
        );
        if (granted.some((ok) => !ok)) return undefined;
        break;
      }
      if (arm.then === 'comparisonAccess') {
        // Defensive only: `evaluatePolicy` never calls into board-source
        // resolution for an unauthenticated caller, so `ctx.user` is always
        // set by the time a branch is evaluated. Treat the (unreachable in
        // practice) alternative as deny, not a crash.
        if (!ctx.user) return undefined;
        // VIEWER: this arm gates a READ of data derived from the comparison.
        // Editing which boards it compares is `comparison('EDITOR')` on its own
        // route, not here.
        const granted = await Promise.all(armIds.map((id) => hasComparisonRole(prisma, id, ctx, 'VIEWER')));
        if (granted.some((ok) => !ok)) return undefined;
        break;
      }
      const resolved = await Promise.all(armIds.map((id) => resolveBoardId(prisma, arm.then, id, ctx, requiredRole)));
      if (!applyResolved(resolved)) return undefined;
      break;
    }
    if (!matched) return undefined;
  }

  return [...boardIds];
}

export async function evaluatePolicy(
  deps: PolicyDeps,
  policy: Policy,
  ctx: PolicyContext,
): Promise<PolicyResult> {
  if (deps.singleUser) return ALLOW;
  if (policy.kind === 'public') return ALLOW;
  if (!ctx.user) return DENY_401;
  if (policy.kind === 'authenticated') return ALLOW;

  if (policy.kind === 'board') {
    const boardIds = await resolveBoardIds(deps.prisma, policy.source, ctx, policy.role);
    if (!boardIds) return DENY_403;
    for (const boardId of boardIds) {
      // The org-role ceiling (spec D3): a board grant may narrow the caller's
      // reach but never widen it beyond their organization role. An org ADMIN is
      // OWNER-equivalent on every board in their organization; an org VIEWER is
      // capped at VIEWER however generous the grant row is.
      //
      // "in their organization" is a predicate, not just prose. Every board id
      // reaching here came from route params, query or body (see
      // `resolveBoardIds`), so it may name a board in ANY tenant — and the
      // ceiling alone would then hand an org ADMIN implicit OWNER on another
      // organization's board with no BoardAccess row at all. So the board is
      // read THROUGH the caller's organization and a miss denies. Tenancy is
      // established before the ceiling is applied, never after: `effectiveBoardRole`
      // is a pure rule that knows nothing about boards and cannot do this itself.
      //
      // Resolving with the organization predicate (rather than fetching the board
      // and comparing afterwards) also makes a nonexistent board and a foreign
      // board indistinguishable — the gate never confirms that some other
      // tenant's id exists.
      //
      // Cost: this adds no round trip. `Board.organizationId` is required (see
      // packages/db/prisma/schema.prisma — `organization_id` is NOT NULL, and
      // `@@index([organizationId])` covers the predicate), and the same query
      // carries the caller's grant row, so the membership path still issues
      // exactly one query per board id, as it did when it read `boardAccess`
      // directly.
      if (ctx.membership) {
        let scoped: { accessEntries: { role: BoardAccessRole }[] } | null;
        try {
          scoped = await deps.prisma.board.findFirst({
            where: { id: boardId, organizationId: ctx.membership.organizationId },
            select: { accessEntries: { where: { userId: ctx.user.id }, select: { role: true } } },
          });
        } catch (err) {
          // Same fail-closed reasoning as resolveBoardId: a `boardId` sourced
          // straight from a literal (viaBoardId) never passes through Prisma
          // validation before reaching here, so a malformed value must deny,
          // not 500.
          ctx.log?.error(
            err,
            `policy: failed to resolve board "${boardId}" within the caller's organization — denying`,
          );
          return DENY_403;
        }
        // Missing board, or a board belonging to another organization — the same
        // answer on purpose.
        if (!scoped) return DENY_403;
        const effective = effectiveBoardRole(ctx.membership.role, scoped.accessEntries[0]?.role ?? null);
        if (!meetsBoardRole(effective, policy.role)) return DENY_403;
        continue;
      }

      // With no membership there is no organization role, so there is nothing to
      // impose a ceiling with — and no tenant to scope the board to — so the
      // grant decides alone, exactly today's behaviour. That fallback is
      // deliberate, not an oversight: a null membership means the caller is
      // pre-bootstrap or a break-glass admin, and denying here would change board
      // access for every existing single-tenant deployment the moment this branch
      // ships. Routes that must not run without a tenant are the ones that WRITE
      // a tenant root, and those are gated by `orgRole` instead. The tenant check
      // above is therefore scoped to the membership path only — deliberately, and
      // pinned by test.
      let access: { role: BoardAccessRole } | null;
      try {
        access = await deps.prisma.boardAccess.findUnique({
          where: { boardId_userId: { boardId, userId: ctx.user.id } },
        });
      } catch (err) {
        ctx.log?.error(err, `policy: failed to check board access for board "${boardId}" — denying`);
        return DENY_403;
      }
      if (!access || RANK[access.role] < RANK[policy.role]) return DENY_403;
    }
    return ALLOW;
  }

  if (policy.kind === 'orgRole') {
    if (!ctx.membership) return DENY_NO_ORG;
    return meetsOrgRole(ctx.membership.role, policy.role) ? ALLOW : DENY_403;
  }

  if (policy.kind === 'orgTree') {
    const treeIds = await resolveOrgTreeIds(deps.prisma, policy.source, ctx);
    // Deliberately NOT `if (!treeIds)` like `board`'s equivalent check: `board`
    // treats an empty-but-resolved set as allow because ORG_OK lets a source
    // resolve to "no board required" (see the `upload`/org-employee exception).
    // Org trees have no such case — every `orgTree` source either names a real
    // tree or the whole policy denies, so an empty resolved set (e.g.
    // `orgTree(role, [])`, or every source's ids extractor finding nothing)
    // must deny too, not fall through to "nothing to check, so allow."
    if (!treeIds || treeIds.length === 0) return DENY_403;

    // An admin is OWNER-equivalent on every tree — but "every tree" means every
    // tree IN THE CALLER'S ORGANIZATION, and that is a predicate, not just
    // prose. Every tree id reaching here came from route params, query, or a
    // sub-entity hop (see `resolveOrgTreeIds`), so it may name a tree in ANY
    // tenant; the bare override handed an org ADMIN of organization A
    // OWNER-equivalence on organization B's trees, with no OrgTreeAccess row at
    // all, across every route carrying an `orgTree(...)` policy — the trees, the
    // timesheet views built on them, and employee data.
    //
    // So the tree is read THROUGH the caller's organization and a miss denies,
    // for the admin override and for the grant path alike: a grant row narrows
    // reach inside the organization, it never creates reach outside it.
    // Resolving WITH the organization predicate (rather than fetching the tree
    // and comparing afterwards) also makes a nonexistent tree and a foreign tree
    // indistinguishable — the gate never confirms that another tenant's id
    // exists. `OrgTree.organizationId` is required (see
    // packages/db/prisma/schema.prisma — `organization_id` is NOT NULL, and
    // `@@index([organizationId])` covers the predicate), so there is no
    // "belongs to nobody" tree to special-case.
    //
    // Cost: the same read carries the caller's grant row, so the non-admin
    // membership path still issues exactly one query per tree id, as it did when
    // it read `orgTreeAccess` directly. An admin now pays one query per tree id
    // where it previously short-circuited to ALLOW on zero — that one read IS
    // the tenant check, and there is no cheaper way to establish tenancy.
    //
    // Deliberately still scoped to org trees: the `board` branch above has no
    // admin override at all, so an admin needs a real BoardAccess row there.
    if (ctx.membership) {
      const organizationId = ctx.membership.organizationId;
      // Every resolved id is checked, not just the first: `resolveOrgTreeIds`
      // returns a set, and a request that smuggles one foreign id alongside a
      // legitimate one must be denied rather than admitted on the strength of
      // the legitimate one.
      for (const orgTreeId of treeIds) {
        let scoped: { access: { role: BoardAccessRole }[] } | null;
        try {
          scoped = await deps.prisma.orgTree.findFirst({
            where: { id: orgTreeId, organizationId },
            select: { access: { where: { userId: ctx.user.id }, select: { role: true } } },
          });
        } catch (err) {
          // Same fail-closed contract as the rest of the branch: a malformed id
          // reaches Prisma before any route-level Zod validation, and must deny
          // rather than surface as a 500 out of the authz layer.
          ctx.log?.error(
            err,
            `policy: failed to resolve org tree "${orgTreeId}" within the caller's organization — denying`,
          );
          return DENY_403;
        }
        // Missing tree, or a tree belonging to another organization — the same
        // answer on purpose.
        if (!scoped) return DENY_403;
        // Tenancy established. Now the ORG-ROLE CEILING decides — not a bare
        // `ctx.isAdmin` override, and not the raw grant rank.
        //
        // Both halves are load-bearing and they were fixed independently on two
        // branches, each missing the other:
        //   - the tenancy predicate above stops an admin of organization A
        //     reaching organization B's tree at all;
        //   - the ceiling here stops an org VIEWER writing a tree inside their
        //     OWN organization on the strength of a generous grant row, and stops
        //     an instance break-glass admin who happens to hold a mere MEMBER
        //     membership being treated as OWNER.
        // Keeping only the predicate (as an earlier resolution of this merge did)
        // silently reopened both of those, because the tree is in the caller's own
        // organization and the predicate has nothing to say about it.
        //
        // `effectiveBoardRole` consults the membership ROLE, never `ctx.isAdmin`,
        // which is the whole point: `ctx.isAdmin` unions the org role with two
        // instance-level break-glass signals and so cannot answer "admin of THIS
        // organization".
        const effective = effectiveBoardRole(ctx.membership.role, scoped.access[0]?.role ?? null);
        if (!meetsBoardRole(effective, policy.role)) return DENY_403;
      }
      return ALLOW;
    }

    // With no membership there is no organization to scope the tree to, so this
    // path is left exactly as it was — deliberately, and pinned by test.
    //
    // `ctx.isAdmin` is the union of three sources (see the auth plugin) and only
    // one of them, an ADMIN membership, is organization-scoped. `auth/fastify.d.ts`
    // states the rule outright: it "must never be used to answer 'is this caller an
    // admin of THIS organization'" — which is exactly what the old bare override
    // did. The other two —
    // the `users.is_admin` bootstrap flag and the Keycloak realm role — are
    // instance-level break-glass, and the plugin deliberately refuses to
    // manufacture a membership for them: a break-glass operator has
    // `membership: null` until an organization is bootstrapped. Denying here
    // would therefore brick the documented recovery path (the `bootstrap:admin`
    // CLI and the administration guide) for precisely the operator who has
    // neither a membership nor an OrgTreeAccess row yet — the lockout this
    // override was added to prevent — and would revoke org-tree access in any
    // existing deployment whose memberships have not been backfilled. A
    // break-glass admin who DOES hold a membership is scoped to it by the branch
    // above; that is the intended tightening, and it is inert under the enforced
    // single-organization cap.
    if (ctx.isAdmin) return ALLOW;

    // No membership and not break-glass: the grant row decides alone, exactly as
    // it did before tenancy existed. There is no organization to scope the tree
    // to, so this path is deliberately unchanged — and it must NOT fall through
    // to ALLOW: an earlier attempt at this merge deleted the loop and left a bare
    // `return ALLOW` here, which admitted every membership-less caller to every
    // tree. The `orgTree policy` suite caught it immediately.
    for (const orgTreeId of treeIds) {
      let access: { role: BoardAccessRole } | null;
      try {
        access = await deps.prisma.orgTreeAccess.findUnique({
          where: { orgTreeId_userId: { orgTreeId, userId: ctx.user.id } },
        });
      } catch (err) {
        ctx.log?.error(err, `policy: failed to check org-tree access for tree "${orgTreeId}" — denying`);
        return DENY_403;
      }
      if (!access || RANK[access.role] < RANK[policy.role]) return DENY_403;
    }
    return ALLOW;
  }

  if (policy.kind === 'analytics') return ctx.canViewAnalytics ? ALLOW : DENY_403;
  if (policy.kind === 'admin') return ctx.isAdmin ? ALLOW : DENY_403;

  if (policy.kind === 'employeeBoard') {
    const boardIds = await resolveEmployeeBoardIds(deps.prisma, policy.source, ctx);
    if (!boardIds || boardIds.length === 0) return DENY_403;

    for (const employeeBoardId of boardIds) {
      // No membership: the break-glass path, mirroring the board and orgTree
      // branches' null-membership fallback. There is no organization to scope
      // the board to and no org role to impose a ceiling with, so the grant row
      // decides alone.
      if (!ctx.membership) {
        if (ctx.isAdmin) return ALLOW;
        let grant: { role: BoardAccessRole } | null;
        try {
          grant = await deps.prisma.employeeBoardAccess.findUnique({
            where: { employeeBoardId_userId: { employeeBoardId, userId: ctx.user.id } },
            select: { role: true },
          });
        } catch (err) {
          ctx.log?.error(err, `policy: failed to check employee-board access for "${employeeBoardId}" — denying`);
          return DENY_403;
        }
        if (!grant || RANK[grant.role] < RANK[policy.role]) return DENY_403;
        continue;
      }

      // Read the board THROUGH the caller's organization, carrying both their
      // own grant and their grant on the parent tree in the SAME query. A miss
      // denies: a nonexistent board and another tenant's board are deliberately
      // indistinguishable, so the gate never confirms a foreign id exists.
      let scoped: {
        access: { role: BoardAccessRole }[];
        orgTree: { access: { role: BoardAccessRole }[] };
      } | null;
      try {
        scoped = await deps.prisma.employeeBoard.findFirst({
          where: {
            id: employeeBoardId,
            orgTree: { organizationId: ctx.membership.organizationId },
          },
          select: {
            access: { where: { userId: ctx.user.id }, select: { role: true } },
            orgTree: {
              select: { access: { where: { userId: ctx.user.id }, select: { role: true } } },
            },
          },
        });
      } catch (err) {
        // Fail closed, same contract as every other kind: a malformed id
        // reaches Prisma before any route-level Zod validation and must deny
        // rather than surface as a 500 out of the authz layer.
        ctx.log?.error(
          err,
          `policy: failed to resolve employee board "${employeeBoardId}" within the caller's organization — denying`,
        );
        return DENY_403;
      }
      if (!scoped) return DENY_403;

      // D12's second implicit-owner rule. An OWNER grant on the PARENT TREE
      // makes the caller an OWNER of every board in it — that is what stops an
      // org-tree owner creating a board they then cannot open, and it is why the
      // tree's grant is read here rather than the tree gate being kept. OWNER
      // specifically: a tree EDITOR gets nothing, which IS the separation D12
      // exists to create. The first rule (org ADMIN -> OWNER) is inside
      // `effectiveBoardRole`.
      const treeGrant = scoped.orgTree.access[0]?.role ?? null;
      const boardGrant = scoped.access[0]?.role ?? null;
      const grant = treeGrant === 'OWNER' ? 'OWNER' : boardGrant;

      const effective = effectiveBoardRole(ctx.membership.role, grant);
      if (!meetsBoardRole(effective, policy.role)) return DENY_403;
    }
    return ALLOW;
  }

  if (policy.kind === 'employeeBoardInTree') {
    // Exists for GET /org-trees/:id only (D14). The tree id is read from the
    // same params the orgTree branch reads, so both branches of that route's
    // any(...) are talking about the same tree.
    const treeId = ctx.params.orgTreeId ?? ctx.params.treeId ?? ctx.params.id;
    if (!treeId) return DENY_403;
    if (!ctx.membership) return ctx.isAdmin ? ALLOW : DENY_403;
    const membership = ctx.membership;

    let rows: { role: BoardAccessRole }[];
    try {
      rows = await deps.prisma.employeeBoardAccess.findMany({
        where: {
          userId: ctx.user.id,
          employeeBoard: {
            orgTreeId: treeId,
            orgTree: { organizationId: membership.organizationId },
          },
        },
        select: { role: true },
      });
    } catch (err) {
      ctx.log?.error(err, `policy: failed to resolve boards in tree "${treeId}" — denying`);
      return DENY_403;
    }

    // ANY one board at or above the required role admits the caller to the
    // shell. The shell then renders only what they can reach.
    const reachable = rows.some((r) =>
      meetsBoardRole(effectiveBoardRole(membership.role, r.role), policy.role),
    );
    return reachable ? ALLOW : DENY_403;
  }

  if (policy.kind === 'roadmap') {
    const roadmapId = entityId(ctx.params, 'roadmapId', 'id');
    if (!roadmapId) return DENY_403;

    // No membership: the break-glass path, mirroring every other kind. There is
    // no organization to scope the roadmap to and no org role to impose a
    // ceiling with, so the grant row decides alone.
    if (!ctx.membership) {
      if (ctx.isAdmin) return ALLOW;
      let grant: { role: RoadmapAccessRole } | null;
      try {
        grant = await deps.prisma.roadmapAccess.findUnique({
          where: { roadmapId_userId: { roadmapId, userId: ctx.user.id } },
          select: { role: true },
        });
      } catch (err) {
        ctx.log?.error(err, `policy: failed to check roadmap access for roadmap "${roadmapId}" — denying`);
        return DENY_403;
      }
      return grant && RANK[grant.role] >= RANK[policy.role] ? ALLOW : DENY_403;
    }

    // BOTH halves of the ceiling now apply here.
    //
    // Phase A could only give this branch the CAPPING half. The other half —
    // an org ADMIN is an implicit OWNER — could not take effect while
    // `roadmaps/roadmap-access.middleware.ts` sat in front of every
    // `/roadmaps/:id*` route as a raw-grant `preHandler`: it ran AFTER the
    // policy and 403'd exactly the caller the ceiling had just admitted. Phase D
    // deletes that middleware, so this branch is now the only thing those routes
    // rely on.
    //
    // The tenancy predicate arrives with it, bringing roadmaps to parity with
    // `board` and `orgTree`: the roadmap is read THROUGH the caller's
    // organization, so a nonexistent roadmap and another tenant's roadmap are
    // indistinguishable and the gate never confirms a foreign id exists.
    // `Roadmap.organizationId` is required and indexed, and the same query
    // carries the caller's grant row — so this costs no extra round trip.
    //
    // RoadmapAccessRole and BoardAccessRole have identical members (design §7.2),
    // so the grant passes straight to effectiveBoardRole with no enum migration.
    // Do not "simplify" this to a cast that would also swallow a real divergence.
    let scoped: { accessEntries: { role: RoadmapAccessRole }[] } | null;
    try {
      scoped = await deps.prisma.roadmap.findFirst({
        where: { id: roadmapId, organizationId: ctx.membership.organizationId },
        select: { accessEntries: { where: { userId: ctx.user.id }, select: { role: true } } },
      });
    } catch (err) {
      // Same fail-closed contract as every other kind: a malformed `:id` reaches
      // Prisma before the route's own Zod validation and must deny, not 500.
      ctx.log?.error(
        err,
        `policy: failed to resolve roadmap "${roadmapId}" within the caller's organization — denying`,
      );
      return DENY_403;
    }
    if (!scoped) return DENY_403;

    const effective = effectiveBoardRole(ctx.membership.role, scoped.accessEntries[0]?.role ?? null);
    return meetsBoardRole(effective, policy.role) ? ALLOW : DENY_403;
  }

  if (policy.kind === 'comparison') {
    // Comparisons have a real per-user ACL as of design D15 — `ComparisonAccess`.
    // `Comparison.createdBy` is provenance from here on: the backfill wrote every
    // existing creator in as an OWNER, and `POST /comparisons` writes one for
    // every new comparison, so creating and being able to see stay aligned
    // without `createdBy` being a gate.
    const comparisonId = entityId(ctx.params, 'comparisonId', 'id');
    if (!comparisonId) return DENY_403;
    return (await hasComparisonRole(deps.prisma, comparisonId, ctx, policy.role)) ? ALLOW : DENY_403;
  }

  if (policy.kind === 'any') {
    // Same footgun as `all()` below: an empty list would run zero iterations and
    // fall through, i.e. `any()` would be a vacuous-truth grant rather than a
    // deny. Guard it explicitly rather than trusting every call site.
    if (policy.policies.length === 0) return DENY_403;
    let denial: PolicyDenial = DENY_403;
    for (const p of policy.policies) {
      const result = await evaluatePolicy(deps, p, ctx);
      if (result.ok) return ALLOW;
      // Keep the most specific denial seen. DENY_403's error is the generic
      // 'Forbidden'; anything else names a cause. The FIRST specific reason is
      // kept — a later one does not overwrite it, so the answer stays stable
      // as branches are added.
      if (denial.error === DENY_403.error && result.error !== DENY_403.error) {
        denial = result;
      }
    }
    return denial;
  }

  if (policy.kind === 'all') {
    // An empty list is a footgun: the loop below would run zero iterations
    // and fall through to ALLOW, i.e. `all()` would be a vacuous-truth grant
    // rather than a deny. Guard it explicitly rather than trusting every call
    // site to always pass at least one policy.
    if (policy.policies.length === 0) return DENY_403;
    for (const p of policy.policies) {
      const result = await evaluatePolicy(deps, p, ctx);
      if (!result.ok) return result;
    }
    return ALLOW;
  }

  // Exhaustiveness guard: if a new Policy kind is added without a branch above,
  // `policy` narrows to `never` here and this line fails to compile.
  const exhaustive: never = policy;
  throw new Error(`Unhandled policy kind: ${(exhaustive as Policy).kind}`);
}

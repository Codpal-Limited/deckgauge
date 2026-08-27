import type { PrismaClient, BoardAccessRole, RoadmapAccessRole } from '@deckgauge/db';
import type { OrgRoleValue } from '@deckgauge/shared';
import { ROLE_RANK as RANK } from './board-access.js';
import { effectiveBoardRole, personalBoardRole, meetsBoardRole, meetsOrgRole } from '../authz/policy.js';
import { multiOrgOperatorEnabled } from './multi-org-flag.js';

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
 *
 * **There is deliberately no "needs nothing beyond being signed in" arm.** Every
 * arm here either contributes a board id for the `board` branch's loop to check,
 * or performs its own equivalent check before contributing none (`orgEntity` via
 * `hasOrgTreeRole`, `comparisonAccess` via `hasComparisonRole`). An arm that did
 * neither would produce an ALLOW backed by nothing: it leaves the resolved set
 * empty, which is truthy, so the `board` branch's per-id loop — and every tenancy
 * gate inside it — runs zero times. That shape is the one that hid two live
 * cross-tenant holes through two review passes (see `resolveBoardIds`).
 *
 * A route where being signed in really is enough declares the `authenticated`
 * POLICY, where a reviewer reads it. A route where only ONE request shape needs
 * that is asking for an unbacked ALLOW on that shape and must say so at the
 * route, not bury it inside a board source. `then:
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
 * whenever an arm's ids name a row that some org tree owns.
 */
export type BoardBranch =
  | { when: IdExtractor; then: SubEntityModel }
  | { when: IdExtractor; then: 'boardId' }
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

export type PolicyDenial = { ok: false; status: 401 | 403 | 404; error: string };
export type PolicyResult = { ok: true } | PolicyDenial;

const DENY_401: PolicyResult = { ok: false, status: 401, error: 'Authentication required' };
const DENY_403: PolicyDenial = { ok: false, status: 403, error: 'Forbidden' };
/**
 * The entity is not in the caller's organization, or does not exist — and those
 * two are deliberately the same answer (tenancy D7): a gate that distinguished
 * them would confirm that another tenant's id exists.
 *
 * Settled in multi-org slice 6b. D7 asked for 404 on every cross-tenant read;
 * the evaluator answered 403 everywhere. The resolution is a SPLIT, not either
 * document's blanket rule: 404 when the entity is out of reach, 403 when it is
 * yours and you merely lack the role. That distinction is why the web can still
 * tell an in-organization caller "ask an owner to share it" instead of showing
 * them a bare 404 — the common case keeps its explanation, and only the
 * cross-tenant case hides.
 */
const DENY_404: PolicyDenial = { ok: false, status: 404, error: 'Not found' };
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
 * VIEWER however generous the grant row is.
 *
 * The instance-level break-glass (`ctx.isAdmin`) does **not** short-circuit this
 * lookup. It used to, when there was no membership to consult, and that was §4.1
 * hole 3's second door — closed 2026-08-26. A membership-less caller needs a real
 * `OrgTreeAccess` row here; recovery for a locked-out operator is bootstrap-adopt.
 * Do not reintroduce the short-circuit: see the note in the body.
 *
 * And with no membership the grant row is not enough EITHER, once the operator has
 * declared the deployment multi-tenant — §4.1 hole 2, gated in the body below.
 * Both holes had a door at this function, and the hole-2 one is not covered by the
 * `board` branch's gate: neither caller of this function contributes a board id, so
 * that branch's id loop (which is where its gate lives) never runs. Do not remove
 * the `multiOrgOperatorEnabled()` check on the assumption something downstream
 * re-checks it. Nothing does.
 *
 * Like the evaluator branch, this verifies `orgTreeId`'s own `organizationId`
 * against the caller's, by reading the tree THROUGH `ctx.membership.organizationId`
 * and denying when it does not resolve. That closes what this comment used to
 * defer as a `DECKGAUGE_MULTI_ORG=true` precondition.
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
  // §4.1 hole 3, second door. `if (!ctx.membership && ctx.isAdmin) return true`
  // used to sit here, and leaving it while closing the `orgTree` evaluator branch
  // would have closed one door onto the same room: this function is the org-tree
  // check reached from INSIDE board-source resolution (the `upload` read hop and
  // the `then: 'orgEntity'` branch arm), and the `orgEntity` arm's own comment
  // records that it contributes no board ids and is therefore the ONLY check that
  // happens. An instance break-glass admin would have kept OWNER-equivalence on
  // every tenant's employee data through `POST /api/uploads?orgEmployeeId=`.
  //
  // So both are removed together, for the same reason and with the same recovery
  // path (bootstrap-adopt — see the `orgTree` branch in `evaluatePolicy`). A
  // membership-less caller now needs a real `OrgTreeAccess` row here, which is the
  // no-membership rule the tail of this function already applied to non-admins.
  // §4.1 hole 2, the SIXTH site — and the one genuinely NOT shadowed by the `board`
  // branch's gate, which is why it needs its own.
  //
  // `hasOrgTreeRole` is reached from exactly two places and NEITHER contributes a
  // board id: the `upload` read hop returns `ORG_OK`, which `applyResolved` skips,
  // and the `then: 'orgEntity'` arm `break`s without adding anything. So
  // `resolveBoardIds` answers `[]`; an empty array is truthy so `if (!boardIds)`
  // does not fire, the id loop runs zero times, and the `board` branch returns
  // ALLOW — with its hole-2 gate sitting INSIDE that loop, never executed. That is
  // the same argument used to justify closing hole 3 at this function and at
  // `hasComparisonRole`, applied to hole 2.
  //
  // The reachable case composes with the residual recorded in `planning/STATE.md`:
  // a user offboarded BEFORE the revoke shipped has no membership and a live
  // `OrgTreeAccess` row, so under `DECKGAUGE_MULTI_ORG=true` they would reach
  // another tenant's employee data through `POST /api/uploads?orgEmployeeId=`.
  // Every other kind denies them; without this line, this one did not.
  //
  // Placed BEFORE the reads, mirroring `hasComparisonRole`: the verdict needs
  // neither the tree nor the grant, so a flag-on membership-less caller should not
  // pay for either query. `false` is this function's only failure channel, so the
  // verdict is a 403 — a foreign tree and a missing one still answer identically,
  // so no existence oracle is created.
  if (!ctx.membership && multiOrgOperatorEnabled()) return false;

  try {
    /**
     * The tree is read THROUGH the caller's organization, for the same reason and
     * at the same cost as the `orgTree` evaluator branch below: every id reaching
     * here came from route params, query, or a sub-entity hop, so it may name a
     * tree in ANY tenant. `OrgTree.organizationId` is required and
     * `@@index([organizationId])` covers the predicate (see
     * packages/db/prisma/schema.prisma), so this is a covered lookup issued in
     * parallel with the grant read — no added round trip on the wire.
     *
     * This is what the docstring above used to defer, and it is load-bearing:
     * `effectiveBoardRole` short-circuits an org ADMIN to OWNER with NO grant
     * row, so without this read an administrator of ANY organization was
     * OWNER-equivalent on EVERY org tree. The `upload` read hop was at least
     * re-checked by the board read downstream; the `then: 'orgEntity'` arm never
     * was, and its own comment states outright that it contributes no board ids
     * and is therefore the only check that happens.
     *
     * Resolving WITH the predicate (rather than fetching the tree and comparing
     * afterwards) also keeps a nonexistent tree and a foreign tree
     * indistinguishable — the gate never confirms another tenant's id exists.
     */
    const [tree, access] = await Promise.all([
      ctx.membership
        ? prisma.orgTree.findFirst({
            where: { id: orgTreeId, organizationId: ctx.membership.organizationId },
            select: { id: true },
          })
        : Promise.resolve(null),
      prisma.orgTreeAccess.findUnique({
        where: { orgTreeId_userId: { orgTreeId, userId: ctx.user.id } },
      }) as Promise<{ role: BoardAccessRole } | null>,
    ]);
    if (ctx.membership) {
      // Out of reach, not merely insufficient: a tree in another tenant is
      // indistinguishable from one that does not exist. Both callers collapse
      // this `false` into board-source resolution's single failure channel, so
      // the verdict is a 403 either way — a foreign tree and a missing one still
      // answer identically, which is what D7 actually requires.
      if (!tree) return false;
      const effective = effectiveBoardRole(ctx.membership.role, access?.role ?? null);
      return meetsBoardRole(effective, requiredRole);
    }
    // Single-tenant: the no-membership path is unchanged, and deliberately so — it
    // is the pre-bootstrap identity `bootstrap:admin` produces. There is no
    // organization to scope the tree to, so the grant row decides alone — and it
    // must be a REAL grant, never an implicit role (the instance break-glass
    // short-circuit that used to sit above this was hole 3, closed 2026-08-26).
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
/**
 * `'out-of-reach'` means the comparison is not in the caller's organization, does
 * not exist, or could not be read — one answer for all three, deliberately
 * (tenancy D7). `'insufficient'` means it IS theirs and they merely lack the
 * role. The `comparison` policy branch maps the first to 404 and the second to
 * 403; the `comparisonAccess` board-branch arm cannot express that distinction
 * and refuses either way (see its comment).
 */
type ComparisonRoleOutcome = 'allowed' | 'insufficient' | 'out-of-reach';

async function hasComparisonRole(
  prisma: PrismaClient,
  comparisonId: string,
  ctx: PolicyContext,
  requiredRole: BoardAccessRole,
): Promise<ComparisonRoleOutcome> {
  if (!ctx.user) return 'out-of-reach';
  try {
    if (!ctx.membership) {
      // §4.1 hole 3, third door — and structurally the WORST of the six, which is
      // why it is closed even though the design names only the `orgTree` one.
      // `if (ctx.isAdmin) return 'allowed'` used to stand here.
      //
      // This function is reached from the `then: 'comparisonAccess'` arm of
      // board-source resolution, and that arm `break`s WITHOUT contributing any
      // board id (see `resolveBoardIds`). So the board branch's id loop never
      // runs and `evaluatePolicy` returns ALLOW on an empty set — nothing
      // downstream re-checks this verdict. Exactly the shape of the
      // `then: 'orgEntity'` arm, and `Comparison` carries `organization_id`, so
      // this is tenant data reached by an instance role bit with no grant row
      // behind it.
      //
      // §4.1 hole 2, same shape as the board branch: with no membership the grant
      // would decide alone. Gated on the operator's declared mode for the reasons
      // set out in full on the `board` branch of `evaluatePolicy`.
      if (multiOrgOperatorEnabled()) return 'insufficient';
      const grant = await prisma.comparisonAccess.findUnique({
        where: { comparisonId_userId: { comparisonId, userId: ctx.user.id } },
        select: { role: true },
      });
      // With no membership there is NO organization, so nothing can be
      // cross-tenant and nothing is out of reach: a missing grant here is
      // plainly "you do not have access" — 403. This mirrors the other four
      // kinds, whose no-membership paths also answer 403 because they read the
      // ACL row directly and never reach a `!scoped` check.
      if (!grant) return 'insufficient';
      return RANK[grant.role] >= RANK[requiredRole] ? 'allowed' : 'insufficient';
    }
    const scoped = await prisma.comparison.findFirst({
      where: { id: comparisonId, organizationId: ctx.membership.organizationId },
      select: { access: { where: { userId: ctx.user.id }, select: { role: true } } },
    });
    if (!scoped) return 'out-of-reach';
    return meetsBoardRole(
      effectiveBoardRole(ctx.membership.role, scoped.access[0]?.role ?? null),
      requiredRole,
    )
      ? 'allowed'
      : 'insufficient';
  } catch (err) {
    ctx.log?.error(err, `policy: failed to resolve comparison access for id "${comparisonId}" — denying`);
    return 'out-of-reach';
  }
}

/**
 * Resolves a `board` policy's source(s) to the distinct set of board ids the
 * requester must hold the required role on. Returns `undefined` — meaning
 * "deny" — when no source is configured and no param carries a board id
 * directly, when the source LIST is empty, when an extractor finds nothing,
 * when no `branch` arm matches, or when any extracted id fails to resolve to
 * a board. A missing/unresolvable id never falls through to "no board
 * required"; it always denies. An empty (but non-`undefined`) result is
 * legitimate — it means every source resolved and none of them needed a
 * board (every id resolved to `ORG_OK`, or a `branch` arm matched
 * `then: 'comparisonAccess'` and every extracted id passed its access check)
 * — the caller allows outright in that case.
 *
 * ---
 * **The "contributes nothing, so the board branch ALLOWs on an empty set" shape —
 * read this before adding an arm or a source.** An empty array is TRUTHY, so
 * `evaluatePolicy`'s `if (!boardIds)` does not fire, its per-id loop runs zero
 * times, and everything living inside that loop — notably its §4.1 hole-2 tenancy
 * gate — never executes. Whatever check the arm itself performs is therefore the
 * ONLY check that happens on such a path, and this is not theoretical: it is how
 * `hasOrgTreeRole` and `hasComparisonRole` hid two LIVE cross-tenant holes through
 * two review passes that each declared the class closed.
 *
 * **The rule, which is the thing to keep rather than the list:** every construct
 * that can leave the resolved set empty must either do its own check, or refuse.
 * There is no third option, because nothing downstream re-checks it.
 *
 * Three constructs are allowed to contribute nothing, and each does its own check:
 *
 *   1. `ORG_OK` from the `upload` read hop — gated inside `hasOrgTreeRole`.
 *   2. `then: 'orgEntity'` — gated inside `hasOrgTreeRole`.
 *   3. `then: 'comparisonAccess'` — gated inside `hasComparisonRole`.
 *
 * Two more used to be able to, and both now REFUSE instead:
 *
 *   4. `then: 'authenticated'` — removed from `BoardBranch` (so it no longer
 *      compiles) and refused at runtime by the unrecognised-`then` guard below (so
 *      a cast cannot restore it). A guard was not expressible: any check strong
 *      enough to make the arm safe is what a board-bearing arm already does, at
 *      which point it is not an "authenticated" arm. See `BoardBranch`.
 *   5. `board(role, [])` — an empty source LIST, refused by the guard below.
 *      The `orgTree` branch denies on `length === 0` at the evaluator; this branch
 *      cannot, because an empty RESOLVED set is legitimate here (cases 1-3). So
 *      the guard sits on the source list instead, which is the only place the two
 *      cases are still distinguishable.
 *
 * Neither 4 nor 5 had a production call site when they were closed. They were
 * closed anyway: an unreachable construct with the shape of a live hole is a
 * loaded gun, and "it was never reachable" is the argument that deletes a guard
 * later. Pinned in `__isolation__/policy-cross-tenant.test.ts`.
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
  // An empty source LIST is not the same request as no source at all, and it must
  // not be treated as one. `board(role, [])` skips the `!source` default above
  // (an empty array is truthy), then contributes nothing here, and an empty
  // resolved set means ALLOW to the caller — so the policy would admit every
  // signed-in caller at any role, in any tenant, having checked nothing.
  //
  // Refused here rather than at the evaluator, where the `orgTree` branch's
  // equivalent `length === 0` guard lives, because the `board` branch cannot use
  // that position: an empty RESOLVED set is legitimate for it (see this
  // function's docstring, cases 1-3). The source list is the last point at which
  // "nothing was asked for" and "everything asked for needed no board" are still
  // distinguishable.
  if (sources.length === 0) return undefined;

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
    // wins; its ids are then resolved and checked. No arm matching denies — it
    // never falls through to a weaker check. Whichever arm commits, a failed
    // check inside it denies outright — it never tries a later arm instead.
    let matched = false;
    for (const arm of s.branches) {
      const armIds = arm.when(ctx);
      if (!armIds || armIds.length === 0) continue;
      matched = true;
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
        //
        // This arm refuses out-of-reach and insufficient identically, because
        // board-source resolution has only one failure channel (`undefined`)
        // and the board branch maps that to 403. That is NOT a D7 leak: a
        // foreign comparison and a nonexistent one still answer the same 403 as
        // each other, so nothing about existence is confirmed. The only thing
        // lost on this one route is the 404's clearer shape, and threading a
        // denial reason through board-source resolution to recover it would be
        // out of proportion to that.
        const outcomes = await Promise.all(armIds.map((id) => hasComparisonRole(prisma, id, ctx, 'VIEWER')));
        if (outcomes.some((o) => o !== 'allowed')) return undefined;
        break;
      }
      // Everything remaining must be a `SubEntityModel`, and that is CHECKED
      // rather than assumed. The type says so, but this arm is the tail of a
      // discriminated union whose narrowing is exactly what a `BoardBranch` cast
      // defeats — and `then: 'authenticated'`, which used to `break` here having
      // contributed nothing, is precisely the value a cast would carry.
      //
      // Refusing an unrecognised discriminator is what makes "an ALLOW out of the
      // board branch is backed by a check that actually ran" hold for values the
      // type does not admit, not only for the ones it does. Deny, never `break`:
      // `break`ing leaves the arm MATCHED with no ids and no check, which is the
      // unbacked ALLOW itself; and `continue`ing would hand the decision to a
      // later, possibly weaker arm, which `viaBranch`'s first-match-wins contract
      // forbids.
      //
      // Not relying on the TypeError a bogus `prisma[model]` lookup would throw
      // inside `resolveBoardId`: that also denies today, but as an accident of a
      // catch block rather than a stated rule, and it would stop denying the
      // moment a `then` value collided with a real Prisma delegate name.
      //
      // `Object.hasOwn`, NOT `in`, and the first version of this guard got that
      // wrong in a way worth recording: `in` walks the prototype chain, so
      // `'constructor'`, `'toString'`, `'valueOf'`, `'__proto__'`,
      // `'hasOwnProperty'` and `'isPrototypeOf'` all satisfied it and fell
      // through to `resolveBoardId` — where the delegate lookup throws and the
      // catch denies. The verdict was right, but by exactly the accident the
      // paragraph above disclaims, so the stated invariant held only for the
      // values spelled in the union. `hasOwn` consults own keys only, which makes
      // it true for ALL values.
      if (!Object.hasOwn(SUB_ENTITY_PATH, arm.then)) {
        ctx.log?.error(
          { then: arm.then },
          'policy: board branch arm carries an unrecognised `then` — denying',
        );
        return undefined;
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
        if (!scoped) return DENY_404;
        const effective = effectiveBoardRole(ctx.membership.role, scoped.accessEntries[0]?.role ?? null);
        if (!meetsBoardRole(effective, policy.role)) return DENY_403;
        continue;
      }

      // §4.1 hole 2. With no membership there is no organization role to impose
      // a ceiling with and no tenant to scope the board to, so the grant row
      // would decide alone. Under pooling that is a cross-tenant hole: a grant
      // may NARROW reach inside a tenant, it must never ESTABLISH reach into one.
      //
      // Gated rather than unconditional, and the reasoning matters because the
      // obvious reading — "deny always, it is a hole" — is wrong here:
      //
      //   - the ALLOW is backed by a real `BoardAccess` row that somebody
      //     deliberately created. Denying on it changes the answer for data that
      //     legitimately looks like this in a single-tenant install, which is not
      //     the same kind of claim as hole 3's, where an instance role bit
      //     conferred OWNER with no row behind it at all (that one IS
      //     unconditional, below).
      //   - the reachable ALLOW in a single-tenant deployment came from
      //     OFFBOARDING, and that is now closed where it actually lives — in the
      //     data. `MembershipService.remove` revokes every grant the departing
      //     member held in the organization (`access/revoke-grants.ts`). Denying
      //     here as well would be belt-and-braces for pooling, not the fix for
      //     single-tenant.
      //   - the tenancy migration (20260813000000_org_tenancy) gave EVERY
      //     existing user an ACTIVE membership, so the remaining membership-less
      //     callers are pre-bootstrap operators and unbound invitees — neither of
      //     whom holds a board grant to be admitted on.
      //
      // So the deny follows the operator's declared mode. `multiOrgOperatorEnabled`
      // documents why the env half is the safe half to read here.
      if (multiOrgOperatorEnabled()) return DENY_403;

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
        if (!scoped) return DENY_404;
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

    // §4.1 hole 3 — CLOSED here. This is where a bare `if (ctx.isAdmin) return
    // ALLOW` used to sit, ahead of the grant loop.
    //
    // `ctx.isAdmin` is the union of three sources (see the auth plugin) and only
    // one of them, an ADMIN membership, is organization-scoped. `auth/fastify.d.ts`
    // states the rule outright: it "must never be used to answer 'is this caller
    // an admin of THIS organization'" — which is exactly what the override did.
    // With no membership, the membership source is by definition absent, so only
    // the two INSTANCE-level signals can be behind it: the `users.is_admin`
    // bootstrap flag and the Keycloak realm role. Neither is scoped to a tenant,
    // so the override read as "admin of every organization at once" — a master
    // key over every tenant's org trees, their timesheet views, and their
    // employee data, conferred by a role bit with no grant row behind it.
    //
    // Removed UNCONDITIONALLY, not gated on the multi-org flag like the board
    // fallback above, because the design's own instruction is to confine
    // break-glass to operations that touch no tenant data, and an org tree is
    // tenant data. `orgRole` is the precedent the design names: it already
    // ignores `ctx.isAdmin` for exactly this reason.
    //
    // **The lockout this override existed to prevent is covered without it**, and
    // that was checked against the code rather than assumed.
    // `OrganizationService.bootstrap` has three outcomes, and the middle one is
    // the recovery path: an organization with NO living ADMIN (role ADMIN, status
    // ACTIVE, `userId` bound) is ADOPTED by the caller, who becomes its ACTIVE
    // ADMIN. So a break-glass operator recovers by
    //   `bootstrap:admin --email …` → log in → bootstrap,
    // which creates organization #1 if there is none and adopts an admin-less one
    // if there is. Bootstrap is gated on the same realm admin role this override
    // was, and creates a tenant rather than reading one — precisely "an operation
    // that touches no tenant data". Once they hold the ADMIN membership, the
    // branch above gives them OWNER-equivalence on every tree in that
    // organization, which is what the override was approximating.
    //
    // The one case that now denies where it previously allowed: an operator with
    // no membership facing an organization that DOES have a living admin. That is
    // not a lockout — there is, by construction, an administrator who can invite
    // them — and it is the case where the override was reading another tenant's
    // employee data on the strength of an instance role bit.

    // §4.1 hole 2 for org trees, the same gate as the board branch. The invariant
    // is kind-agnostic — a grant may NARROW reach inside a tenant, it must never
    // ESTABLISH reach into one — so it is enforced at all SIX sites that decide on
    // a bare grant with no membership, not only the one the design names: the five
    // policy branches (`board`, `orgTree`, `comparison`, `employeeBoard`,
    // `roadmap`) plus `hasOrgTreeRole`, which is reached from board-source
    // resolution and is NOT covered by the `board` branch's own gate.
    // `employeeBoardInTree` needs none — it never had a no-membership grant path.
    if (multiOrgOperatorEnabled()) return DENY_403;

    // No membership, not break-glass, and single-tenant: the grant row decides
    // alone, exactly as it did before tenancy existed. There is no organization to
    // scope the tree to — and it must NOT fall through
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
        // §4.1 hole 3, fourth door. `if (ctx.isAdmin) return ALLOW` used to stand
        // here, and closing `hasOrgTreeRole` while leaving this would have been
        // incoherent: the justification there is that an instance admin must not
        // keep "OWNER-equivalence on every tenant's employee data", and an
        // employee board IS that data.
        //
        // §4.1 hole 2, same gate as the board branch.
        if (multiOrgOperatorEnabled()) return DENY_403;
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
        isPersonal: boolean;
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
            // Read in the SAME query as the grants: whether the board is personal
            // decides which of them count, so a second lookup would be a second
            // chance to disagree.
            isPersonal: true,
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
      if (!scoped) return DENY_404;

      // D12's second implicit-owner rule. An OWNER grant on the PARENT TREE
      // makes the caller an OWNER of every board in it — that is what stops an
      // org-tree owner creating a board they then cannot open, and it is why the
      // tree's grant is read here rather than the tree gate being kept. OWNER
      // specifically: a tree EDITOR gets nothing, which IS the separation D12
      // exists to create. The first rule (org ADMIN -> OWNER) is inside
      // `effectiveBoardRole`.
      const treeGrant = scoped.orgTree.access[0]?.role ?? null;
      const boardGrant = scoped.access[0]?.role ?? null;

      // A PERSONAL board is exempt from BOTH implicit rules (org-tree privacy
      // D5): the tree grant is ignored, and `personalBoardRole` is
      // `effectiveBoardRole` without the org-ADMIN floor. The board's own grant
      // alone decides — which is why `createBoard` stamps its creator OWNER, or
      // a personal board would be openable by nobody.
      //
      // Exempting only one of the two rules would be worse than exempting
      // neither: the board would read as private while staying readable.
      const effective = scoped.isPersonal
        ? personalBoardRole(ctx.membership.role, boardGrant)
        : effectiveBoardRole(ctx.membership.role, treeGrant === 'OWNER' ? 'OWNER' : boardGrant);
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
    // §4.1 hole 3, fifth door. Was `return ctx.isAdmin ? ALLOW : DENY_403`.
    //
    // Unlike the other four kinds this branch never had a no-membership GRANT
    // path — the admin override was the only way through it without a membership
    // — so removing the override leaves a plain deny and cannot brick a legacy
    // grant holder. It is therefore ungated: there is no pre-tenancy behaviour
    // here for the multi-org flag to preserve.
    //
    // The asymmetry with the `employeeBoard` branch (which does keep a
    // no-membership grant path) predates this change and is left as it was: this
    // branch gates the org-tree SHELL for GET /org-trees/:id (D14), and it reads
    // reachability through `membership.organizationId`, so with no membership
    // there is nothing to scope the query to in the first place.
    if (!ctx.membership) return DENY_403;
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
      // §4.1 hole 3, sixth door. `if (ctx.isAdmin) return ALLOW` used to stand
      // here. `Roadmap` carries `organization_id`; it is tenant data, so the same
      // reasoning applies as to org trees and employee boards.
      //
      // §4.1 hole 2, same gate as the board branch.
      if (multiOrgOperatorEnabled()) return DENY_403;
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
    if (!scoped) return DENY_404;

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
    const outcome = await hasComparisonRole(deps.prisma, comparisonId, ctx, policy.role);
    if (outcome === 'allowed') return ALLOW;
    // 404 for out-of-reach, 403 for "yours, but not at this tier" — slice 6b.
    return outcome === 'out-of-reach' ? DENY_404 : DENY_403;
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

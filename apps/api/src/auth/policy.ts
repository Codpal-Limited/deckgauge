import type { PrismaClient, BoardAccessRole } from '@deckgauge/db';
import { ROLE_RANK as RANK } from './board-access.js';

export type ConnectionModel = 'jiraInstance' | 'gitHubInstance' | 'azureDevOpsInstance' | 'gitLabInstance';

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
 * one arm's ids are literal board ids). `then: 'comparisonCreator'` means
 * the extracted value(s) are Comparison ids and the caller must be each
 * one's creator — no board is involved at all, mirroring how the
 * `comparison` policy kind checks `Comparison.createdBy` (see
 * `isComparisonCreator`, shared by both).
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
  | { when: IdExtractor; then: 'comparisonCreator' }
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

/**
 * What an *unclaimed* connection (`created_by_id IS NULL`, the state every row
 * is in right after the upgrade that introduced ownership) may be used for.
 *
 *   - omitted   — any signed-in user may act; the act claims the row. This is
 *                 claim-on-first-edit, and it is the intended model.
 *   - 'deny'    — refuse outright until someone claims the row with an edit
 *                 that isn't this one.
 *   - `{ bodyFields }` — refuse if the body carries any of these fields.
 *
 * The last two exist because two operations are not safely open to "whoever
 * gets there first, anonymously": deleting a connection cascades away the
 * source configuration of *every board* using it, and repointing its host URL
 * while keeping the stored credential turns the next discovery call into
 * credential exfiltration. Requiring a prior, non-destructive claim doesn't
 * change who may ultimately do those things — it makes sure a named owner
 * exists first, and that everyone else has lost the blanket power by then.
 */
export type UnclaimedGuard = 'deny' | { bodyFields: readonly string[] };

export type Policy =
  | { kind: 'public' }
  | { kind: 'authenticated' }
  | { kind: 'board'; role: BoardAccessRole; source?: BoardSource | BoardSource[] }
  | { kind: 'roadmap'; role: BoardAccessRole }
  | { kind: 'orgTree'; role: BoardAccessRole; source?: OrgTreeSource | OrgTreeSource[] }
  | { kind: 'comparison' }
  | { kind: 'connectionOwner'; unclaimed?: UnclaimedGuard }
  | { kind: 'analytics' }
  | { kind: 'admin' }
  | { kind: 'all'; policies: Policy[] };

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
export const CONNECTION_OWNER: Policy = { kind: 'connectionOwner' };
/** For destructive routes — see `UnclaimedGuard`. Use on connection deletes. */
export const CONNECTION_OWNER_CLAIMED: Policy = { kind: 'connectionOwner', unclaimed: 'deny' };
/**
 * For a connection edit that may carry a host/URL change: the edit is allowed
 * on an unclaimed row (and claims it) *unless* it names one of `bodyFields`.
 */
export const connectionOwnerProtectingFields = (bodyFields: readonly string[]): Policy => ({
  kind: 'connectionOwner',
  unclaimed: { bodyFields },
});
export const COMPARISON_CREATOR: Policy = { kind: 'comparison' };
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
 * Every listed policy must pass. Evaluated in order; the FIRST denial is
 * returned, so a 401 from an unauthenticated caller still wins over a 403.
 * Use when a route needs two independent grants — e.g. the analytics realm
 * role AND access to the org tree named in the request.
 */
export const all = (...policies: Policy[]): Policy => ({ kind: 'all', policies });

export interface PolicyDeps {
  prisma: PrismaClient;
  singleUser: boolean;
}

export interface PolicyContext {
  user: { id: string } | null;
  params: Record<string, string | undefined>;
  query?: Record<string, string | undefined>;
  body?: unknown;
  /** Which connection table a connectionOwner policy should read. Set per route. */
  connectionModel?: ConnectionModel;
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
}

export type PolicyResult = { ok: true } | { ok: false; status: 401 | 403; error: string };

const DENY_401: PolicyResult = { ok: false, status: 401, error: 'Authentication required' };
const DENY_403: PolicyResult = { ok: false, status: 403, error: 'Forbidden' };
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
 * An admin is OWNER-equivalent on every tree (admin-ness lives in Keycloak,
 * not in `OrgTreeAccess` rows — same rule as `evaluatePolicy`'s `orgTree`
 * branch), and short-circuits the lookup entirely.
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
  if (ctx.isAdmin) return true;
  try {
    const access: { role: BoardAccessRole } | null = await prisma.orgTreeAccess.findUnique({
      where: { orgTreeId_userId: { orgTreeId, userId: ctx.user.id } },
    });
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
 * Comparison access is creator-only — see the `comparison` policy kind's
 * comment for why (no per-user ACL table exists; `ComparisonMember` maps a
 * comparison to its boards, not to users). Shared by that policy kind and by
 * a `comparisonCreator` branch arm (`BoardBranch`) so both compare the same
 * field the same way instead of drifting. Returns `false` — never throws —
 * for a missing row or a lookup failure, same fail-closed reasoning as
 * `resolveBoardId`.
 */
async function isComparisonCreator(
  prisma: PrismaClient,
  comparisonId: string,
  userId: string,
  ctx: PolicyContext,
): Promise<boolean> {
  try {
    const row = await prisma.comparison.findUnique({ where: { id: comparisonId } });
    return row?.createdBy === userId;
  } catch (err) {
    ctx.log?.error(err, `policy: failed to resolve comparison creator for id "${comparisonId}" — denying`);
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
 * `branch` arm matched `then: 'comparisonCreator'` and every extracted id
 * passed its creator check) — the caller allows outright in that case.
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
      if (arm.then === 'comparisonCreator') {
        // Defensive only: `evaluatePolicy` never calls into board-source
        // resolution for an unauthenticated caller, so `ctx.user` is always
        // set by the time a branch is evaluated. Treat the (unreachable in
        // practice) alternative as deny, not a crash.
        if (!ctx.user) return undefined;
        const userId = ctx.user.id;
        const isCreator = await Promise.all(armIds.map((id) => isComparisonCreator(prisma, id, userId, ctx)));
        if (isCreator.some((ok) => !ok)) return undefined;
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
      let access: { role: BoardAccessRole } | null;
      try {
        access = await deps.prisma.boardAccess.findUnique({
          where: { boardId_userId: { boardId, userId: ctx.user.id } },
        });
      } catch (err) {
        // Same fail-closed reasoning as resolveBoardId: a `boardId` sourced
        // straight from a literal (viaBoardId) never passes through Prisma
        // validation before reaching here, so a malformed value must deny,
        // not 500.
        ctx.log?.error(err, `policy: failed to check board access for board "${boardId}" — denying`);
        return DENY_403;
      }
      if (!access || RANK[access.role] < RANK[policy.role]) return DENY_403;
    }
    return ALLOW;
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

    // An admin is OWNER-equivalent on every tree. Admin-ness comes from either a
    // Keycloak realm role or the `users.is_admin` bootstrap flag, and neither is
    // per-tree, so it cannot be expressed as backfilled access rows — it is an
    // evaluator rule instead. This is what keeps existing deployments from
    // locking their operators out the moment the table ships empty.
    //
    // Deliberately scoped to org trees: the `board` branch above has no such
    // override, so an admin still needs a real BoardAccess row.
    if (ctx.isAdmin) return ALLOW;

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

  if (policy.kind === 'roadmap') {
    const roadmapId = entityId(ctx.params, 'roadmapId', 'id');
    if (!roadmapId) return DENY_403;
    let access: { role: BoardAccessRole } | null;
    try {
      access = await deps.prisma.roadmapAccess.findUnique({
        where: { roadmapId_userId: { roadmapId, userId: ctx.user.id } },
      });
    } catch (err) {
      // Same fail-closed contract as the other kinds: a malformed `:id` reaches
      // Prisma before the route's own Zod validation, and must deny, not 500.
      ctx.log?.error(err, `policy: failed to check roadmap access for roadmap "${roadmapId}" — denying`);
      return DENY_403;
    }
    return access && RANK[access.role] >= RANK[policy.role] ? ALLOW : DENY_403;
  }

  if (policy.kind === 'comparison') {
    // Comparison has no per-user ACL in the schema (see packages/db/prisma/schema.prisma,
    // model Comparison: "Owned by its creator ... kept lean like OrgTree (no per-entity
    // ACL / favorites)"). ComparisonMember is the comparison's ordered *board* set
    // (@@unique([comparisonId, boardId])), not a per-user membership table, so there is
    // no comparisonId_userId key to query. Access is creator-only: COMPARISON_CREATOR.
    const comparisonId = entityId(ctx.params, 'comparisonId', 'id');
    if (!comparisonId) return DENY_403;
    const isCreator = await isComparisonCreator(deps.prisma, comparisonId, ctx.user.id, ctx);
    return isCreator ? ALLOW : DENY_403;
  }

  if (policy.kind === 'connectionOwner') {
    const model = ctx.connectionModel;
    const connectionId = entityId(ctx.params, 'id', 'instanceId');
    if (!model || !connectionId) return DENY_403;

    let row: { createdById: string | null } | null;
    try {
      row = await (deps.prisma[model] as { findUnique: (a: unknown) => Promise<{ createdById: string | null } | null> })
        .findUnique({ where: { id: connectionId } });
    } catch (err) {
      // Same fail-closed contract as every other kind here: the id arrives
      // straight from route params, before the route's own Zod validation, so
      // a malformed one must deny rather than surface as a 500 from authz.
      ctx.log?.error(err, `policy: failed to load connection ${model} id "${connectionId}" — denying`);
      return DENY_403;
    }
    if (!row) return DENY_403;
    if (row.createdById === ctx.user.id) return ALLOW;
    if (row.createdById !== null) return DENY_403;

    // Unclaimed: claim-on-first-edit, narrowed for destructive shapes.
    if (!policy.unclaimed) return ALLOW;
    if (policy.unclaimed === 'deny') return DENY_403;
    const body = ctx.body as Record<string, unknown> | undefined;
    const touchesProtected = policy.unclaimed.bodyFields.some((f) => body?.[f] !== undefined);
    return touchesProtected ? DENY_403 : ALLOW;
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

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  CreateOrgTreeSchema,
  RenameOrgTreeSchema,
  OrgEmployeeAliasInputSchema,
  CreateEmployeeSchema,
  UpdateEmployeeProfileSchema,
  MoveEmployeeSchema,
  resolveEmployeeIdentities,
  CreateEmployeeCommentInputSchema,
  UpdateEmployeeCommentInputSchema,
  SaveOrgSourceInputSchema,
  SaveOrgSourceConnectionSchema,
} from '@deckgauge/shared';
import type { OrgTreeService } from './org-tree.service.js';
import { OrgTreeCycleError, OrgEmployeeForbiddenError, CrossTreeEmployeeError } from './org-tree.service.js';
import type { OrgSourceService } from './org-source.service.js';
import { parseOrgChartBuffer } from './org-chart-import.js';
import { EmployeeActivityService } from './employee-activity.service.js';
import { EmployeeCommentService } from './employee-comment.service.js';
import type { ClickHouseClient, PrismaClient } from '@deckgauge/db';
import type { Prisma } from '@deckgauge/db';
import type { UploadService } from '../uploads/upload.service.js';
import { AUTHENTICATED, ORG_MEMBER, orgTree, viaOrgEntity, fromParam, fromQueryCsv, parseCsvParam, any, employeeBoardInTree } from '../auth/policy.js';
import { accessibleOrgTreeIds, UNSCOPED_NO_MEMBERSHIP } from '../auth/board-access.js';
import { requireOrganizationId } from '../organizations/request-organization.js';

/**
 * Employee-scoped routes carry an employee id in `:id`, not a tree id — this
 * resolves it to the employee's org tree via `orgEmployee.orgTreeId`. Comment
 * routes deliberately do NOT use this; see their own policy for why.
 */
const VIA_EMPLOYEE = viaOrgEntity('orgEmployee', fromParam('id'));

export interface OrgTreeRoutesDeps {
  serviceFactory: () => OrgTreeService;
  enqueueSync: (treeId: string) => Promise<void>;
  enqueueSourceSync: (treeId: string) => Promise<void>;
  sourceService: OrgSourceService;
  clickhouse?: ClickHouseClient;
  prisma: PrismaClient;
  uploadService?: UploadService;
}

import { AccessService } from '../access/access.service.js';
import { canViewSalary } from './salary-visibility.js';
import {
  notifyCommentMentions,
  readPreviousCommentContent,
} from '../notifications/comment-mention-hook.js';
import { effectiveBoardRole } from '../authz/policy.js';

const uuid = z.string().uuid();

export function orgTreeRoutes(deps: OrgTreeRoutesDeps) {
  const service = deps.serviceFactory();
  const access = new AccessService(deps.prisma);
  return async function plugin(app: FastifyInstance) {
    /**
     * Built per request from the scoped reader, not once at boot from the ingest
     * singleton (tenancy §11 precondition 8). `deps.clickhouse` remains the
     * fallback only for callers that construct this plugin without the chRead
     * plugin registered, i.e. the unit tests.
     */
    const activityServiceFor = (req: FastifyRequest): EmployeeActivityService | null => {
      const client = req.chRead ?? deps.clickhouse;
      return client ? new EmployeeActivityService(client) : null;
    };
    const commentService = new EmployeeCommentService(deps.prisma, deps.uploadService);

    // No tree id lives on this request to check a declarative policy against —
    // the set of trees to check IS the response — so this stays AUTHENTICATED
    // and filters in the handler.
    //
    // Which means the TENANT filter has to be applied here too, because
    // `AUTHENTICATED` resolves no membership and so cannot apply one. It did not
    // used to be: the admin branch called `service.list()` with no argument,
    // which passes `where: undefined`, so an org ADMIN of one tenant was handed
    // every organization's trees — an instance role bit, a policy requiring no
    // membership, no grant consulted, and tenant data in the response.
    //
    // The branch is kept and SCOPED rather than removed. "An admin sees every
    // tree" is correct and intended; what was wrong is that "every tree" meant
    // every tree in the deployment instead of every tree in their organization.
    // This is `evaluatePolicy`'s own shape for the same question (see its
    // `orgTree` branch): the membership path applies the organization predicate,
    // and the membership-less path is left exactly as it was.
    //
    // Three callers, three answers, all deliberate:
    //
    // 1. NO RESOLVED USER — unscoped, and checked FIRST so it stays that way.
    //    `AUTHENTICATED` does NOT guarantee `req.user`: `evaluatePolicy` allows
    //    everything before it looks at the user when `singleUser` is set (see
    //    policy.ts), and single-user mode never populates `req.user` because
    //    there is no bearer token to resolve it from. It is the ONLY mode that
    //    gets here without one — every other userless caller is denied 401 by
    //    the policy plugin first. That mode is legitimate and documented
    //    ("every policy bypassed"), so a request with no user sees everything,
    //    rather than 500ing on a `!` assertion or being silently filtered to
    //    nothing.
    //
    //    Note this branch is NOT `req.membership`-scoped even though
    //    `singleUserMembership()` does populate one. Scoping to it would return
    //    the same rows — the mode is single-tenant by definition and the
    //    one-organization cap holds it there — but only leaving it unscoped is
    //    correct WITHOUT that argument, and a mode whose contract is "every
    //    policy bypassed" should not acquire a tenant filter as a side effect of
    //    fixing a different caller. Ordering it first is what makes that a
    //    decision rather than a coincidence of branch order.
    //
    // 2. A MEMBERSHIP — scoped to it, admin or not. `req.isAdmin` still selects
    //    the branch (it is the union of the org role with two instance-level
    //    break-glass signals, and narrowing it to `membership.role === 'ADMIN'`
    //    would be a separate, intra-tenant behaviour change), but it no longer
    //    decides the SCOPE.
    //
    //    The GRANT path carries the predicate too. Both clauses derive from the
    //    same `req.membership.organizationId`, so — stated honestly — on the
    //    normal path each is individually REDUNDANT given the other. They are
    //    defence in depth, not two independent scopes, and an earlier draft of
    //    this comment claimed the latter ("dropping either widens a different
    //    thing"). That claim is falsifiable in thirty seconds, and a falsifiable
    //    justification is how a security clause gets deleted.
    //
    //    The real argument is about the ABNORMAL path, and it is specific:
    //    `OrgTreeService.list` takes `organizationId` as OPTIONAL and fails open
    //    by construction — its own docstring says so — so were this value ever
    //    `undefined` at runtime, `list()` would drop the tenant predicate and
    //    return every organization's trees. What keeps THAT path closed is the
    //    other clause: `accessibleOrgTreeIds` refuses a scope that does not name
    //    exactly one thing, so a blank organization id yields `[]`, and
    //    `id: { in: [] }` means nothing rather than everything. Each clause covers
    //    the other's fail-open mode. That is why both stay, and unlike the claim
    //    it replaces it is checkable.
    //
    //    `accessibleOrgTreeIds` takes a REQUIRED scope and applies the
    //    organization predicate itself, through the `orgTree` relation
    //    (`OrgTreeAccess` is class B — it carries no organization of its own and
    //    inherits tenancy through the tree). An earlier version of this comment
    //    said the helper "cannot usefully do otherwise", which was wrong about the
    //    relation. Two live cases put a foreign tree id in an UNSCOPED grant list,
    //    which is why that predicate is required and not decorative:
    //
    //      - CONCURRENT MEMBERSHIPS. Holding ACTIVE memberships in two
    //        organizations is a supported state, not a defect —
    //        `listSwitchableFor` exists to enumerate them and
    //        `setActiveOrganization` to choose between them — so such a user
    //        legitimately holds `OrgTreeAccess` rows in both at once.
    //        `revokeOrganizationGrantsForUser` is deliberately scoped to ONE
    //        organization for exactly this reason (leaving Acme must not cost
    //        them their Initech boards), which means offboarding does not and
    //        must not collapse the two sets. Only this clause keeps org B's trees
    //        out of the list they get while acting in org A.
    //      - HISTORICAL ORPHANS. The offboarding revoke is explicitly NOT
    //        retroactive (see `__isolation__/README.md`, §4.1 hole 2 — "grants
    //        already orphaned by removals predating the revoke"), so any
    //        deployment that offboarded before it shipped still holds grant rows
    //        with no membership behind them.
    //
    //    Note what this reason is NOT, because the earlier draft of this comment
    //    said it and it was false by the time it landed: it is no longer that
    //    `MembershipService.remove` deletes no grants. It does now
    //    (`membership.service.ts` → `revokeOrganizationGrantsForUser`, inside the
    //    membership-delete transaction, with `orgTree` among its
    //    `ACCESS_ENTITIES` rows). The predicate survives that fix on the two
    //    grounds above; do not read the fix as licence to remove it.
    //
    //    In one line: a grant narrows reach inside a tenant, it must never
    //    establish reach into one.
    //
    // 3. NO MEMBERSHIP — left exactly as it was: there is no organization to
    //    scope to, and denying here would break the lockout-recovery path.
    //
    //    Do NOT read this as "§4.1 hole 3, pinned by the isolation harness".
    //    Slice 5 closed hole 3 unconditionally at six sites, all of them in
    //    `auth/policy.ts`, and all three of that harness file's `it.fails` are
    //    now plain `it`. This is a ROUTE HANDLER, which that slice did not touch
    //    and explicitly scoped itself away from ("route handlers that read
    //    unscoped are tracked separately"). So this branch is an open residual of
    //    the same shape, carried deliberately rather than a hole somebody else
    //    already pins — recorded as such in `planning/TENANCY-PROGRAMME.md`.
    app.get('/org-trees', { config: { policy: AUTHENTICATED } }, async (req) => {
      if (!req.user) return service.list();

      const userId = req.user.id;
      if (req.membership) {
        const organizationId = req.membership.organizationId;
        if (req.isAdmin) return service.list({ organizationId });
        return service.list({
          organizationId,
          orgTreeIds: await accessibleOrgTreeIds(deps.prisma, userId, { organizationId }, req.log),
        });
      }

      if (req.isAdmin) return service.list();
      return service.list({
        orgTreeIds: await accessibleOrgTreeIds(deps.prisma, userId, UNSCOPED_NO_MEMBERSHIP, req.log),
      });
    });

    // An org tree is a TENANT ROOT, so unlike GET above this cannot stay
    // AUTHENTICATED: the new row needs an owning organization, and
    // `requireOrganizationId` deliberately throws rather than guesses when the
    // request carries no membership. `ORG_MEMBER` is what guarantees one is
    // there — the floor for creating anything a tenant owns, and the same
    // policy POST /boards declares for the same reason. It is not a check
    // against the tree (there is no tree yet); it is a check against the
    // tenant.
    //
    // The service stamps the creator as OWNER atomically — see
    // OrgTreeService.create. `req.user?.id` (not `!`), for the same
    // single-user-mode reason as GET above: with no resolved user the tree is
    // still created, just with no owner row — `create`'s third parameter is
    // optional for exactly this case, while single-user mode still resolves a
    // membership through `singleUserMembership()` so the tenant is never
    // missing.
    app.post('/org-trees', { config: { policy: ORG_MEMBER } }, async (req, reply) => {
      const body = CreateOrgTreeSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
      return service.create(requireOrganizationId(req), body.data.name, req.user?.id);
    });

    /**
     * Two independent ways in (design D14): a grant on the tree, or a grant on
     * any board INSIDE it. 403ing the shell for a board-only grantee would make
     * their board unreachable, which would make per-board sharing useless.
     */
    app.get<{ Params: { id: string } }>(
      '/org-trees/:id',
      { config: { policy: any(orgTree('VIEWER'), employeeBoardInTree('VIEWER')) } },
      async (req, reply) => {
        if (!uuid.safeParse(req.params.id).success) return reply.code(400).send({ error: 'bad id' });

        // Load first, so a tree that does not exist 404s without a second
        // lookup — and so the role question is only asked when there is
        // something to answer it about.
        // A GRANT, not `req.isAdmin` alone — the same resolver the employee-board
        // gate uses, so the two cannot answer differently for the same caller.
        const includeSalary = await canViewSalary(
          deps.prisma,
          req.user?.id ?? null,
          req.params.id,
          req.isAdmin,
        );
        const tree = await service.getWithEmployees(req.params.id, { includeSalary });
        if (!tree) return reply.code(404).send({ error: 'not found' });

        // `any(...)` deliberately does not report WHICH branch admitted the
        // caller — a combinator that returned provenance would invite handlers
        // to re-implement authorization from it. So the handler asks the
        // question it actually cares about: do they hold the TREE, or only a
        // board inside it? A null tree role means the second branch is what let
        // them in, and the chart is not theirs to see.
        const grant = await access.getRole('orgTree', req.params.id, req.user?.id ?? '');
        const treeRole = req.membership
          ? effectiveBoardRole(req.membership.role, grant)
          : (grant ?? null);
        // Name and shape only. `employees` is emptied rather than the key being
        // dropped, so the web layer needs no second payload variant.
        if (!treeRole) return { ...tree, employees: [] };
        return tree;
      },
    );

    app.patch<{ Params: { id: string } }>('/org-trees/:id', { config: { policy: orgTree('OWNER') } }, async (req, reply) => {
      if (!uuid.safeParse(req.params.id).success) return reply.code(400).send({ error: 'bad id' });
      const body = RenameOrgTreeSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
      const updated = await service.rename(req.params.id, body.data.name);
      if (!updated) return reply.code(404).send({ error: 'not found' });
      return updated;
    });

    app.delete<{ Params: { id: string } }>('/org-trees/:id', { config: { policy: orgTree('OWNER') } }, async (req, reply) => {
      if (!uuid.safeParse(req.params.id).success) return reply.code(400).send({ error: 'bad id' });
      await service.delete(req.params.id);
      return reply.code(204).send();
    });

    app.post<{ Params: { id: string } }>('/org-trees/:id/import', { config: { policy: orgTree('EDITOR') } }, async (req, reply) => {
      if (!uuid.safeParse(req.params.id).success) return reply.code(400).send({ error: 'bad id' });
      const file = await req.file();
      if (!file) return reply.code(400).send({ error: 'no file' });
      const buf = await file.toBuffer();
      const rows = await parseOrgChartBuffer(buf, file.filename);
      return service.importEmployees(req.params.id, rows);
    });

    app.post<{ Params: { id: string } }>('/org-trees/:id/sync', { config: { policy: orgTree('EDITOR') } }, async (req, reply) => {
      if (!uuid.safeParse(req.params.id).success) return reply.code(400).send({ error: 'bad id' });
      try {
        await deps.enqueueSync(req.params.id);
      } catch {
        return reply.code(503).send({ error: 'sync queue unavailable' });
      }
      return reply.code(202).send({ enqueued: true });
    });

    app.get<{ Params: { id: string } }>('/org-trees/:id/sync-status', { config: { policy: orgTree('VIEWER') } }, async (req, reply) => {
      if (!uuid.safeParse(req.params.id).success) return reply.code(400).send({ error: 'bad id' });
      return service.getSyncStatus(req.params.id);
    });

    app.get<{ Params: { id: string } }>('/org-trees/:id/source', { config: { policy: orgTree('OWNER') } }, async (req, reply) => {
      if (!uuid.safeParse(req.params.id).success) return reply.code(400).send({ error: 'bad id' });
      return deps.sourceService.getConfig(req.params.id);
    });

    app.put<{ Params: { id: string } }>('/org-trees/:id/source', { config: { policy: orgTree('OWNER') } }, async (req, reply) => {
      if (!uuid.safeParse(req.params.id).success) return reply.code(400).send({ error: 'bad id' });
      const body = SaveOrgSourceInputSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
      return deps.sourceService.saveConfig(req.params.id, body.data.rootUpn);
    });

    app.post<{ Params: { id: string } }>('/org-trees/:id/source/sync', { config: { policy: orgTree('EDITOR') } }, async (req, reply) => {
      if (!uuid.safeParse(req.params.id).success) return reply.code(400).send({ error: 'bad id' });
      try {
        await deps.enqueueSourceSync(req.params.id);
        await deps.sourceService.markSyncing(req.params.id);
      } catch {
        return reply.code(503).send({ error: 'source sync queue unavailable' });
      }
      return reply.code(202).send({ enqueued: true });
    });

    // Persist a Microsoft Graph connection. Written server-to-server by the web layer
    // (a pasted access token, or a delegated refresh token) — tokens never transit
    // back to the browser.
    app.post<{ Params: { id: string } }>('/org-trees/:id/source/connection', { config: { policy: orgTree('OWNER') } }, async (req, reply) => {
      if (!uuid.safeParse(req.params.id).success) return reply.code(400).send({ error: 'bad id' });
      const body = SaveOrgSourceConnectionSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
      return deps.sourceService.saveConnection(req.params.id, {
        accessToken: body.data.accessToken ?? null,
        refreshToken: body.data.refreshToken ?? null,
        microsoftUpn: body.data.microsoftUpn,
        connectedByEmail: body.data.connectedByEmail ?? null,
      });
    });

    app.delete<{ Params: { id: string } }>('/org-trees/:id/source/connection', { config: { policy: orgTree('OWNER') } }, async (req, reply) => {
      if (!uuid.safeParse(req.params.id).success) return reply.code(400).send({ error: 'bad id' });
      const result = await deps.sourceService.clearConnection(req.params.id);
      if (!result) return reply.code(404).send({ error: 'not found' });
      return result;
    });

    // Comment routes — comment-counts MUST be registered before any /:id/... param route
    // `parseCsvParam`, not `raw.split(',')`: Fastify hands back an ARRAY for a
    // repeated param (`?ids=a&ids=b`), which `.split` would 500 on — in a
    // handler whose own policy (`fromQueryCsv`) had already parsed it
    // correctly.
    app.get<{ Querystring: { ids?: string | string[] } }>(
      '/org-employees/comment-counts',
      { config: { policy: orgTree('VIEWER', viaOrgEntity('orgEmployee', fromQueryCsv('ids'))) } },
      async (req, reply) => {
        const ids = parseCsvParam(req.query.ids);
        if (ids.length === 0) return reply.send({});
        if (ids.some((id) => !uuid.safeParse(id).success)) {
          return reply.code(400).send({ error: 'Invalid employee ID in list' });
        }
        // The caller, so the badge counts only what they may read (privacy D4).
        return reply.send(await commentService.countByEmployee(ids, req.user?.id ?? null));
      },
    );

    app.get<{ Params: { id: string } }>('/org-employees/:id/comments', { config: { policy: orgTree('VIEWER', VIA_EMPLOYEE) } }, async (req, reply) => {
      if (!uuid.safeParse(req.params.id).success) return reply.code(400).send({ error: 'bad id' });
      return reply.send(await commentService.listByEmployee(req.params.id, req.user?.id ?? null));
    });

    app.post<{ Params: { id: string } }>('/org-employees/:id/comments', { config: { policy: orgTree('EDITOR', VIA_EMPLOYEE) } }, async (req, reply) => {
      if (!uuid.safeParse(req.params.id).success) return reply.code(400).send({ error: 'bad id' });
      const parsed = CreateEmployeeCommentInputSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      const comment = await commentService.create(req.params.id, {
        content: parsed.data.content as Prisma.InputJsonValue,
        authorName: parsed.data.authorName,
        uploadIds: parsed.data.uploadIds,
        // From the session, never the body — see the hook's own comment.
        authorId: req.user?.id ?? null,
        isPrivate: parsed.data.isPrivate,
      });

      // After the write, and unable to fail it. The hook resolves the tree the
      // mention is scoped to itself, inside its own try/catch.
      await notifyCommentMentions(deps.prisma, req, {
        kind: 'orgEmployeeComment',
        commentId: comment.id,
        after: parsed.data.content,
      });
      return reply.code(201).send(comment);
    });

    app.patch<{ Params: { id: string; cid: string } }>(
      '/org-employees/:id/comments/:cid',
      { config: { policy: orgTree('EDITOR', viaOrgEntity('orgEmployeeComment', fromParam('cid'))) } },
      async (req, reply) => {
        if (!uuid.safeParse(req.params.cid).success) return reply.code(400).send({ error: 'bad id' });
        const parsed = UpdateEmployeeCommentInputSchema.safeParse(req.body);
        if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
        // Read BEFORE the update destroys it, and only when the content is
        // actually changing. Null means skip — never fall back to notifying
        // everyone named in the comment.
        const previous =
          parsed.data.content !== undefined
            ? await readPreviousCommentContent(
                deps.prisma,
                'orgEmployeeComment',
                req.params.cid,
                req.log,
              )
            : null;

        const comment = await commentService.update(
          req.params.cid,
          { ...parsed.data, content: parsed.data.content as Prisma.InputJsonValue | undefined },
          req.user?.id ?? null,
        );
        if (comment === null) return reply.code(404).send({ error: 'Not found' });
        // Only the author may flip the privacy flag. 403, not 404: the caller can
        // already see the comment (they hold EDITOR on the tree), so pretending
        // it does not exist would be a lie they can immediately disprove.
        if (comment === 'forbidden') {
          return reply.code(403).send({ error: 'Only the author can change a comment\'s privacy' });
        }

        if (previous) {
          await notifyCommentMentions(deps.prisma, req, {
            kind: 'orgEmployeeComment',
            commentId: comment.id,
            before: previous.content,
            after: parsed.data.content,
          });
        }
        return reply.send(comment);
      },
    );

    app.delete<{ Params: { id: string; cid: string } }>(
      '/org-employees/:id/comments/:cid',
      { config: { policy: orgTree('EDITOR', viaOrgEntity('orgEmployeeComment', fromParam('cid'))) } },
      async (req, reply) => {
        if (!uuid.safeParse(req.params.cid).success) return reply.code(400).send({ error: 'bad id' });
        const deleted = await commentService.remove(req.params.cid);
        if (!deleted) return reply.code(404).send({ error: 'Not found' });
        return reply.code(204).send();
      },
    );

    app.post<{ Params: { id: string } }>('/org-employees/:id/aliases', { config: { policy: orgTree('EDITOR', VIA_EMPLOYEE) } }, async (req, reply) => {
      if (!uuid.safeParse(req.params.id).success) return reply.code(400).send({ error: 'bad id' });
      const body = OrgEmployeeAliasInputSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
      return service.addAlias(req.params.id, body.data);
    });

    app.delete<{ Params: { id: string } }>(
      '/org-employee-aliases/:id',
      { config: { policy: orgTree('EDITOR', viaOrgEntity('orgEmployeeAlias', fromParam('id'))) } },
      async (req, reply) => {
        if (!uuid.safeParse(req.params.id).success) return reply.code(400).send({ error: 'bad id' });
        await service.deleteAlias(req.params.id);
        return reply.code(204).send();
      },
    );

    // Same shape as :id/move below: the policy gates `:id` (the tree), while
    // `managerId` is body-supplied and gated by nothing.
    app.post<{ Params: { id: string } }>('/org-trees/:id/employees', { config: { policy: orgTree('EDITOR') } }, async (req, reply) => {
      if (!uuid.safeParse(req.params.id).success) return reply.code(400).send({ error: 'bad id' });
      const body = CreateEmployeeSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
      try {
        return await service.createEmployee(req.params.id, body.data);
      } catch (err) {
        if (err instanceof CrossTreeEmployeeError) {
          return reply.code(403).send({ error: err.message, orgEmployeeIds: err.orgEmployeeIds });
        }
        throw err;
      }
    });

    app.patch<{ Params: { id: string } }>('/org-employees/:id', { config: { policy: orgTree('EDITOR', VIA_EMPLOYEE) } }, async (req, reply) => {
      if (!uuid.safeParse(req.params.id).success) return reply.code(400).send({ error: 'bad id' });
      const body = UpdateEmployeeProfileSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
      try {
        await service.updateEmployee(req.params.id, body.data, { canEditSalary: req.isAdmin });
        return reply.code(204).send();
      } catch (err) {
        if (err instanceof OrgEmployeeForbiddenError) return reply.code(403).send({ error: 'forbidden' });
        throw err;
      }
    });

    app.get<{ Params: { id: string } }>('/org-employees/:id/activity', { config: { policy: orgTree('VIEWER', VIA_EMPLOYEE) } }, async (req, reply) => {
      if (!uuid.safeParse(req.params.id).success) return reply.code(400).send({ error: 'bad id' });
      const employee = await service.getEmployeeForActivity(req.params.id);
      if (!employee) return reply.code(404).send({ error: 'not found' });
      const activityService = activityServiceFor(req);
      if (!activityService) {
        return { commits: [], pullRequests: [], assignedIssues: [] };
      }
      const identities = resolveEmployeeIdentities(employee);
      return activityService.forEmployee(identities);
    });

    app.delete<{ Params: { id: string } }>('/org-employees/:id', { config: { policy: orgTree('EDITOR', VIA_EMPLOYEE) } }, async (req, reply) => {
      if (!uuid.safeParse(req.params.id).success) return reply.code(400).send({ error: 'bad id' });
      await service.deleteEmployee(req.params.id);
      return reply.code(204).send();
    });

    // The policy gates `:id` — the employee being moved. `managerId` comes
    // from the body and is gated by nothing, so the service refuses one that
    // lives in a different tree (cycle detection is scoped to the subject's
    // own tree and could not see such a pointer at all).
    app.patch<{ Params: { id: string } }>('/org-employees/:id/move', { config: { policy: orgTree('EDITOR', VIA_EMPLOYEE) } }, async (req, reply) => {
      if (!uuid.safeParse(req.params.id).success) return reply.code(400).send({ error: 'bad id' });
      const body = MoveEmployeeSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
      try {
        await service.moveEmployee(req.params.id, body.data);
        return reply.code(204).send();
      } catch (err) {
        if (err instanceof OrgTreeCycleError) return reply.code(409).send({ error: 'cycle' });
        if (err instanceof CrossTreeEmployeeError) {
          return reply.code(403).send({ error: err.message, orgEmployeeIds: err.orgEmployeeIds });
        }
        throw err;
      }
    });
  };
}

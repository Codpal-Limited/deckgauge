import type { FastifyInstance } from 'fastify';
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
import { accessibleOrgTreeIds } from '../auth/board-access.js';
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
import { effectiveBoardRole } from '../authz/policy.js';

const uuid = z.string().uuid();

export function orgTreeRoutes(deps: OrgTreeRoutesDeps) {
  const service = deps.serviceFactory();
  const access = new AccessService(deps.prisma);
  return async function plugin(app: FastifyInstance) {
    const activityService = deps.clickhouse
      ? new EmployeeActivityService(deps.clickhouse)
      : null;
    const commentService = new EmployeeCommentService(deps.prisma, deps.uploadService);

    // No tree id lives on this request to check a declarative policy against —
    // the set of trees to check IS the response — so this stays AUTHENTICATED
    // and filters in the handler. An admin sees every tree. `AUTHENTICATED`
    // does NOT guarantee `req.user` is resolved: `evaluatePolicy` allows
    // everything before it looks at the user when `singleUser` is set (see
    // policy.ts), and single-user mode never populates `req.user` because
    // there is no bearer token to resolve it from. That is a legitimate,
    // documented mode ("every policy bypassed") — a request with no user
    // there sees everything, exactly like an admin, rather than 500ing on a
    // `!` assertion or getting silently filtered to nothing.
    app.get('/org-trees', { config: { policy: AUTHENTICATED } }, async (req) => {
      if (req.isAdmin || !req.user) return service.list();
      return service.list({ orgTreeIds: await accessibleOrgTreeIds(deps.prisma, req.user.id, req.log) });
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
        const tree = await service.getWithEmployees(req.params.id, { includeSalary: req.isAdmin });
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
      const rows = parseOrgChartBuffer(buf, file.filename);
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
        return reply.send(await commentService.countByEmployee(ids));
      },
    );

    app.get<{ Params: { id: string } }>('/org-employees/:id/comments', { config: { policy: orgTree('VIEWER', VIA_EMPLOYEE) } }, async (req, reply) => {
      if (!uuid.safeParse(req.params.id).success) return reply.code(400).send({ error: 'bad id' });
      return reply.send(await commentService.listByEmployee(req.params.id));
    });

    app.post<{ Params: { id: string } }>('/org-employees/:id/comments', { config: { policy: orgTree('EDITOR', VIA_EMPLOYEE) } }, async (req, reply) => {
      if (!uuid.safeParse(req.params.id).success) return reply.code(400).send({ error: 'bad id' });
      const parsed = CreateEmployeeCommentInputSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      const comment = await commentService.create(req.params.id, {
        content: parsed.data.content as Prisma.InputJsonValue,
        authorName: parsed.data.authorName,
        uploadIds: parsed.data.uploadIds,
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
        const comment = await commentService.update(req.params.cid, {
          ...parsed.data,
          content: parsed.data.content as Prisma.InputJsonValue | undefined,
        });
        if (!comment) return reply.code(404).send({ error: 'Not found' });
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

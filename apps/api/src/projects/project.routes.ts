import type { FastifyInstance } from "fastify";
import {
  ProjectService,
  CreateProjectInputSchema,
  UpdateProjectInputSchema,
  ReorderInputSchema,
} from "./project.service.js";
import { AutomationService } from "../automations/automation.service.js";
import { notifyItemChanged } from '../notifications/triggers/item-changed.js';
import type { PrismaClient } from "@deckgauge/db";
import { z } from "zod";
import {
  board,
  viaEntity,
  viaBoardId,
  fromParam,
  fromQuery,
  fromBodyField,
  fromBodyFieldArray,
  fromBodyArray,
} from "../auth/policy.js";

// Bulk delete accepts a batch of project ids. The board's "delete selected"
// action chunks large selections client-side; this cap bounds a single request
// body well under Fastify's default limit while still covering normal batches.
const MoveToBoardSchema = z.object({ targetGroupId: z.string().uuid() });

const BulkDeleteSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(10000),
});

// Optional server-side filtering/sorting for the board project list.
// `boardId` is required: omitting it used to return every project across
// every board, unfiltered by access — a data leak in single-user mode (where
// the policy layer is bypassed entirely, see below) and simply the wrong
// default regardless of mode. Every caller already always sends it.
// `status` accepts a repeated param or a comma-separated string.
const ProjectListQuerySchema = z.object({
  boardId: z.string().uuid(),
  groupId: z.string().uuid().optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(500).optional(),
  search: z.string().trim().min(1).optional(),
  status: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((v) =>
      v === undefined ? undefined : Array.isArray(v) ? v : v.split(","),
    ),
  sortColumn: z.enum(["name", "owner", "status", "updatedAt"]).optional(),
  sortDir: z.enum(["asc", "desc"]).optional(),
});

export async function projectRoutes(
  app: FastifyInstance,
  { prisma }: { prisma: PrismaClient },
) {
  const service = new ProjectService(prisma);
  const automationService = new AutomationService(prisma);

  // GET /projects?boardId=&groupId=&page=&pageSize=&search=&status=&sortColumn=&sortDir=
  //   → { items, total, hasMore }
  //
  // `boardId` is required (see ProjectListQuerySchema above) — the policy
  // below denies boardless calls too, but only in multi-user mode; single-
  // user mode bypasses the policy layer entirely (evaluatePolicy short-
  // circuits to ALLOW), so the Zod-level requirement is what actually closes
  // the leak there. Chosen over "scope to boards the caller can access"
  // because single-user mode has no user-board membership to scope against,
  // and every real caller (apps/web/app/page.tsx, fetchProjectsPage) already
  // always sends boardId.
  app.get(
    "/projects",
    { config: { policy: board("VIEWER", viaBoardId(fromQuery("boardId"))) } },
    async (req, reply) => {
      const parsed = ProjectListQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }
      const q = parsed.data;
      const result = await service.list({
        boardId: q.boardId,
        groupId: q.groupId,
        page: q.page,
        pageSize: q.pageSize,
        search: q.search,
        statuses: q.status,
        sort: q.sortColumn
          ? { column: q.sortColumn, direction: q.sortDir ?? "asc" }
          : undefined,
      });
      return reply.send(result);
    },
  );

  // GET /projects/:id (includes field values) — the board is reachable
  // through Project.boardId (direct column, nullable).
  app.get<{ Params: { id: string } }>(
    "/projects/:id",
    { config: { policy: board("VIEWER", viaEntity("project", fromParam("id"))) } },
    async (req, reply) => {
      const project = await service.getById(req.params.id);
      if (!project) return reply.status(404).send({ error: "Not found" });
      const fieldValues = await prisma.projectFieldValue.findMany({
        where: { projectId: req.params.id },
      });
      return reply.send({ ...project, fieldValues });
    },
  );

  // POST /projects — boardId is optional in the schema (a project can be
  // created unattached to any board), but that path is unused by the app
  // today; denying it when boardId is absent is the safe default rather than
  // guessing at an "unattached" access rule that doesn't exist yet.
  app.post(
    "/projects",
    { config: { policy: board("EDITOR", viaBoardId(fromBodyField("boardId"))) } },
    async (req, reply) => {
      const parsed = CreateProjectInputSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }
      const project = await service.create(parsed.data);

      // `item_created` fires here and nowhere else on the hand-edit path. The
      // sync fires the same trigger for the rows it creates, because a synced row
      // is a new row on the board like any other — see sync-automations.ts.
      if (project.boardId) {
        try {
          await automationService.evaluateTriggers(
            project.boardId,
            project.id,
            { status: project.status, statusId: project.statusId },
            {
              actorId: req.user?.id ?? null,
              organizationId: req.membership?.organizationId ?? null,
            },
          );
        } catch (err) {
          app.log.error(err, 'Automation trigger evaluation failed');
        }
      }

      return reply.status(201).send(project);
    },
  );

  // PATCH /projects/:id — see GET /projects/:id.
  app.patch<{ Params: { id: string } }>(
    "/projects/:id",
    { config: { policy: board("EDITOR", viaEntity("project", fromParam("id"))) } },
    async (req, reply) => {
      const parsed = UpdateProjectInputSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }

      // Get current state for automation trigger evaluation
      const before = await service.getById(req.params.id);
      if (!before) return reply.status(404).send({ error: "Not found" });

      const project = await service.update(req.params.id, parsed.data, req.user?.id);
      if (!project) return reply.status(404).send({ error: "Not found" });

      // Evaluate automation triggers if the project has a board.
      // Pass both enum status and statusId so custom board-status changes also fire.
      if (project.boardId) {
        try {
          await automationService.evaluateTriggers(
            project.boardId,
            project.id,
            {
              status: project.status,
              previousStatus: before.status,
              statusId: project.statusId,
              previousStatusId: before.statusId,
            },
            // A `notify` action needs to know who to credit and which tenant to
            // file under. Absent on the sync paths, which is what keeps a bulk
            // import from firing every rule at everybody.
            {
              actorId: req.user?.id ?? null,
              organizationId: req.membership?.organizationId ?? null,
            },
          );
        } catch (err) {
          app.log.error(err, 'Automation trigger evaluation failed');
        }
      }

      // Notifications last: the update is already committed, the automation may
      // have changed the row again, and neither must be blocked by a bell.
      if (project.boardId) {
        await notifyItemChanged(prisma, req, {
          projectId: project.id,
          boardId: project.boardId,
          before: {
            owner: before.owner,
            ownerId: before.ownerId,
            status: before.status,
            dueDate: before.dueDate,
          },
          after: {
            owner: project.owner,
            ownerId: project.ownerId,
            status: project.status,
            dueDate: project.dueDate,
          },
        });
      }

      return reply.send(project);
    },
  );

  // DELETE /projects/:id — see GET /projects/:id.
  app.delete<{ Params: { id: string } }>(
    "/projects/:id",
    { config: { policy: board("EDITOR", viaEntity("project", fromParam("id"))) } },
    async (req, reply) => {
      const deleted = await service.delete(req.params.id, req.user?.id);
      if (!deleted) return reply.status(404).send({ error: "Not found" });
      return reply.status(204).send();
    },
  );

  // POST /projects/bulk-delete  { ids: string[] } → { deleted: number }
  // One request deletes the whole batch; replaces the old client loop that
  // issued one DELETE per id (which timed out on large selections). Resolve
  // every id's board and require EDITOR on each one — a batch spanning
  // several boards must pass on every one of them, not just the first.
  app.post(
    "/projects/bulk-delete",
    { config: { policy: board("EDITOR", viaEntity("project", fromBodyFieldArray("ids"))) } },
    async (req, reply) => {
      const parsed = BulkDeleteSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }
      const deleted = await service.deleteMany(parsed.data.ids, req.user?.id);
      return reply.send({ deleted });
    },
  );

  // POST /projects/reorder — the body is a bare array of { id, order?,
  // groupId? }. Same batch reasoning as bulk-delete above.
  app.post(
    "/projects/reorder",
    { config: { policy: board("EDITOR", viaEntity("project", fromBodyArray("id"))) } },
    async (req, reply) => {
      const parsed = ReorderInputSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }
      const projects = await service.reorder(parsed.data);
      return reply.send(projects);
    },
  );

  // POST /projects/:id/move-to-board — moves a project onto a (possibly
  // different) board's group. Requires EDITOR on the project's *current*
  // board (:id → Project.boardId) AND on the *target* board
  // (body.targetGroupId → Group.boardId); both must resolve and pass.
  app.post<{ Params: { id: string } }>(
    '/projects/:id/move-to-board',
    {
      config: {
        policy: board('EDITOR', [
          viaEntity('project', fromParam('id')),
          viaEntity('group', fromBodyField('targetGroupId')),
        ]),
      },
    },
    async (req, reply) => {
      const parsed = MoveToBoardSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      try {
        const result = await service.moveProjectToBoard(req.params.id, parsed.data.targetGroupId, req.user?.id);
        return reply.send(result);
      } catch (err) {
        const msg = (err as Error).message;
        const code = msg.endsWith('_NOT_FOUND') ? 404 : 400;
        return reply.code(code).send({ error: msg });
      }
    },
  );
}

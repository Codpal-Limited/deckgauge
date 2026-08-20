import type { FastifyInstance } from "fastify";
import {
  GroupService,
  CreateGroupInputSchema,
  UpdateGroupInputSchema,
  ReorderGroupsInputSchema,
} from "./group.service.js";
import type { PrismaClient } from "@deckgauge/db";
import { board, viaEntity, viaBoardId, fromParam, fromBodyField, fromBodyArray } from "../auth/policy.js";

export async function groupRoutes(
  app: FastifyInstance,
  { prisma }: { prisma: PrismaClient },
) {
  const service = new GroupService(prisma);

  // GET /boards/:boardId/groups
  app.get<{ Params: { boardId: string } }>(
    "/boards/:boardId/groups",
    { config: { policy: board("VIEWER") } },
    async (req, reply) => {
      const groups = await service.listByBoard(req.params.boardId);
      return reply.send(groups);
    },
  );

  // GET /boards/:boardId/group-summaries → [{ groupId, total, statusCounts }]
  app.get<{ Params: { boardId: string } }>(
    "/boards/:boardId/group-summaries",
    { config: { policy: board("VIEWER") } },
    async (req, reply) => {
      const summaries = await service.summariesByBoard(req.params.boardId);
      return reply.send(summaries);
    },
  );

  // GET /groups/:id — :id is a group id; the board is reachable through
  // Group.boardId (direct column).
  app.get<{ Params: { id: string } }>(
    "/groups/:id",
    { config: { policy: board("VIEWER", viaEntity("group", fromParam("id"))) } },
    async (req, reply) => {
      const group = await service.getById(req.params.id);
      if (!group) return reply.status(404).send({ error: "Not found" });
      return reply.send(group);
    },
  );

  // POST /groups — no board id in the params; the body names the board
  // the new group belongs to.
  app.post(
    "/groups",
    { config: { policy: board("EDITOR", viaBoardId(fromBodyField("boardId"))) } },
    async (req, reply) => {
      const parsed = CreateGroupInputSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }
      const group = await service.create(parsed.data);
      if (!group) return reply.status(404).send({ error: "Board not found" });
      return reply.status(201).send(group);
    },
  );

  // PATCH /groups/:id — see GET /groups/:id.
  app.patch<{ Params: { id: string } }>(
    "/groups/:id",
    { config: { policy: board("EDITOR", viaEntity("group", fromParam("id"))) } },
    async (req, reply) => {
      const parsed = UpdateGroupInputSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }
      const group = await service.update(req.params.id, parsed.data);
      if (!group) return reply.status(404).send({ error: "Not found" });
      return reply.send(group);
    },
  );

  // DELETE /groups/:id — see GET /groups/:id.
  app.delete<{ Params: { id: string } }>(
    "/groups/:id",
    { config: { policy: board("EDITOR", viaEntity("group", fromParam("id"))) } },
    async (req, reply) => {
      const result = await service.delete(req.params.id, req.user?.id);
      if (result.deleted) return reply.status(204).send();
      return reply.status(404).send({ error: "Not found" });
    },
  );

  // POST /groups/reorder — the body is a bare array of { id, position } for
  // groups on one board (the board UI always reorders within a single board).
  // Resolve every group's board and require EDITOR on each one, rather than
  // trusting the first item — a mixed-board batch must fail closed.
  app.post(
    "/groups/reorder",
    { config: { policy: board("EDITOR", viaEntity("group", fromBodyArray("id"))) } },
    async (req, reply) => {
      const parsed = ReorderGroupsInputSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }
      const groups = await service.reorderGroups(parsed.data);
      return reply.send(groups);
    },
  );
}

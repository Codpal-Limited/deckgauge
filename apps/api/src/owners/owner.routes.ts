import type { FastifyInstance } from "fastify";
import { OwnerService } from "./owner.service.js";
import type { PrismaClient } from "@deckgauge/db";
import { CreateOwnerInputSchema, UpdateOwnerInputSchema } from "@deckgauge/shared";
import { board, viaEntity, fromParam } from "../auth/policy.js";

export async function ownerRoutes(
  app: FastifyInstance,
  { prisma }: { prisma: PrismaClient },
) {
  const service = new OwnerService(prisma);

  // GET /boards/:boardId/owners
  app.get<{ Params: { boardId: string } }>(
    "/boards/:boardId/owners",
    { config: { policy: board("VIEWER") } },
    async (req, reply) => {
      const owners = await service.listByBoard(req.params.boardId);
      return reply.send(owners);
    },
  );

  // POST /boards/:boardId/owners
  app.post<{ Params: { boardId: string } }>(
    "/boards/:boardId/owners",
    { config: { policy: board("EDITOR") } },
    async (req, reply) => {
      const parsed = CreateOwnerInputSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }
      const owner = await service.create(req.params.boardId, parsed.data);
      if (!owner) return reply.status(404).send({ error: "Board not found" });
      return reply.status(201).send(owner);
    },
  );

  // PATCH /owners/:id — :id is a BoardOwner id; the board is reachable
  // through BoardOwner.boardId (direct column).
  app.patch<{ Params: { id: string } }>(
    "/owners/:id",
    { config: { policy: board("EDITOR", viaEntity("boardOwner", fromParam("id"))) } },
    async (req, reply) => {
      const parsed = UpdateOwnerInputSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }
      const owner = await service.update(req.params.id, parsed.data);
      if (!owner) return reply.status(404).send({ error: "Not found" });
      return reply.send(owner);
    },
  );

  // DELETE /owners/:id — :id is a BoardOwner id; same resolution as PATCH above.
  app.delete<{ Params: { id: string } }>(
    "/owners/:id",
    { config: { policy: board("EDITOR", viaEntity("boardOwner", fromParam("id"))) } },
    async (req, reply) => {
      const result = await service.delete(req.params.id);
      if (result.deleted) return reply.status(204).send();
      return reply.status(404).send({ error: "Not found" });
    },
  );
}

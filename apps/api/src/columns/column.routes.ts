import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@deckgauge/db";
import { ColumnService } from "./column.service.js";
import {
  CreateColumnInputSchema,
  UpdateColumnInputSchema,
  UpsertFieldValuesInputSchema,
  BulkUpsertFieldValuesInputSchema,
} from "@deckgauge/shared";
import { board, viaEntity, fromParam, fromBodyFieldArray } from "../auth/policy.js";

export async function columnRoutes(
  app: FastifyInstance,
  { prisma }: { prisma: PrismaClient },
) {
  const service = new ColumnService(prisma);

  // GET /boards/:id/columns — list columns for a board
  app.get<{ Params: { id: string } }>(
    "/boards/:id/columns",
    { config: { policy: board("VIEWER") } },
    async (req, reply) => {
      const columns = await service.listByBoard(req.params.id);
      return reply.send(columns);
    },
  );

  // POST /boards/:id/columns — create a column
  app.post<{ Params: { id: string } }>(
    "/boards/:id/columns",
    { config: { policy: board("EDITOR") } },
    async (req, reply) => {
      const parsed = CreateColumnInputSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }
      const column = await service.create(req.params.id, parsed.data);
      return reply.status(201).send(column);
    },
  );

  // PATCH /columns/:id — rename or reorder a column. :id is a column id;
  // the board is reachable through BoardColumn.boardId (direct column).
  app.patch<{ Params: { id: string } }>(
    "/columns/:id",
    { config: { policy: board("EDITOR", viaEntity("boardColumn", fromParam("id"))) } },
    async (req, reply) => {
      const parsed = UpdateColumnInputSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }
      const column = await service.update(req.params.id, parsed.data);
      if (!column) return reply.status(404).send({ error: "Column not found" });
      return reply.send(column);
    },
  );

  // DELETE /columns/:id — delete column and its values. See PATCH /columns/:id.
  app.delete<{ Params: { id: string } }>(
    "/columns/:id",
    { config: { policy: board("EDITOR", viaEntity("boardColumn", fromParam("id"))) } },
    async (req, reply) => {
      const deleted = await service.delete(req.params.id);
      if (!deleted) return reply.status(404).send({ error: "Column not found" });
      return reply.status(204).send();
    },
  );

  // PATCH /projects/:id/fields — upsert field values. :id is a project id
  // (service.upsertFieldValues 404s as "Project not found"); the board is
  // reachable through Project.boardId (direct column, nullable).
  app.patch<{ Params: { id: string } }>(
    "/projects/:id/fields",
    { config: { policy: board("EDITOR", viaEntity("project", fromParam("id"))) } },
    async (req, reply) => {
      const parsed = UpsertFieldValuesInputSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }
      const values = await service.upsertFieldValues(req.params.id, parsed.data);
      if (!values) return reply.status(404).send({ error: "Project not found" });
      return reply.send(values);
    },
  );

  // POST /projects/bulk-fields  { ids, values } → { updated, missing }
  //
  // The bulk sibling of the route above: editing a custom-column cell while
  // several rows are selected writes the value to the whole selection. The
  // board did that with one server action per row, and every one of those
  // revalidated the board — see the same note on POST /projects/bulk-update
  // and planning/STATE.md 2026-09-08.
  //
  // A stale id denies the whole batch with a 403 before this handler runs, in
  // multi-user mode — see the long note on POST /projects/bulk-update for why,
  // and for when the counting below is actually reached.
  app.post(
    "/projects/bulk-fields",
    { config: { policy: board("EDITOR", viaEntity("project", fromBodyFieldArray("ids"))) } },
    async (req, reply) => {
      const parsed = BulkUpsertFieldValuesInputSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }
      let updated = 0;
      let missing = 0;
      // Sequential for the same reason as bulk-update: each id is its own
      // read-then-write over shared board state.
      for (const id of parsed.data.ids) {
        const values = await service.upsertFieldValues(id, parsed.data.values);
        if (values) updated += 1;
        else missing += 1;
      }
      return reply.send({ updated, missing });
    },
  );
}

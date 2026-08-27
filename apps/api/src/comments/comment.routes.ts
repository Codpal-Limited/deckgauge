import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@deckgauge/db";
import type { Prisma } from "@deckgauge/db";
import { CommentService } from "./comment.service.js";
import { CreateCommentInputSchema, UpdateCommentInputSchema } from "@deckgauge/shared";
import { z } from "zod";
import type { UploadService } from "../uploads/upload.service.js";
import { board, viaEntity, fromParam, fromQueryCsv, parseCsvParam } from "../auth/policy.js";
import { notifyItemCommentAdded } from '../notifications/triggers/item-comment-added.js';
import {
  notifyCommentMentions,
  readPreviousCommentContent,
} from "../notifications/comment-mention-hook.js";

const UuidSchema = z.string().uuid();

export async function commentRoutes(
  app: FastifyInstance,
  { prisma, uploadService }: { prisma: PrismaClient; uploadService?: UploadService },
) {
  const service = new CommentService(prisma, uploadService);

  // GET /projects/comment-counts?projectIds=id1,id2
  // Registered first to avoid conflict with /projects/:id/comments.
  // Resolves every listed project's board and requires VIEWER on each one.
  // `parseCsvParam`, not `raw.split(",")` — a repeated param
  // (`?projectIds=a&projectIds=b`) arrives as an ARRAY, which `.split` 500s
  // on, in a handler whose own `fromQueryCsv` policy had already parsed it
  // correctly. Same fix as GET /org-employees/comment-counts.
  app.get<{ Querystring: { projectIds?: string | string[] } }>(
    "/projects/comment-counts",
    { config: { policy: board("VIEWER", viaEntity("project", fromQueryCsv("projectIds"))) } },
    async (req, reply) => {
      const ids = parseCsvParam(req.query.projectIds);
      if (ids.length === 0) return reply.send({});
      const invalid = ids.some((id) => !UuidSchema.safeParse(id).success);
      if (invalid) {
        return reply.status(400).send({ error: "Invalid project ID in list" });
      }
      const counts = await service.countByProject(ids);
      return reply.send(counts);
    },
  );

  // GET /projects/:id/comments — :id is a project id; the board is
  // reachable through Project.boardId (direct column).
  app.get<{ Params: { id: string } }>(
    "/projects/:id/comments",
    { config: { policy: board("VIEWER", viaEntity("project", fromParam("id"))) } },
    async (req, reply) => {
      const idParsed = UuidSchema.safeParse(req.params.id);
      if (!idParsed.success) {
        return reply.status(400).send({ error: "Invalid project ID" });
      }
      const comments = await service.listByProject(idParsed.data);
      return reply.send(comments);
    },
  );

  // POST /projects/:id/comments — see GET /projects/:id/comments.
  app.post<{ Params: { id: string } }>(
    "/projects/:id/comments",
    { config: { policy: board("EDITOR", viaEntity("project", fromParam("id"))) } },
    async (req, reply) => {
      const idParsed = UuidSchema.safeParse(req.params.id);
      if (!idParsed.success) {
        return reply.status(400).send({ error: "Invalid project ID" });
      }
      const parsed = CreateCommentInputSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }
      const comment = await service.create(idParsed.data, {
        content: parsed.data.content as Prisma.InputJsonValue,
        authorName: parsed.data.authorName,
        uploadIds: parsed.data.uploadIds,
        // From the session, never from the body: `authorName` is a
        // client-supplied display string defaulting to 'VP'.
        authorId: req.user?.id ?? null,
      });

      // AFTER the comment is committed, and it cannot fail the request: a lost
      // notification is an annoyance, a 500 on a saved comment is a lie. Every
      // query this needs lives inside the hook, behind its try/catch.
      await notifyCommentMentions(prisma, req, {
        kind: "projectComment",
        commentId: comment.id,
        after: parsed.data.content,
      });

      // After the mention hook, which owns the more specific message. CREATE
      // only: editing a comment must not re-notify, which is why the mention
      // hook diffs before/after on the PATCH path. Every query it needs — the
      // board included — is inside its own try/catch.
      await notifyItemCommentAdded(prisma, req, {
        commentId: comment.id,
        projectId: idParsed.data,
        content: comment.content,
      });
      return reply.status(201).send(comment);
    },
  );

  // PATCH /projects/:id/comments/:cid — the handler trusts :cid alone (it
  // never checks that :id actually owns that comment), so the policy must
  // too: resolve the board from the comment itself (:cid → ProjectComment →
  // Project.boardId, two hops), not from the outer :id, or a comment id from
  // a board the caller lacks access to could be edited by naming an :id they
  // *do* have access to.
  app.patch<{ Params: { id: string; cid: string } }>(
    "/projects/:id/comments/:cid",
    { config: { policy: board("EDITOR", viaEntity("projectComment", fromParam("cid"))) } },
    async (req, reply) => {
      const cidParsed = UuidSchema.safeParse(req.params.cid);
      if (!cidParsed.success) {
        return reply.status(400).send({ error: "Invalid comment ID" });
      }
      const parsed = UpdateCommentInputSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }
      // Read BEFORE the update, because the update destroys it. Only when the
      // edit touches the content — a pin toggle changes no mentions. Returns
      // null on any failure, and a null must SKIP notifying rather than fall
      // back to create semantics, which would re-notify everyone named in the
      // comment on a routine typo fix.
      const previous =
        parsed.data.content !== undefined
          ? await readPreviousCommentContent(prisma, "projectComment", cidParsed.data, req.log)
          : null;

      const comment = await service.update(cidParsed.data, {
        ...parsed.data,
        content: parsed.data.content as Prisma.InputJsonValue | undefined,
      });
      if (!comment) return reply.status(404).send({ error: "Not found" });

      // `before` present means "notify the ADDED ids only".
      if (previous) {
        await notifyCommentMentions(prisma, req, {
          kind: "projectComment",
          commentId: comment.id,
          before: previous.content,
          after: parsed.data.content,
        });
      }
      return reply.send(comment);
    },
  );

  // DELETE /projects/:id/comments/:cid — see PATCH /projects/:id/comments/:cid.
  app.delete<{ Params: { id: string; cid: string } }>(
    "/projects/:id/comments/:cid",
    { config: { policy: board("EDITOR", viaEntity("projectComment", fromParam("cid"))) } },
    async (req, reply) => {
      const cidParsed = UuidSchema.safeParse(req.params.cid);
      if (!cidParsed.success) {
        return reply.status(400).send({ error: "Invalid comment ID" });
      }
      const deleted = await service.remove(cidParsed.data);
      if (!deleted) return reply.status(404).send({ error: "Not found" });
      return reply.status(204).send();
    },
  );
}

import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@deckgauge/db";
import { z } from "zod";
import { JiraInstanceService } from "./jira-instance.service.js";
import {
  CreateJiraInstanceInputSchema,
  UpdateJiraInstanceInputSchema,
} from "@deckgauge/shared";
import {
  AUTHENTICATED,
  CONNECTION_OWNER,
  CONNECTION_OWNER_CLAIMED,
  connectionOwnerProtectingFields,
} from "../auth/policy.js";

export async function jiraInstanceRoutes(
  app: FastifyInstance,
  { prisma }: { prisma: PrismaClient },
) {
  const service = new JiraInstanceService(prisma);

  // GET /jira/instances — list all configured instances (tokens masked)
  app.get("/jira/instances", { config: { policy: AUTHENTICATED } }, async (_req, reply) => {
    const instances = await service.list();
    return reply.send(instances);
  });

  // POST /jira/instances — add a new Jira instance
  app.post("/jira/instances", { config: { policy: AUTHENTICATED } }, async (req, reply) => {
    const parsed = CreateJiraInstanceInputSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const instance = await service.create(parsed.data, req.user?.id);
    return reply.status(201).send(instance);
  });

  // PATCH /jira/instances/:id — update an instance.
  // `atlassianUrl` is withheld while the row is unclaimed: repointing the host
  // while keeping the stored apiToken makes the next POST …/projects send that
  // credential to the new host as Basic auth. Claim the row with any other
  // edit first — see UnclaimedGuard in auth/policy.ts.
  app.patch<{ Params: { id: string } }>(
    "/jira/instances/:id",
    {
      config: {
        policy: connectionOwnerProtectingFields(['atlassianUrl']),
        connectionModel: 'jiraInstance',
      },
    },
    async (req, reply) => {
      const parsed = UpdateJiraInstanceInputSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }
      const instance = await service.update(req.params.id, parsed.data, req.user?.id);
      if (!instance)
        return reply.status(404).send({ error: "Instance not found" });
      return reply.send(instance);
    },
  );

  // DELETE /jira/instances/:id — remove an instance.
  // Cascades JiraInstance → JiraProjectSync → BoardJiraSource, wiping the Jira
  // source configuration of every board using it, so an unclaimed row must be
  // claimed by a non-destructive edit before anyone may delete it.
  app.delete<{ Params: { id: string } }>(
    "/jira/instances/:id",
    { config: { policy: CONNECTION_OWNER_CLAIMED, connectionModel: 'jiraInstance' } },
    async (req, reply) => {
      const deleted = await service.delete(req.params.id);
      if (!deleted)
        return reply.status(404).send({ error: "Instance not found" });
      return reply.status(204).send();
    },
  );

  // POST /jira/instances/:id/test — test connectivity. Delegates to the service
  // so it shares the scoped TLS dispatcher and the canonical-host diagnosis;
  // the previous inline copy set NODE_TLS_REJECT_UNAUTHORIZED process-wide,
  // which disabled certificate validation for every concurrent health probe.
  app.post<{ Params: { id: string } }>(
    "/jira/instances/:id/test",
    { config: { policy: AUTHENTICATED } },
    async (req, reply) => {
      const result = await service.testConnection(req.params.id);
      if (result.notFound) {
        return reply.status(404).send({ error: "Instance not found" });
      }
      if (!result.ok) {
        return reply
          .status(422)
          .send({ ok: false, error: result.error, hint: result.hint });
      }
      return reply.send({ ok: true });
    },
  );

  // POST /jira/instances/:id/refresh-token — validate and swap the API token
  app.post<{ Params: { id: string } }>(
    "/jira/instances/:id/refresh-token",
    { config: { policy: CONNECTION_OWNER, connectionModel: 'jiraInstance' } },
    async (req, reply) => {
      const body = z.object({ token: z.string().min(1) }).safeParse(req.body);
      if (!body.success)
        return reply.status(400).send({ error: body.error.flatten() });
      const result = await service.refreshToken(req.params.id, body.data.token, fetch, req.user?.id);
      if (result.notFound)
        return reply.status(404).send({ error: "Instance not found" });
      if (!result.ok)
        return reply.status(422).send({ ok: false, error: result.error });
      return reply.send({ ok: true });
    },
  );

  // POST /jira/instances/:id/projects — discover accessible Jira projects
  app.post<{ Params: { id: string } }>(
    "/jira/instances/:id/projects",
    { config: { policy: AUTHENTICATED } },
    async (req, reply) => {
      const instance = await service.getRawById(req.params.id);
      if (!instance)
        return reply.status(404).send({ error: "Instance not found" });

      const origTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

      try {
        const credentials = `${instance.email}:${instance.apiToken}`;
        const encoded = Buffer.from(credentials).toString("base64");
        const baseUrl = instance.atlassianUrl.replace(/\/+$/, "");
        const response = await fetch(`${baseUrl}/rest/api/3/project`, {
          headers: {
            Authorization: `Basic ${encoded}`,
            Accept: "application/json",
          },
        });

        if (!response.ok) {
          const text = await response.text();
          return reply
            .status(422)
            .send({ error: `Jira API error: ${response.status} ${text}` });
        }

        const projects = (await response.json()) as Array<{
          key: string;
          name: string;
        }>;
        return reply.send(
          projects.map((p) => ({ key: p.key, name: p.name })),
        );
      } catch (err: unknown) {
        let message = "Unknown error";
        if (err instanceof Error) {
          message = err.message;
          const cause = (err as Error & { cause?: Error }).cause;
          if (cause) message += ` — ${cause.message}`;
        }
        return reply
          .status(422)
          .send({ error: `Failed to fetch projects: ${message}` });
      } finally {
        if (origTls !== undefined) {
          process.env.NODE_TLS_REJECT_UNAUTHORIZED = origTls;
        } else {
          delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
        }
      }
    },
  );

  // GET /jira/instances/:id/projects/:projectKey/issue-types
  // Returns alphabetically sorted list of issue type names from the Jira project.
  app.get<{ Params: { id: string; projectKey: string } }>(
    "/jira/instances/:id/projects/:projectKey/issue-types",
    { config: { policy: AUTHENTICATED } },
    async (req, reply) => {
      const instance = await service.getRawById(req.params.id);
      if (!instance)
        return reply.status(404).send({ error: "Instance not found" });

      const origTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

      try {
        const credentials = `${instance.email}:${instance.apiToken}`;
        const encoded = Buffer.from(credentials).toString("base64");
        const baseUrl = instance.atlassianUrl.replace(/\/+$/, "");
        const response = await fetch(
          `${baseUrl}/rest/api/3/project/${req.params.projectKey}`,
          {
            headers: {
              Authorization: `Basic ${encoded}`,
              Accept: "application/json",
            },
          },
        );

        if (!response.ok) {
          const text = await response.text();
          return reply
            .status(422)
            .send({ error: `Jira API error: ${response.status} ${text}` });
        }

        const project = (await response.json()) as {
          issueTypes?: Array<{ name: string; subtask?: boolean }>;
        };

        const types = (project.issueTypes ?? [])
          .filter((t) => t.name && !t.subtask) // exclude Sub-task by default
          .map((t) => t.name)
          .sort();

        return reply.send(types);
      } catch (err: unknown) {
        let message = "Unknown error";
        if (err instanceof Error) {
          const cause = (err as Error & { cause?: Error }).cause;
          message = cause ? `${err.message} — ${cause.message}` : err.message;
        }
        return reply
          .status(422)
          .send({ error: `Failed to fetch issue types: ${message}` });
      } finally {
        if (origTls !== undefined) {
          process.env.NODE_TLS_REJECT_UNAUTHORIZED = origTls;
        } else {
          delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
        }
      }
    },
  );
}

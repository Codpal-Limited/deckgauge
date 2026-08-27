import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@deckgauge/db";
import { z } from "zod";
import { JiraInstanceService } from "./jira-instance.service.js";
import {
  CreateJiraInstanceInputSchema,
  UpdateJiraInstanceInputSchema,
} from "@deckgauge/shared";
import { ORG_MEMBER } from "../auth/policy.js";
import { connectionCaller } from "../connections/connection-caller.js";

  // ORG_MEMBER, not ORG_ADMIN: any member may manage THEIR OWN connections, and
  // the row-level predicate in the service is what decides whose. Loosening this
  // policy without that predicate would be a real regression — see
  // connections/connection-visibility.ts and connection-authz.test.ts.
export async function jiraInstanceRoutes(
  app: FastifyInstance,
  { prisma }: { prisma: PrismaClient },
) {
  const service = new JiraInstanceService(prisma);

  // GET /jira/instances — list all configured instances (tokens masked)
  // Reads are organization-scoped now, so the gate has to establish membership
  // BEFORE the handler asks for it. AUTHENTICATED returns ALLOW without ever
  // resolving a membership, so a membership-less caller reached
  // requireOrganizationId() and got a 500 instead of a scoped result.
  app.get("/jira/instances", { config: { policy: ORG_MEMBER } }, async (req, reply) => {
    const instances = await service.list(connectionCaller(req));
    return reply.send(instances);
  });

  // POST /jira/instances — add a new Jira instance.
  // ORG_ADMIN: a connection is organization property, so adding one is
  // organization administration. See connection-authz.test.ts.
  app.post("/jira/instances", { config: { policy: ORG_MEMBER } }, async (req, reply) => {
    const parsed = CreateJiraInstanceInputSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const instance = await service.create(connectionCaller(req), parsed.data, req.user?.id);
    return reply.status(201).send(instance);
  });

  // PATCH /jira/instances/:id — update an instance.
  //
  // ORG_ADMIN replaces the per-row `connectionOwner` check. That gives up the
  // guard which withheld `atlassianUrl` on an unclaimed row — repointing the
  // host while keeping the stored apiToken makes the next POST …/projects send
  // that credential to the new host as Basic auth. The boundary that also matters
  // is reaching ANOTHER tenant's connection, and that is the service's tenant
  // predicate below, not the gate.
  // Repointing is recorded. The claim that used to sit here — that an
  // organization admin "can already read and replace that credential, so
  // repointing gains them nothing" — is right about replacing and wrong about
  // reading: every response masks the token (`accessToken: '***'`), so an admin
  // cannot read it. Repointing the host while keeping the stored credential makes
  // the next sync send that credential, in the clear, to whatever host was named
  // — a capability an admin does not otherwise have. It stays allowed, because
  // moving a connection to a new host is legitimate; it no longer happens
  // silently. See connections/host-repoint-audit.ts.
  app.patch<{ Params: { id: string } }>(
    "/jira/instances/:id",
    { config: { policy: ORG_MEMBER } },
    async (req, reply) => {
      const parsed = UpdateJiraInstanceInputSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }
      const instance = await service.update(
        connectionCaller(req),
        req.params.id,
        parsed.data,
        req.user?.id,
        req.log,
      );
      if (!instance)
        return reply.status(404).send({ error: "Instance not found" });
      return reply.send(instance);
    },
  );

  // DELETE /jira/instances/:id — remove an instance.
  // Cascades JiraInstance → JiraProjectSync → BoardJiraSource, wiping the Jira
  // source configuration of every board using it — which is why it is
  // organization administration, and why the service resolves the row through
  // the caller's organization before deleting it.
  app.delete<{ Params: { id: string } }>(
    "/jira/instances/:id",
    { config: { policy: ORG_MEMBER } },
    async (req, reply) => {
      const deleted = await service.delete(connectionCaller(req), req.params.id);
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
    // Spends this instance's stored credential against a target the caller
    // names. ORG_ADMIN, with the rest of connection management: an organization
    // MEMBER no longer tests connections.
    { config: { policy: ORG_MEMBER } },
    async (req, reply) => {
      const result = await service.testConnection(
        connectionCaller(req),
        req.params.id,
      );
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
    { config: { policy: ORG_MEMBER } },
    async (req, reply) => {
      const body = z.object({ token: z.string().min(1) }).safeParse(req.body);
      if (!body.success)
        return reply.status(400).send({ error: body.error.flatten() });
      const result = await service.refreshToken(
        connectionCaller(req),
        req.params.id,
        body.data.token,
        fetch,
        req.user?.id,
      );
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
    { config: { policy: ORG_MEMBER } },
    async (req, reply) => {
      const instance = await service.getRawById(
        connectionCaller(req),
        req.params.id,
      );
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
    { config: { policy: ORG_MEMBER } },
    async (req, reply) => {
      const instance = await service.getRawById(
        connectionCaller(req),
        req.params.id,
      );
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

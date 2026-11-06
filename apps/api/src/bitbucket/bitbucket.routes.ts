// Bitbucket Cloud connection routes. Mirrors gitlab.routes.ts; the policy
// reasoning there applies unchanged:
//
//   ORG_MEMBER on every route, not ORG_ADMIN: any member may manage THEIR OWN
//   connections, and the row-level predicate in the service decides whose. Not
//   AUTHENTICATED either, which returns ALLOW before any membership is resolved,
//   so a membership-less caller would reach `requireOrganizationId` and 500.
//   See connections/connection-visibility.ts and connection-authz.test.ts.
//
// A row the caller may not see is a 404 everywhere — the same answer as an id
// that names nothing, so the guard is never an enumeration oracle.
//
// Unlike GitLab, Bitbucket HAS an edit route (PATCH): the workspace is chosen
// after the token is known, so it must be changeable. A workspace change is
// recorded through the host-repoint audit.
//
// Never echo the request body back: it carries the API token. Zod failures are
// answered with `issues` paths and messages only (see `badRequest`).
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@deckgauge/db';
import {
  BitbucketInstanceCreateSchema,
  BitbucketInstancePatchSchema,
  BitbucketTestCredentialsSchema,
} from '@deckgauge/shared';
import {
  BitbucketService,
  BitbucketCredentialError,
  BitbucketWorkspaceChoiceError,
  BitbucketWorkspaceInUseError,
  BitbucketUpstreamError,
} from './bitbucket.service.js';
import { ORG_MEMBER } from '../auth/policy.js';
import { connectionCaller } from '../connections/connection-caller.js';

const IdParams = z.object({ id: z.string().uuid() });

/**
 * A 400 that names the failing fields without echoing their values. Zod's
 * `flatten()` only carries messages, but a custom refinement message could
 * quote input, so this keeps to paths + messages explicitly.
 */
function badRequest(reply: FastifyReply, error: z.ZodError) {
  return reply.code(400).send({
    error: 'Invalid request',
    issues: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
  });
}

/** Shared mapping for the two create-time refusals. Returns null when `err` is neither. */
function sendCreateRefusal(reply: FastifyReply, err: unknown) {
  if (err instanceof BitbucketWorkspaceInUseError) {
    return reply.code(409).send({ error: err.message, code: 'WORKSPACE_IN_USE' });
  }
  if (err instanceof BitbucketWorkspaceChoiceError) {
    return reply.code(400).send({ error: err.message, code: 'WORKSPACE_REQUIRED', workspaces: err.workspaces });
  }
  if (err instanceof BitbucketCredentialError) {
    // An unreachable Bitbucket is not the caller's mistake.
    const status = err.kind === 'unreachable' ? 502 : 400;
    return reply.code(status).send({ error: err.message, kind: err.kind });
  }
  return null;
}

export function bitbucketRoutes({ prisma }: { prisma: PrismaClient; singleUser?: boolean }) {
  return async function plugin(app: FastifyInstance) {
    // Constructed per plugin registration so a test's `vi.stubGlobal('fetch')`
    // made before `register` is the fetch the service binds (as GitLabService).
    const service = new BitbucketService(prisma);

    app.get('/bitbucket/instances', { config: { policy: ORG_MEMBER } }, async (req, reply) => {
      return reply.send(await service.listInstances(connectionCaller(req)));
    });

    // Pre-save "Create & test". Spends only the credentials in the body, never a
    // stored one — but still ORG_MEMBER, so an anonymous caller cannot use this
    // server as a Bitbucket credential oracle.
    app.post('/bitbucket/instances/test-credentials', { config: { policy: ORG_MEMBER } }, async (req, reply) => {
      const body = BitbucketTestCredentialsSchema.safeParse(req.body);
      if (!body.success) return badRequest(reply, body.error);
      const result = await service.testCredentials(body.data);
      if (result.ok) return reply.send(result);
      const status = result.kind === 'unreachable' ? 502 : 400;
      return reply.code(status).send({ ok: false, kind: result.kind, error: result.error });
    });

    app.post('/bitbucket/instances', { config: { policy: ORG_MEMBER } }, async (req, reply) => {
      const body = BitbucketInstanceCreateSchema.safeParse(req.body);
      if (!body.success) return badRequest(reply, body.error);
      try {
        const created = await service.createInstance(connectionCaller(req), body.data, req.user?.id);
        return reply.code(201).send(created);
      } catch (err) {
        const sent = sendCreateRefusal(reply, err);
        if (sent) return sent;
        throw err;
      }
    });

    app.patch('/bitbucket/instances/:id', { config: { policy: ORG_MEMBER } }, async (req, reply) => {
      const params = IdParams.safeParse(req.params);
      if (!params.success) return badRequest(reply, params.error);
      const body = BitbucketInstancePatchSchema.safeParse(req.body);
      if (!body.success) return badRequest(reply, body.error);
      try {
        const updated = await service.updateInstance(
          connectionCaller(req),
          params.data.id,
          body.data,
          req.user?.id,
          req.log,
        );
        if (!updated) return reply.code(404).send({ error: 'Instance not found' });
        return reply.send(updated);
      } catch (err) {
        const sent = sendCreateRefusal(reply, err);
        if (sent) return sent;
        throw err;
      }
    });

    // Cascades to BitbucketRepoSync → BoardBitbucketSource on every board using it.
    app.delete('/bitbucket/instances/:id', { config: { policy: ORG_MEMBER } }, async (req, reply) => {
      const params = IdParams.safeParse(req.params);
      if (!params.success) return badRequest(reply, params.error);
      const deleted = await service.deleteInstance(connectionCaller(req), params.data.id);
      if (!deleted) return reply.code(404).send({ error: 'Instance not found' });
      return reply.code(204).send();
    });

    app.post('/bitbucket/instances/:id/test', { config: { policy: ORG_MEMBER } }, async (req, reply) => {
      const params = IdParams.safeParse(req.params);
      if (!params.success) return badRequest(reply, params.error);
      const result = await service.testConnection(connectionCaller(req), params.data.id);
      if (!result.ok && result.notFound) return reply.code(404).send({ error: 'Instance not found' });
      if (!result.ok) return reply.code(422).send({ ok: false, error: result.error });
      return reply.send(result);
    });

    app.post('/bitbucket/instances/:id/refresh-token', { config: { policy: ORG_MEMBER } }, async (req, reply) => {
      const params = IdParams.safeParse(req.params);
      if (!params.success) return badRequest(reply, params.error);
      const body = z.object({ token: z.string().min(1) }).safeParse(req.body);
      if (!body.success) return badRequest(reply, body.error);
      const result = await service.refreshToken(connectionCaller(req), params.data.id, body.data.token);
      if (result.notFound) return reply.code(404).send({ error: 'Instance not found' });
      if (!result.ok) return reply.code(422).send({ ok: false, error: result.error });
      return reply.send({ ok: true });
    });

    app.get('/bitbucket/instances/:id/remote-repos', { config: { policy: ORG_MEMBER } }, async (req, reply) => {
      const params = IdParams.safeParse(req.params);
      if (!params.success) return badRequest(reply, params.error);
      try {
        return reply.send(await service.listRemoteRepos(connectionCaller(req), params.data.id));
      } catch (err) {
        // Preserve 401/403 so the web layer can offer the reconnect flow.
        if (err instanceof BitbucketUpstreamError) {
          const status = err.status === 401 || err.status === 403 || err.status === 409 ? err.status : 422;
          return reply.code(status).send({ error: err.message });
        }
        const message = err instanceof Error ? err.message : 'Unknown error';
        if (/not found/i.test(message)) return reply.code(404).send({ error: 'Instance not found' });
        throw err;
      }
    });
  };
}

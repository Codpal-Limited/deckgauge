import type { FastifyInstance } from 'fastify';
import type { Octokit } from '@octokit/rest';
import { PickerQuerySchema, type PickerResponse } from '@deckgauge/shared';
import type { GitHubInstance, PrismaClient } from '@deckgauge/db';
import { listRepos } from './board-github-picker.service.js';
import { all, board, orgRole } from '../auth/policy.js';
import { requireOrganizationId } from '../organizations/request-organization.js';

/**
 * GET /api/boards/:boardId/github/picker
 *
 * Lists repos under an org for a given GitHubInstance, with glob filtering,
 * archived filter, pagination, and enabled-flag derived from BoardGitHubSource.
 *
 * Repo convention diverges from the plan in two places:
 * - prisma is provided via DI deps factory (no app.prisma decorator).
 * - octokitFor is also injected (no app.octokitFor decorator) — matches the
 *   sibling githubAdapterFor pattern in board-github-source.routes.ts.
 */
export function boardGitHubPickerRoutes(deps: {
  prisma: PrismaClient;
  octokitFor: (instance: GitHubInstance) => Octokit;
}) {
  return async function plugin(app: FastifyInstance): Promise<void> {
    app.get<{ Params: { boardId: string } }>(
      '/api/boards/:boardId/github/picker',
      {
        config: {
          // `board(VIEWER)` alone was the whole gate, and a board role says
          // nothing about which organization owns the connection named by
          // `?instanceId`. It also cannot supply the tenant this handler now
          // filters on: `board` deliberately allows a membership-less caller
          // through on a bare board grant, so `requireOrganizationId` would 500.
          // `orgRole('VIEWER')` is the floor that guarantees a membership —
          // VIEWER, not MEMBER, because listing repositories is a read an org
          // VIEWER may legitimately do.
          policy: all(board('VIEWER'), orgRole('VIEWER')),
        },
      },
      async (req, reply) => {
        const query = req.query as Record<string, string | undefined>;
        const parsed = PickerQuerySchema.safeParse({
          instanceId: query.instanceId,
          pattern: query.pattern,
          page: query.page === undefined ? undefined : Number(query.page),
          includeArchived:
            query.includeArchived === undefined ? undefined : query.includeArchived === 'true',
        });
        if (!parsed.success) {
          return reply.code(400).send({ error: parsed.error.flatten() });
        }

        // Resolved outside the try: `requireOrganizationId` throws to signal a
        // ROUTE-TABLE bug (a handler reached with no membership), and the catch
        // below would flatten that into a 502 "github_error" — hiding the
        // misconfiguration behind a plausible upstream failure.
        const organizationId = requireOrganizationId(req);

        try {
          // Scoped, and `findFirst` rather than `findUniqueOrThrow`: `instanceId`
          // arrives on the query string, so resolving it by id alone
          // authenticated an Octokit client with whatever stored PAT that id
          // happened to name — a member of one organization could pass another
          // organization's instance id and list their private repositories.
          // Prisma's unique lookup cannot express `{ id, organizationId }`, so
          // `findFirst` is the correct shape here, not a workaround.
          //
          // Resolved BEFORE `octokitFor`, so a refused id never reaches GitHub.
          const instance = await deps.prisma.gitHubInstance.findFirst({
            where: {
              id: parsed.data.instanceId,
              organizationId,
            },
          });
          if (!instance) {
            // Same 404 a genuinely unknown id gets: distinguishing "exists, but
            // is someone else's" from "does not exist" is itself a cross-tenant
            // disclosure.
            return reply.code(404).send({
              error: 'instance_not_found',
              message: 'GitHub connection not found.',
            });
          }
          const octokit = deps.octokitFor(instance);

          const result: PickerResponse = await listRepos({
            prisma: deps.prisma,
            octokit,
            boardId: req.params.boardId,
            instanceId: parsed.data.instanceId,
            org: instance.org,
            pattern: parsed.data.pattern,
            page: parsed.data.page,
            includeArchived: parsed.data.includeArchived,
          });
          return reply.send(result);
        } catch (err: unknown) {
          // Octokit RequestError carries the HTTP code on `.status` (not
          // `.statusCode`), so Fastify's default handler would mask it as 500.
          // Map auth failures explicitly so the client can prompt for a new token.
          const status = (err as { status?: number } | null)?.status;
          if (status === 401 || status === 403) {
            return reply.code(status).send({
              error: 'github_auth_failed',
              message: `GitHub rejected the connection token (${status}). It may be expired or revoked — replace the token and retry.`,
            });
          }
          req.log.error({ err }, 'github picker listRepos failed');
          return reply.code(502).send({
            error: 'github_error',
            message: 'Could not list repositories from GitHub. Try again shortly.',
          });
        }
      },
    );
  };
}

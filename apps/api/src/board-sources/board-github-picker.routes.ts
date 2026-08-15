import type { FastifyInstance } from 'fastify';
import type { Octokit } from '@octokit/rest';
import { PickerQuerySchema, type PickerResponse } from '@deckgauge/shared';
import type { GitHubInstance, PrismaClient } from '@deckgauge/db';
import { listRepos } from './board-github-picker.service.js';
import { board } from '../auth/policy.js';

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
      { config: { policy: board('VIEWER') } },
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

        try {
          const instance = await deps.prisma.gitHubInstance.findUniqueOrThrow({
            where: { id: parsed.data.instanceId },
          });
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
          const code = (err as { code?: string } | null)?.code;
          if (code === 'P2025') {
            return reply.code(404).send({
              error: 'instance_not_found',
              message: 'GitHub connection not found.',
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

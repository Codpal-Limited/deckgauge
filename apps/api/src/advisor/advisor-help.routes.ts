// Product-help SSE ask route. Deliberately SEPARATE from
// `/boards/:boardId/advisor/ask`: that route is gated by `requireBoardAccess`
// and cross-checks its body against the authorized path param, and widening it
// to make `boardId` optional would drag product help inside the board-authz
// surface for no benefit. This route has no board scope and, in Phase 1, no
// board data tools at all — only the documentation corpus.
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@deckgauge/db';
import { advisorHelpAskRequestSchema } from '@deckgauge/shared';
import { hasBoardAccess } from '../board-access/board-access.middleware.js';
import { orgRole } from '../auth/policy.js';
import { connectionCaller } from '../connections/connection-caller.js';
import { RoadmapService } from '../roadmaps/roadmap.service.js';
import { AdvisorHelpService } from './advisor-help.service.js';
import { inferenceLock } from './inference-lock.js';
import { AdvisorConfigService } from './advisor-config.service.js';
import { resolveProvider } from './llm-provider.js';
import { isMappedPageKey } from './page-state/page-state.resolver.js';
import { createPathAllowlist } from './source-access/path-allowlist.js';
import { resolveSourceRoots } from './source-access/source-roots.js';

export function advisorHelpRoutes({ prisma }: { prisma: PrismaClient }) {
  return async function (app: FastifyInstance) {
    // Constructed once, here in the plugin factory body — Fastify executes
    // this exactly once at registration, not per-request. AdvisorHelpService's
    // constructor loads the seven-doc help corpus from disk, so a per-request
    // construction would re-read it on every question.
    const help = new AdvisorHelpService();
    const configService = new AdvisorConfigService(prisma);
    const roadmapService = new RoadmapService(prisma);

    // Built once, here, for the same reason the services are: `resolveSourceRoots`
    // walks up for the workspace marker and `stat`s three directories, and doing
    // that per question would touch the filesystem on every keystroke-driven
    // ask. The roots cannot change under a running container — the image is
    // immutable — so a single resolution is also the correct one.
    //
    // Resolved eagerly rather than lazily on first use: a plugin that fails to
    // register is a loud, immediate problem, whereas a lazy resolution failing
    // mid-question would surface as a mysteriously degraded answer.
    const sourceAllowlist = createPathAllowlist(await resolveSourceRoots());

    app.post('/advisor/help/ask', { config: { policy: orgRole('VIEWER') } }, async (req, reply) => {
      // This route has no board or entity to scope against — it's a global
      // help assistant — so `AUTHENTICATED` (declared above) is the right
      // policy kind. Inside `protectedApp`, `buildPolicyPlugin`'s preHandler
      // now runs BEFORE this handler and denies an unauthenticated caller with
      // its own shared 401 body, `{ error: 'Authentication required' }`
      // (`auth/policy.ts`'s `DENY_401`) — so in production this manual check
      // never fires.
      //
      // It stays anyway, for two reasons. First, defense in depth: any context
      // that reaches this handler WITHOUT the policy plugin registered (e.g. a
      // route wired up outside `protectedApp`, or a bare-Fastify unit test)
      // still gets a hard 401 rather than a null-`user` crash. Second, the
      // CODE STRING below is `requireBoardAccess`'s (board-access.middleware.ts),
      // character for character, and the web client's `advisor-error-copy.ts`
      // still keys on it: `Unauthorized` and `Forbidden` map to
      // "your session has expired" and "you need board access" respectively.
      // `advisor-error-copy.ts` ALSO now recognises the policy layer's
      // `Authentication required` string for the same reason — the caller may
      // be denied by either layer depending on where the request lands, and
      // both must read as the same expired-session message to the user. Do
      // not weaken/remove this check on the assumption the policy layer alone
      // covers it; do not change the string without updating
      // `advisor-error-copy.ts` in lockstep.
      if (!req.user) return reply.code(401).send({ error: 'Unauthorized' });
      const userId = req.user.id;

      const parsed = advisorHelpAskRequestSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid request' });

      // `boardId` is an optional HINT for live state (Phase 2), never what
      // authorizes this request — but if one is supplied it must still be a
      // board this user may read, so a bad id cannot become a probe.
      //
      // `verifiedBoardId` is captured HERE, inside the branch guarded by a
      // successful `hasBoardAccess` call, and nowhere else. Everything below
      // reads this local, never `parsed.data.boardId` again — if it did, the
      // value reaching the page-state resolvers would be textually
      // independent of the value that was actually checked, which is exactly
      // the shape that rots into a bypass the first time one of the two
      // branches is edited without the other.
      let verifiedBoardId: string | undefined;
      if (parsed.data.boardId) {
        const allowed = await hasBoardAccess(prisma, userId, parsed.data.boardId, 'VIEWER');
        if (!allowed) return reply.code(403).send({ error: 'Forbidden' });
        verifiedBoardId = parsed.data.boardId;
      }

      // The second, independent authorization path: `roadmapId` is an
      // optional HINT for the standalone Roadmap entity's live state, never
      // what authorizes this request — but `hasBoardAccess` does not govern
      // a standalone roadmap (it has its own `RoadmapAccess` table), so a
      // supplied hint must clear its own check through `RoadmapService.getRole`.
      // Any role at all satisfies a read; `VIEWER` is the lowest, so there is
      // no rank comparison to make here, unlike `hasBoardAccess`'s `minRole`.
      //
      // `verifiedRoadmapId` is captured HERE, inside the branch guarded by a
      // non-null `getRole` result, and nowhere else — mirroring
      // `verifiedBoardId` above for the same reason: everything below reads
      // this local, never `parsed.data.roadmapId` again.
      let verifiedRoadmapId: string | undefined;
      if (parsed.data.roadmapId) {
        const role = await roadmapService.getRole(parsed.data.roadmapId, userId);
        if (!role) return reply.code(403).send({ error: 'Forbidden' });
        verifiedRoadmapId = parsed.data.roadmapId;
      }

      // Resolved once, here, and read by everything below — the config lookup,
      // the page-state deps and the source-lookup flag all belong to the SAME
      // organization, and deriving it three times invites two of them to drift.
      // Throws (500) rather than denying when the request carries no membership:
      // that can only mean this route lost its `orgRole` policy, and a
      // plausible-looking 403 would hide the misconfiguration.
      const advisorCaller = connectionCaller(req);

      const config = await configService.getConfig(advisorCaller.organizationId);
      if (!config) return reply.code(409).send({ error: 'advisor_not_configured' });

      const pageKey = parsed.data.pageContext.key;

      // Offer live page state ONLY for a page that has a resolver. On an
      // unmapped page (`board`, `boards`, `comparison`, `settings`, `generic`)
      // `get_page_state` could answer nothing but "this screen is not mapped",
      // so exposing it would spend a tool round trip — and its tokens — on
      // every question to learn that. Omitting the deps is what makes
      // `AdvisorHelpService.ask`'s documented documentation-only branch real in
      // production rather than test-only, and it keeps the resolver dispatcher
      // unreachable from those pages altogether.
      const pageState = isMappedPageKey(pageKey)
        ? {
            prisma,
            // The authenticated caller, from `req.user.id` — never the body.
            // The roadmap read filters groups by this person's board access,
            // so omitting it would let a roadmap role read project rows out of
            // boards they hold no role on.
            userId,
            // The tenant boundary for every instance-wide resolver read, and
            // the ownership boundary within it. Both come from
            // `connectionCaller(req)` — the ONE place `membership.role` becomes
            // "is an organization admin", so this route cannot reach for
            // `req.isAdmin` (which unions the Keycloak realm role and
            // `users.is_admin` and is not tenant-scoped). Until 2026-08-26
            // neither was passed at all and the resolvers read every
            // organization's rows: TENANCY-PROGRAMME §5a.
            organizationId: advisorCaller.organizationId,
            isOrgAdmin: advisorCaller.isOrgAdmin,
            boardId: verifiedBoardId,
            roadmapId: verifiedRoadmapId,
            // Diagnostic only — synchronous (req.log.error never returns a
            // promise) because the seam it fills, `PageStateToolDeps.logError`,
            // is typed `=> void` and called without awaiting; an async logger
            // here would produce an unhandled rejection on failure. Carries the
            // page key for triage but never the user's question text and never
            // reaches the model — the model only ever sees the fixed `reason`
            // string from `page-state-tools.ts`.
            logError: (error: unknown) =>
              req.log.error({ err: error, pageKey }, 'advisor help: get_page_state resolver failed'),
          }
        : undefined;

      // The operator switch. Read AFTER every authorization check and after the
      // config read — it is a feature flag, not an authorization decision, and
      // a flag consulted ahead of an authz check is how flag logic ends up
      // deciding who may read what.
      //
      // Omitting the deps when it is off is what makes the switch real: tools
      // that were still offered but refused every call would cost a tool round
      // trip per question to say no. Also omitted when this deployment exposes
      // no readable roots at all — there is nothing for the tools to search, so
      // offering them would be the same empty round trip.
      const sourceLookup =
        sourceAllowlist.roots.length > 0 && (await configService.isSourceLookupEnabled(advisorCaller.organizationId))
          ? {
              allowlist: sourceAllowlist,
              // Synchronous, like the page-state seam above and for the same
              // reason: `SourceToolDeps.logError` is typed `=> void` and called
              // without awaiting, so an async logger would produce an unhandled
              // rejection. Never carries the question text.
              logError: (error: unknown) =>
                req.log.error({ err: error, pageKey }, 'advisor help: source lookup failed'),
            }
          : undefined;

      // Same manual SSE hijack as the board route — Fastify must not try to
      // send its own reply once frames start going out by hand.
      //
      // Headers go out BEFORE the lock is acquired: a queued caller then holds an
      // open, quiet SSE stream rather than a request that looks hung.
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      try {
        // Shares the single process-wide lock with the board route, so a board
        // question and a help question cannot run inference concurrently. Spans
        // ask() AND the drain, because ask() returns an AsyncIterable and the
        // inference happens while it is consumed.
        await inferenceLock.run(async () => {
          const run = help.ask({
            provider: resolveProvider(config),
            question: parsed.data.question,
            pageLabel: parsed.data.pageContext.label,
            pageKey,
            history: parsed.data.history,
            pageState,
            sourceLookup,
          });
          for await (const chunk of run.textStream) {
            reply.raw.write(`data: ${JSON.stringify({ type: 'delta', text: chunk })}\n\n`);
          }
          const toolCalls = await run.toolCalls;
          reply.raw.write(`data: ${JSON.stringify({ type: 'done', toolCalls })}\n\n`);
        });
      } catch (err) {
        reply.raw.write(
          `data: ${JSON.stringify({
            type: 'error',
            message: err instanceof Error ? err.message : 'advisor help failed',
          })}\n\n`,
        );
      } finally {
        reply.raw.end();
      }
    });
  };
}

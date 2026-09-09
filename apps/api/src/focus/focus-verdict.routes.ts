import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { FocusVerdictOverrideSchema } from '@deckgauge/shared';
import type { PrismaClient } from '@deckgauge/db';
import { board } from '../auth/policy.js';
import { WidgetCache } from '../widgets/widget-cache.js';
import { clearVerdict, setHumanVerdict, type FocusVerdictDeps } from './focus-verdict.service.js';

/** 64 hex characters — exactly what `taskFingerprint` emits and the column holds. */
const VerdictParams = z.object({
  boardId: z.string().uuid(),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
});

/**
 * Setting and clearing a human class verdict from the ledger.
 *
 * **These handlers require an organization and the stage-map handlers next door
 * deliberately do not** — see `focus-config.routes.ts`'s header, which explains
 * that `board(...)` admits a caller holding a bare `BoardAccess` grant with no
 * `OrgMembership`, so reaching for an organization there would break exactly
 * that caller.
 *
 * A verdict has no such option. `focus_verdicts` is keyed
 * `(organizationId, fingerprint)`, so for a caller with no organization there is
 * genuinely no row to write. The two files are consistent, not contradictory:
 * each reaches for a tenant only where its table has one.
 *
 * What this does NOT use is `requireOrganizationId`. That helper throws
 * `MissingOrganizationError`, which is documented as a 500 on purpose — it means
 * "this route forgot to declare an orgRole policy", and a plausible-looking 403
 * would hide the misconfiguration. Here the membership-less caller is a shape
 * `board(...)` admits by design, so it is a real refusal to state, not a bug to
 * surface.
 */
export function focusVerdictRoutes(deps: {
  prisma: PrismaClient;
  /**
   * The widget-data plugin's cache instance. Pass the SAME one `widgetDataRoutes`
   * and `focusConfigRoutes` get, or a write will not evict the payload it
   * invalidates and the ledger keeps the old class for the rest of the TTL.
   */
  cache?: WidgetCache;
}) {
  const cache = deps.cache ?? new WidgetCache(60_000);

  /**
   * Null when the caller holds board access but belongs to no organization.
   * Returning null rather than throwing keeps the refusal a 403 the handler
   * states, for the reason in this file's header.
   */
  const verdictDeps = (req: FastifyRequest): FocusVerdictDeps | null => {
    const organizationId = req.membership?.organizationId;
    return organizationId ? { prisma: deps.prisma, organizationId } : null;
  };

  const NO_ORG = {
    error:
      'A classification is stored per organization, and this account has board access without an organization membership.',
  };

  return async function plugin(app: FastifyInstance) {
    app.put<{ Params: { boardId: string; fingerprint: string } }>(
      '/boards/:boardId/focus/verdicts/:fingerprint',
      { config: { policy: board('EDITOR') } },
      async (req, reply) => {
        const params = VerdictParams.safeParse(req.params);
        if (!params.success) return reply.code(400).send({ error: params.error.flatten() });

        const body = FocusVerdictOverrideSchema.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: body.error.flatten() });

        const d = verdictDeps(req);
        if (!d) return reply.code(403).send(NO_ORG);

        await setHumanVerdict(d, {
          fingerprint: params.data.fingerprint,
          class: body.data.class,
          reason: body.data.reason,
          user: { id: req.user.id, name: req.user.name },
        });

        // After the write, so a refused payload evicts nothing — the same
        // ordering, and the same reason, as the stage-map save.
        cache.invalidateBoard(params.data.boardId);
        return reply.code(204).send();
      },
    );

    app.delete<{ Params: { boardId: string; fingerprint: string } }>(
      '/boards/:boardId/focus/verdicts/:fingerprint',
      { config: { policy: board('EDITOR') } },
      async (req, reply) => {
        const params = VerdictParams.safeParse(req.params);
        if (!params.success) return reply.code(400).send({ error: params.error.flatten() });

        const d = verdictDeps(req);
        if (!d) return reply.code(403).send(NO_ORG);

        // The return value is deliberately not turned into a 404. Clearing an
        // override that is already absent leaves the caller in exactly the state
        // they asked for, and the ledger cannot know whether a row exists — the
        // class it shows may have come from a rule.
        await clearVerdict(d, params.data.fingerprint);

        cache.invalidateBoard(params.data.boardId);
        return reply.code(204).send();
      },
    );
  };
}

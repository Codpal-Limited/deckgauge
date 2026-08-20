import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@deckgauge/db';
import { advisorConfigSchema, advisorSourceLookupSchema } from '@deckgauge/shared';
import { AdvisorConfigService } from './advisor-config.service.js';
import { ORG_ADMIN } from '../auth/policy.js';
import { requireOrganizationId } from '../organizations/request-organization.js';

export function advisorConfigRoutes({ prisma }: { prisma: PrismaClient }) {
  return async function (app: FastifyInstance) {
    const service = new AdvisorConfigService(prisma);

    app.get('/advisor/config', { config: { policy: ORG_ADMIN } }, async (req, reply) => {
      const cfg = await service.getConfig(requireOrganizationId(req));
      if (!cfg) return reply.send({ configured: false });
      // Reported on both branches: an operator checking whether source lookup
      // is on should not have to know which provider they configured, and the
      // effective value can come from the row or from the environment.
      const sourceLookupEnabled = await service.isSourceLookupEnabled(requireOrganizationId(req));
      if (cfg.provider === 'anthropic') {
        return reply.send({
          configured: true,
          provider: 'anthropic',
          model: cfg.model,
          hasApiKey: cfg.apiKey.length > 0,
          sourceLookupEnabled,
        });
      }
      return reply.send({
        configured: true,
        provider: 'ollama',
        model: cfg.model,
        baseUrl: cfg.baseUrl,
        sourceLookupEnabled,
      });
    });

    /**
     * The operator switch for `search_source`/`read_source`.
     *
     * `ORG_ADMIN`, like every other route here: it changes what the Advisor may
     * read, and the row it flips is this organization's row.
     *
     * 409 rather than creating a row when none exists — `AdvisorConfig`
     * requires `provider` and `model`, so an upsert here would have to
     * fabricate provider credentials. The message names the switch that
     * deployment does have, since a stack configured purely from `.env` is
     * exactly the case with no row.
     */
    app.put(
      '/advisor/config/source-lookup',
      { config: { policy: ORG_ADMIN } },
      async (req, reply) => {
        const parsed = advisorSourceLookupSchema.safeParse(req.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: 'invalid config', details: parsed.error.flatten() });
        }
        const updated = await service.setSourceLookupEnabled(
          requireOrganizationId(req),
          parsed.data.enabled,
        );
        if (!updated) {
          return reply.code(409).send({
            error: 'advisor_not_configured',
            message:
              'There is no saved Advisor configuration to change. Save a provider first, or set ADVISOR_SOURCE_LOOKUP=0 in the deployment environment.',
          });
        }
        return reply.code(204).send();
      },
    );

    app.put('/advisor/config', { config: { policy: ORG_ADMIN } }, async (req, reply) => {
      const parsed = advisorConfigSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid config', details: parsed.error.flatten() });
      }
      await service.saveConfig(requireOrganizationId(req), parsed.data);
      return reply.code(204).send();
    });

    app.post('/advisor/config/test', { config: { policy: ORG_ADMIN } }, async (req, reply) => {
      const parsed = advisorConfigSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid config', details: parsed.error.flatten() });
      }
      return reply.send(await service.testConnection(parsed.data));
    });
  };
}

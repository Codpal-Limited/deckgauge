import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { LocationSearchResponse } from '@deckgauge/shared';
import { LocationService } from './location.service.js';
import { AUTHENTICATED } from '../auth/policy.js';

// One shared instance; the dataset is loaded once at module load.
const service = new LocationService();

const QuerySchema = z.object({
  q: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(20).optional(),
});

export async function locationRoutes(app: FastifyInstance) {
  app.get('/locations/search', { config: { policy: AUTHENTICATED } }, async (req, reply) => {
    const parsed = QuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const results = service.search(parsed.data.q, parsed.data.limit ?? 8);
    const body: LocationSearchResponse = { results };
    return reply.send(body);
  });
}

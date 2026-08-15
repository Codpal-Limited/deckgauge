import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@deckgauge/db';
import { z } from 'zod';
import { PresetService, type PresetError } from './presets.service.js';
import { board } from '../auth/policy.js';

const ApplyPresetBody = z.object({
  presetKey: z.string().min(1).max(50),
});

export async function presetsRoutes(
  app: FastifyInstance,
  { prisma }: { prisma: PrismaClient }
) {
  const service = new PresetService(prisma);

  // POST /boards/:boardId/views/apply-preset
  //   201 + { viewId, widgetCount } on success
  //   409 + { error: 'preset_already_applied' } if already applied
  //   404 + { error: 'unknown_preset' } if presetKey not registered
  app.post<{ Params: { boardId: string }; Body: { presetKey: string } }>(
    '/boards/:boardId/views/apply-preset',
    { config: { policy: board('EDITOR') } },
    async (req, reply) => {
      const { boardId } = req.params;
      const parsed = ApplyPresetBody.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: 'invalid_body', issues: parsed.error.issues };
      }

      try {
        const result = await service.applyPreset(boardId, parsed.data.presetKey);
        reply.code(201);
        return result;
      } catch (e) {
        const err = e as PresetError;
        if (err.code === 'PRESET_ALREADY_APPLIED') {
          reply.code(409);
          return { error: 'preset_already_applied' };
        }
        if (err.code === 'UNKNOWN_PRESET') {
          reply.code(404);
          return { error: 'unknown_preset' };
        }
        throw e;
      }
    }
  );
}

import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@deckgauge/db';
import { createReadStream } from 'node:fs';
import { access, constants } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod/v4';
import { MAX_AVATAR_BYTES } from '@deckgauge/shared';
import { AUTHENTICATED } from '../auth/policy.js';
import type { UploadService } from '../uploads/upload.service.js';
import { ProfileService, NotAnImageError } from './profile.service.js';

const UuidSchema = z.string().uuid();

/**
 * The signed-in person's own profile and photo.
 *
 * Every route is `AUTHENTICATED` and acts on `req.user` only — there is no
 * user id in any of these URLs to tamper with. The organization part of the
 * profile comes from `req.membership` when the auth plugin resolved one; a
 * person with no membership still sees (and can photo) their own account.
 */
export async function profileRoutes(
  app: FastifyInstance,
  { prisma, uploadService }: { prisma: PrismaClient; uploadService: UploadService },
) {
  const service = new ProfileService(prisma, uploadService);

  app.get('/me/profile', { config: { policy: AUTHENTICATED } }, async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'Not signed in' });
    return service.getProfile(req.user.id, req.membership ?? null, !!req.isAdmin);
  });

  app.put('/me/avatar', { config: { policy: AUTHENTICATED } }, async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'Not signed in' });
    if (!req.isMultipart()) return reply.code(400).send({ error: 'Send the photo as multipart form data' });

    const file = await req.file({ limits: { fileSize: MAX_AVATAR_BYTES } });
    if (!file) return reply.code(400).send({ error: 'No file provided' });

    let buffer: Buffer;
    try {
      buffer = await file.toBuffer();
    } catch (err) {
      if ((err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
        return reply.code(413).send({ error: 'Photo is larger than 5 MB' });
      }
      throw err;
    }

    try {
      return await service.setAvatar(req.user.id, buffer);
    } catch (err) {
      if (err instanceof NotAnImageError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  app.delete('/me/avatar', { config: { policy: AUTHENTICATED } }, async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'Not signed in' });
    await service.removeAvatar(req.user.id);
    return reply.code(204).send();
  });

  // Served here rather than through GET /api/uploads/:id, whose policy resolves
  // a board or org tree from the upload — an avatar has neither. The read rule
  // lives in ProfileService.findReadableAvatar; every refusal is a 404 so the
  // route says nothing about whether the id exists.
  app.get<{ Params: { id: string } }>(
    '/api/user-avatars/:id',
    { config: { policy: AUTHENTICATED } },
    async (req, reply) => {
      if (!UuidSchema.safeParse(req.params.id).success) return reply.code(400).send({ error: 'bad id' });
      if (!req.user) return reply.code(404).send({ error: 'Not found' });

      const upload = await service.findReadableAvatar(
        req.user.id,
        req.membership?.organizationId ?? null,
        req.params.id,
      );
      if (!upload) return reply.code(404).send({ error: 'Not found' });

      const filePath = join(uploadService.dir, upload.filename);
      try {
        await access(filePath, constants.R_OK);
      } catch {
        req.log.error({ uploadId: upload.id, filePath }, 'avatar row has no readable file on disk');
        return reply.code(404).send({ error: 'Not found' });
      }
      reply.header('Content-Type', upload.mimeType);
      reply.header('X-Content-Type-Options', 'nosniff');
      return reply.send(createReadStream(filePath));
    },
  );
}

import type { FastifyInstance } from 'fastify';
import { createReadStream } from 'node:fs';
import { access, constants } from 'node:fs/promises';
import { join } from 'node:path';
import type { UploadService } from './upload.service.js';
import { board, viaEntity, viaBranch, fromQuery, fromParam } from '../auth/policy.js';

const ALLOWED_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

export async function uploadRoutes(
  app: FastifyInstance,
  { service }: { service: UploadService },
) {
  // POST /api/uploads?projectId=:id  OR  /api/uploads?orgEmployeeId=:id — one
  // route, two unrelated resources with two unrelated access models.
  //
  // The rule (not a snapshot of today's wiring): an upload is gated on
  // whatever owns the row it will be attached to, at the same rank a direct
  // edit of that row would require. `?projectId=` therefore needs EDITOR on
  // that project's board; `?orgEmployeeId=` attaches the file to an
  // OrgEmployee, which an org tree owns, so it needs EDITOR on that tree via
  // `OrgTreeAccess` — the `then: 'orgEntity'` branch arm in policy.ts.
  //
  // Never give either arm a `then` that gates nothing. Such an arm resolves to
  // an empty board set, which `evaluatePolicy` allows outright — turning this
  // endpoint into an unauthenticated-in-effect write into data the caller cannot
  // read back. This is the route that comment was written for, and the shape it
  // warns about is now refused by `resolveBoardIds` rather than only prohibited
  // in prose: `then: 'authenticated'` no longer exists in `BoardBranch`, and an
  // unrecognised `then` denies. The rule is restated anyway because it is about
  // any FUTURE arm, not about that one value.
  //
  // These must be tried as ordered, mutually-exclusive branches, not OR'd: a
  // failed EDITOR check on the projectId branch must deny outright, never
  // fall through to the orgEmployeeId branch just because that query param
  // happens to be unset.
  app.post<{ Querystring: { projectId?: string; orgEmployeeId?: string } }>(
    '/api/uploads',
    {
      config: {
        policy: board('EDITOR', viaBranch([
          { when: fromQuery('projectId'), then: 'project' },
          { when: fromQuery('orgEmployeeId'), then: 'orgEntity', orgModel: 'orgEmployee' },
        ])),
      },
    },
    async (req, reply) => {
      const { projectId, orgEmployeeId } = req.query;
      if (!projectId && !orgEmployeeId) {
        return reply.status(400).send({ error: 'projectId or orgEmployeeId is required' });
      }

      const data = await req.file();
      if (!data) {
        return reply.status(400).send({ error: 'No file provided' });
      }

      if (!ALLOWED_MIME_TYPES.has(data.mimetype)) {
        await data.toBuffer(); // drain
        return reply
          .status(400)
          .send({ error: `Unsupported mime type: ${data.mimetype}` });
      }

      const buffer = await data.toBuffer();

      try {
        const upload = await service.saveFile({
          projectId,
          orgEmployeeId,
          mimeType: data.mimetype,
          buffer,
        });
        return reply.send({ id: upload.id, url: `/api/uploads/${upload.id}` });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        if (msg === 'Project not found' || msg === 'Employee not found') {
          return reply.status(422).send({ error: msg });
        }
        throw err;
      }
    },
  );

  // GET /api/uploads/:id — :id is the upload id; the board is reachable
  // through Upload.projectId → Project.boardId (two hops, nullable). An
  // upload with no projectId is org-employee-scoped instead; `viaEntity`'s
  // `upload` resolution (policy.ts) resolves that employee's org tree and
  // requires the caller to hold at least this policy's role on it
  // (`hasOrgTreeRole`) — the same rule POST /api/uploads applies on the write
  // side, applied here on the stored row since there's no query param to
  // branch on. Being signed in is not enough on either side.
  app.get<{ Params: { id: string } }>(
    '/api/uploads/:id',
    { config: { policy: board('VIEWER', viaEntity('upload', fromParam('id'))) } },
    async (req, reply) => {
      const upload = await service.findById(req.params.id);
      if (!upload) {
        return reply.status(404).send({ error: 'Not found' });
      }

      const filePath = join(service.dir, upload.filename);

      // A row with no file behind it is not a server fault, and answering 500
      // with an ENOENT stack said it was. That is how the uploads-directory bug
      // presented for weeks: the api wrote images into the container's ephemeral
      // layer, a deploy destroyed them, and every one of the six surviving rows
      // then answered 500 — indistinguishable, from the outside, from an api
      // that had simply fallen over. 404 states the true condition (this file is
      // gone), and the log line below is where the severity lives, because the
      // client sees an ordinary missing resource while the operator sees data
      // loss naming the exact path that was expected.
      try {
        await access(filePath, constants.R_OK);
      } catch {
        req.log.error(
          { uploadId: upload.id, filePath },
          'upload row has no readable file on disk',
        );
        return reply.status(404).send({ error: 'Not found' });
      }

      reply.header('Content-Type', upload.mimeType);
      return reply.send(createReadStream(filePath));
    },
  );
}

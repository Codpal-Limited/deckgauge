import { resolve } from 'node:path';

/**
 * The single place that decides where uploaded files are stored.
 *
 * `UPLOADS_DIR` is the deployment's statement of where durable storage is
 * mounted. It is honoured verbatim (resolved against `cwd` if relative, so a
 * stored path never depends on where the process was started from), and only
 * when it is ABSENT does this fall back to `<cwd>/uploads` — the convenient
 * default for a developer running `pnpm --filter @deckgauge/api dev` from the
 * package directory.
 *
 * Absent and set-but-empty are different things and are treated differently: an
 * empty value throws. See `uploads-dir.test.ts` for why — compose's
 * `"${UPLOADS_DIR:-}"` idiom makes it the most likely way this defect returns.
 *
 * The fallback is NOT the container's shape: see the header of
 * `uploads-dir.test.ts` for why deriving the directory from `cwd()` cost six
 * comment images on staging, and `../__isolation__/uploads-persistence.test.ts`
 * for the assertion that the image's configured value still matches the volume
 * compose mounts.
 */
export function resolveUploadsDir(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string {
  const raw = env['UPLOADS_DIR'];
  if (raw === undefined) return resolve(cwd, 'uploads');

  const configured = raw.trim();
  if (configured.length === 0) {
    throw new Error(
      'UPLOADS_DIR is set but empty, which is an operator error rather than a request for ' +
        'the default. Either unset it, or give it the absolute path of the directory where ' +
        'durable upload storage is mounted (the api image ships /app/uploads, which is where ' +
        'docker-compose.yml mounts the uploads_data volume). Falling back silently here is how ' +
        'uploads were written to the container\'s ephemeral layer and lost.',
    );
  }

  return resolve(cwd, configured);
}

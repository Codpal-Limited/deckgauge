import { access, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The only source trees the Advisor may read, relative to the repository root.
 *
 * These three are exactly what `apps/api/Dockerfile` copies into the image
 * (`COPY packages/db/`, `COPY packages/shared/`, `COPY apps/api/`) and they are
 * source this repo already publishes under FSL-1.1-Apache-2.0. Proprietary code
 * lives outside this tree, behind the `onUserAuthenticated` seam, so widening
 * this list is how that guarantee would be lost.
 */
export const SOURCE_ROOT_RELATIVE_PATHS: readonly string[] = [
  'apps/api/src',
  'packages/shared/src',
  'packages/db/prisma',
];

/**
 * Readable extensions. Test files are included deliberately — `roadmap-schedule.test.ts`
 * documents scheduling behaviour better than prose does.
 *
 * Note what is absent and why it needs no denylist: there is no entry that
 * could ever match `.env` (excluded from the image by `.dockerignore` anyway),
 * a `.yaml`, a `.pem` or a lockfile. Allow-known-good means the question is
 * always "is this one of three?", never "did we remember to block that?".
 */
export const ALLOWED_SOURCE_EXTENSIONS: readonly string[] = ['.ts', '.prisma', '.md'];

/** The file whose presence marks the repository root in every checkout and in the image. */
const WORKSPACE_MARKER = 'pnpm-workspace.yaml';

/**
 * Walks up from `startDir` looking for the workspace marker.
 *
 * Deliberately a walk rather than a fixed count of `..` segments. This module
 * sits at `apps/api/src/advisor/source-access/` when the container runs
 * `npx tsx src/index.ts` from `/app/apps/api` (`apps/api/Dockerfile:31-33`),
 * but `apps/api`'s own `build` is `tsc --build` and its `start` is
 * `node dist/index.js` — under which the compiled module sits at a different
 * depth. A hard-coded `../../../../..` would be correct in exactly one of those
 * layouts and silently wrong in the other. `pnpm-workspace.yaml` exists in both
 * (the Dockerfile copies it to `/app`), so the marker is the reliable anchor.
 */
export async function findRepoRoot(startDir: string): Promise<string | null> {
  let dir = path.resolve(startDir);
  for (;;) {
    try {
      await access(path.join(dir, WORKSPACE_MARKER));
      return dir;
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }
}

/**
 * The absolute, `realpath`-resolved source roots present in this deployment.
 *
 * Resolved here, once, because the allowlist compares real paths: on macOS
 * `/tmp` is a symlink to `/private/tmp`, so an unresolved root would reject
 * every path under a temp-directory fixture — and in staging the deploy
 * bind-mounts from `/tmp/vpc-deploy-main`, so the same mismatch is possible in
 * production, not just in tests.
 *
 * A missing root is not an error: the api image ships all three, but a trimmed
 * deployment may omit one, and the honest response is to read the rest.
 */
export async function resolveSourceRoots(
  startDir: string = path.dirname(fileURLToPath(import.meta.url)),
): Promise<string[]> {
  const repoRoot = await findRepoRoot(startDir);
  if (!repoRoot) return [];

  const roots: string[] = [];
  for (const relative of SOURCE_ROOT_RELATIVE_PATHS) {
    const candidate = path.join(repoRoot, relative);
    try {
      if ((await stat(candidate)).isDirectory()) roots.push(await realpath(candidate));
    } catch {
      // Absent in this deployment — skip it rather than failing the whole tool.
    }
  }
  return roots;
}

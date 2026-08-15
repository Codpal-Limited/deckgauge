import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { ALLOWED_SOURCE_EXTENSIONS } from './source-roots.js';

export type AllowlistResult =
  | { ok: true; absolutePath: string; relativePath: string }
  | { ok: false; reason: string };

export interface PathAllowlist {
  /** Resolves a caller-supplied path, or explains why it is not readable. */
  resolve(input: string): Promise<AllowlistResult>;
  readonly roots: readonly string[];
}

/**
 * `reason` strings are written for the model, so they explain the rule rather
 * than the internals: a path that lost is told which rule it lost to, never
 * where the roots are on disk or what else exists there.
 */
const REASONS = {
  unusable: 'That is not a usable file path.',
  extension: `Only ${ALLOWED_SOURCE_EXTENSIONS.join(', ')} files can be read.`,
  outside: 'That path is outside the allowed source roots.',
  symlink: 'That path is a symlink, which is never followed.',
  missing: 'There is no such file in the source tree.',
  notFile: 'That path is not a file.',
} as const;

/**
 * **The security boundary of Phase 2b.** Every path either tool reads passes
 * through here first.
 *
 * Allow-known-good, never block-known-bad: a path is readable only when its
 * extension is one of three, its *real* path sits under one of the configured
 * roots, and it is not itself a symlink. There is no denylist to keep in sync,
 * so a new kind of sensitive file cannot become readable by omission.
 *
 * Check order is deliberate:
 *  1. **Shape**, then **extension** — the two cheapest rejections, and doing the
 *     extension first means a rejected `.env` or `.pem` is never even `stat`ed.
 *  2. **Prefix check on the resolved path** — catches `..` traversal, since
 *     `path.resolve` has already collapsed the segments.
 *  3. **`realpath`**, then reject when it differs from the resolved path. This is
 *     what stops symlinks. Rejecting rather than following matters concretely:
 *     staging bind-mounts config from `/tmp/vpc-deploy-main`, so a reader that
 *     followed links could walk out of the source tree into host files. It also
 *     covers a symlinked *directory* halfway along the path, which a check on
 *     the final segment alone would miss.
 *  4. **Prefix check again, on the real path** — belt and braces for the case
 *     where step 3's equality check is ever loosened.
 *  5. **Must be a file** — both tools read file contents, and a directory whose
 *     name ends in `.ts` would otherwise reach `readFile`.
 *
 * Roots are a constructor parameter rather than a module constant so the
 * adversarial tests can build a fixture tree containing a real symlink — the
 * one case that cannot be tested against the live repository.
 */
export function createPathAllowlist(
  roots: readonly string[],
  extensions: readonly string[] = ALLOWED_SOURCE_EXTENSIONS,
): PathAllowlist {
  async function resolve(input: string): Promise<AllowlistResult> {
    if (!isUsableShape(input)) return { ok: false, reason: REASONS.unusable };
    if (!extensions.includes(path.extname(input).toLowerCase())) {
      return { ok: false, reason: REASONS.extension };
    }

    // Which failure to report once no root has produced a file. A path missing
    // from a root it could legally have lived in is "no such file"; a path that
    // never landed inside any root is "outside".
    let sawCandidateRoot = false;

    for (const root of roots) {
      const resolved = path.isAbsolute(input) ? path.resolve(input) : path.resolve(root, input);
      if (!isInside(root, resolved)) continue;
      sawCandidateRoot = true;

      let real: string;
      try {
        real = await realpath(resolved);
      } catch {
        // Keep looking. A RELATIVE path is inside every root by construction
        // (`path.resolve(root, input)`), so returning here made the first root
        // decide for all of them: `read_source('schema.prisma')` reported "no
        // such file" while the file sat in `packages/db/prisma`, breaking every
        // search-then-read on two of the three roots. Found by probing the
        // deployed container, not by a fixture — see the test.
        continue;
      }
      // A symlink and a non-file are definite findings about a path that EXISTS,
      // so they stop the search rather than falling through to a later root that
      // happens to hold a real file of the same name — otherwise a link would be
      // silently substituted by an unrelated file and the answer would cite the
      // wrong source.
      if (real !== resolved) return { ok: false, reason: REASONS.symlink };
      if (!isInside(root, real)) continue;
      if (!(await stat(real)).isFile()) return { ok: false, reason: REASONS.notFile };

      return { ok: true, absolutePath: real, relativePath: path.relative(root, real) };
    }

    return { ok: false, reason: sawCandidateRoot ? REASONS.missing : REASONS.outside };
  }

  return { resolve, roots };
}

/**
 * A path must be non-empty, single-token and free of NUL. Whitespace is refused
 * rather than trimmed: every path the model should ever send comes from a
 * `search_source` hit, and those never contain spaces, so a spaced string is a
 * malformed argument — silently repairing it would teach the model that loose
 * paths work.
 */
function isUsableShape(input: string): boolean {
  return input.length > 0 && input.trim() === input && !/[\s\0]/.test(input);
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

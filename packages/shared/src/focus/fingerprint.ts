import { createHash } from 'node:crypto';
import { normaliseTitle } from './normalise-title.js';

/**
 * SERVER ONLY. This is the one module in `@deckgauge/shared` that imports a node
 * builtin, and nothing on the package barrel may import it — `apps/web` pulls
 * that barrel into client components, and webpack fails the whole build on an
 * unresolvable `node:crypto`.
 *
 * It lives apart from `normalise-title.ts` for exactly that reason: the
 * normaliser is needed by `merge-task-sets`, which IS on the barrel, so the two
 * cannot share a file. Import this by its own subpath:
 *
 *     import { taskFingerprint } from '@deckgauge/shared/focus/fingerprint.js';
 *
 * Guarded by `server-only-boundary.test.ts`, which walks the barrel's import
 * graph transitively — a direct-import check missed this and the web build
 * caught it instead.
 */

/**
 * The key a classification verdict is stored against.
 *
 * Content, not id — so a human override survives the Jira/ADO de-duplication,
 * an id change, and the next window. Title and description are normalised the
 * same way and joined, so cosmetic differences between the two systems do not
 * produce two fingerprints for one task.
 *
 * Returns 64 hex characters, exactly the width of `focus_verdicts.fingerprint`.
 */
export function taskFingerprint(title: string, description: string | null): string {
  const normalised = `${normaliseTitle(title)} ${normaliseTitle(description ?? '')}`;
  return createHash('sha256').update(normalised, 'utf8').digest('hex');
}

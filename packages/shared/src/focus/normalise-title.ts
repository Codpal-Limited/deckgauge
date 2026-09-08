/**
 * Pure and isomorphic — no node builtins. `merge-task-sets` imports this and is
 * itself on the package barrel, which `apps/web` pulls into client components,
 * so anything added here reaches the browser bundle.
 *
 * The fingerprint that used to live here now sits in `./fingerprint.ts`, because
 * it needs `node:crypto` and dragging it in through this module broke the web
 * build.
 */

/** An issue key as either system writes it: `PROJ-948`, `ADO-91656`. */
const ISSUE_KEY = /\b[A-Za-z]+-\d+\b/g;
/** `[platform]`, `[payments]`, `[ops]` — the team/repo tag people prefix titles with. */
const BRACKETED = /\[[^\]]*\]/g;
const NON_ALPHANUMERIC = /[^a-z0-9]+/g;

/**
 * Collapse a task title to the words that describe the WORK, so the same work
 * tracked in two systems produces one string.
 *
 * Order matters: brackets go first because they routinely contain a key, then
 * keys, then everything non-alphanumeric collapses. Digits survive — a title
 * like `<brand> 666 errors` is about error 666, and losing the number would
 * merge unrelated tasks.
 */
export function normaliseTitle(title: string): string {
  return title
    .replace(BRACKETED, ' ')
    .replace(ISSUE_KEY, ' ')
    .toLowerCase()
    .replace(NON_ALPHANUMERIC, ' ')
    .trim();
}

/**
 * Reading `@mention`s back out of a stored comment body.
 *
 * The comment `content` column is `Json`: it holds whatever Tiptap serialised,
 * and rows predate the mention extension entirely. So everything here is TOTAL
 * on garbage — no throw, no assumption about shape. A comment must never fail to
 * post because its mention parse threw, and `CommentItem.renderContent` already
 * sets that precedent on the render side.
 *
 * These are the *only* source of truth for who was mentioned. The mention ids the
 * browser sends are user ids it chose, so they are re-derived from the stored
 * document server-side and then intersected with real access — never trusted as
 * an address list (design D2).
 */

/**
 * A real document nests a handful deep. This is a backstop against a
 * pathological body, not a business rule.
 */
const MAX_DEPTH = 100;

/** Every mention id in a Tiptap document, deduped, in first-seen order. */
export function extractMentionIds(content: unknown): string[] {
  const found: string[] = [];
  const seen = new Set<string>();

  const walk = (node: unknown, depth: number): void => {
    if (depth > MAX_DEPTH || !node || typeof node !== 'object') return;
    const n = node as { type?: unknown; attrs?: unknown; content?: unknown };

    // Matching on `type === 'mention'` and not merely on the presence of
    // `attrs.id`: an image node carries attrs too, and a looser match would
    // notify whatever user id happened to collide with another node's attribute.
    if (n.type === 'mention') {
      const id = (n.attrs as { id?: unknown } | undefined)?.id;
      if (typeof id === 'string' && id.length > 0 && !seen.has(id)) {
        seen.add(id);
        found.push(id);
      }
    }

    if (Array.isArray(n.content)) {
      for (const child of n.content) walk(child, depth + 1);
    }
  };

  walk(content, 0);
  return found;
}

/**
 * Which mentions an edit ADDED (design D5).
 *
 * `PATCH` replaces the whole document, so re-notifying everyone named in it
 * would ring the same bell on every typo fix. Removal is deliberately not the
 * inverse operation: a notification already delivered is not retracted by
 * deleting the mention that caused it.
 */
export function newMentionIds(before: unknown, after: unknown): string[] {
  const had = new Set(extractMentionIds(before));
  return extractMentionIds(after).filter((id) => !had.has(id));
}

import { z } from 'zod';

/**
 * A message an edition wants shown in the app chrome, with optional actions.
 *
 * Deliberately generic and free of any product vocabulary: the core knows only
 * that an edition may have something to tell the user and somewhere to send them.
 * That is what lets a hosted deployment surface, say, a subscription state without
 * the open-source app containing a single line about it.
 *
 * Everything here crosses TWO boundaries — an edition module into the API, then
 * the API into the browser — so it is validated rather than trusted. An edition is
 * our own code, but a bug in it that reached an `href` unchecked would be stored
 * XSS on every page of the app.
 */

/** Beyond this, an edition is looping and the page would be unusable. */
export const MAX_NOTICES = 3;
/** Beyond this, the bar stops being a bar. */
export const MAX_ACTIONS = 4;
const MAX_TITLE = 160;
const MAX_DETAIL = 400;
const MAX_LABEL = 40;

/**
 * `blocking` means the user cannot proceed without acting; it earns the loudest
 * styling and is never dismissible. The other two are informational.
 */
export const EditionNoticeSeverity = z.enum(['info', 'warning', 'blocking']);

export const EditionNoticeActionSchema = z.object({
  label: z.string().min(1).max(MAX_LABEL),
  href: z.string().min(1).max(2000),
  primary: z.boolean().optional(),
});

export const EditionNoticeSchema = z.object({
  /** Stable across renders — it is the React key and the dismissal key. */
  id: z.string().min(1).max(64),
  severity: EditionNoticeSeverity,
  title: z.string().min(1).max(MAX_TITLE),
  detail: z.string().max(MAX_DETAIL).optional(),
  actions: z.array(EditionNoticeActionSchema).optional(),
});

export type EditionNoticeAction = z.infer<typeof EditionNoticeActionSchema>;
export type EditionNotice = z.infer<typeof EditionNoticeSchema>;

/**
 * Whether an href is safe to put in an anchor.
 *
 * Allowed: absolute http(s) URLs, same-origin paths beginning with a single
 * slash, and mailto:, which cannot execute script and is the only action an
 * edition can offer a customer it has no self-serve price for. Everything else is
 * dropped — notably:
 *
 * - javascript:, data: and vbscript:, which execute on click. Browsers ignore
 *   whitespace and control characters INSIDE a scheme, so a raw-string match on
 *   "javascript:" would miss a tab-separated variant of it.
 * - a protocol-relative "//host", which reads like a path but navigates
 *   off-origin.
 * - a leading backslash, which some browsers normalise to a double slash.
 */
function isSafeHref(href: string): boolean {
  // Strip everything a browser ignores when parsing the scheme: whitespace and
  // control characters, anywhere in the string.
  const collapsed = href.replace(/[\u0000-\u0020]/g, '');
  if (collapsed === '') return false;

  const lower = collapsed.toLowerCase();
  if (lower.startsWith('//') || collapsed.startsWith("\\")) return false;
  if (collapsed.startsWith('/')) return true;
  return (
    lower.startsWith('https://') || lower.startsWith('http://') || lower.startsWith('mailto:')
  );
}

/**
 * Validates and trims a list of notices from an edition module.
 *
 * A malformed notice is DROPPED, not repaired: truncating a title would show a
 * customer copy nobody wrote, and guessing a severity would style a blocking
 * message as informational. An unsafe action is dropped while its notice survives,
 * because the message still matters even when we refuse to link anywhere.
 *
 * Never throws. The input arrives as JSON from another process, so it can be
 * anything at all.
 */
export function sanitiseEditionNotices(input: unknown): EditionNotice[] {
  if (!Array.isArray(input)) return [];

  const seen = new Set<string>();
  const notices: EditionNotice[] = [];

  for (const candidate of input) {
    if (notices.length >= MAX_NOTICES) break;

    const parsed = EditionNoticeSchema.safeParse(candidate);
    if (!parsed.success) continue;

    // The id keys both React reconciliation and dismissal; a duplicate breaks
    // both, so the first one wins and the rest are dropped.
    if (seen.has(parsed.data.id)) continue;
    seen.add(parsed.data.id);

    const actions = (parsed.data.actions ?? [])
      .filter((action) => isSafeHref(action.href))
      .slice(0, MAX_ACTIONS);

    notices.push(
      parsed.data.actions === undefined ? parsed.data : { ...parsed.data, actions },
    );
  }

  return notices;
}

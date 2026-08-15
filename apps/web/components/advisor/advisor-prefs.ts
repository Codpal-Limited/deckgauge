/**
 * Advisor UI preferences that outlive a conversation.
 *
 * Deliberately NOT stored in `RESTORE_KEY` (`deckgauge.advisor.ui`): the
 * provider's persist effect DELETES that key whenever the advisor is closed or
 * has no board bound (`AdvisorProvider.tsx`), so a size preference kept there
 * would be wiped on every close and would never persist off-board at all.
 *
 * Every access is wrapped: `localStorage` throws in private-browsing modes and
 * on quota, and a preference is never worth failing a render over.
 */
export type AdvisorPanelSize = 'card' | 'drawer';

const SIZE_KEY = 'deckgauge.advisor.size';
const TEASER_PREFIX = 'deckgauge.advisor.teaser.';

const DEFAULT_SIZE: AdvisorPanelSize = 'card';

function readRaw(key: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeRaw(key: string, value: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // A lost preference is not worth surfacing.
  }
}

export function readPanelSize(): AdvisorPanelSize {
  const raw = readRaw(SIZE_KEY);
  return raw === 'card' || raw === 'drawer' ? raw : DEFAULT_SIZE;
}

export function writePanelSize(size: AdvisorPanelSize): void {
  writeRaw(SIZE_KEY, size);
}

export function isTeaserDismissed(pageKey: string): boolean {
  return readRaw(`${TEASER_PREFIX}${pageKey}`) === '1';
}

export function dismissTeaser(pageKey: string): void {
  writeRaw(`${TEASER_PREFIX}${pageKey}`, '1');
}

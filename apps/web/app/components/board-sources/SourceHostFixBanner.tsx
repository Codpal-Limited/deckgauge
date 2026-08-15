'use client';

export interface SourceHostFixBannerProps {
  /** Canonical API origin reported by the site itself. */
  suggestedUrl: string;
  busy: boolean;
  onUseSuggested: () => void;
}

/**
 * Shown when a Jira connection test fails against Atlassian's vanity display
 * domain. That host serves the UI but discards HTTP Basic credentials, so a
 * valid token still 401s — the fix is the canonical host, not a new token.
 */
export function SourceHostFixBanner({
  suggestedUrl,
  busy,
  onUseSuggested,
}: SourceHostFixBannerProps) {
  let host = suggestedUrl;
  try {
    host = new URL(suggestedUrl).host;
  } catch {
    // Not a parseable URL — show it as given rather than nothing.
  }

  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 p-3 space-y-2">
      <p className="text-xs font-medium text-amber-800" role="alert">
        This looks like Atlassian&apos;s display URL, which does not accept API tokens. The API
        host for this site is <span className="font-mono">{host}</span>.
      </p>
      <button
        type="button"
        className="text-xs px-3 py-1.5 rounded-md bg-indigo-600 text-white disabled:opacity-50"
        disabled={busy}
        onClick={onUseSuggested}
      >
        {busy ? 'Updating…' : 'Use this URL'}
      </button>
    </div>
  );
}

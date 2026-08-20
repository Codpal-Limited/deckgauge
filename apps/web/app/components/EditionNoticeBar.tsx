import type { EditionNotice } from '@deckgauge/shared';

/**
 * Renders whatever the active edition wants to tell this caller.
 *
 * Deliberately knows nothing about what the messages MEAN — no product
 * vocabulary, no branching on specific ids. It receives text, a severity and
 * links, and renders them. That is what lets a hosted deployment surface, say, a
 * subscription state through this component while the open-source app contains
 * not a line about it.
 *
 * Presentational and stateless, so it stays a server component: no dismissal, no
 * client bundle. A notice that stops applying stops being sent.
 *
 * Every value here has already been validated and its links checked by
 * `sanitiseEditionNotices` at the API boundary.
 */

/** Loudest first: "you cannot edit" outranks "your invoice is ready". */
const SEVERITY_ORDER: Record<EditionNotice['severity'], number> = {
  blocking: 0,
  warning: 1,
  info: 2,
};

const SEVERITY_STYLES: Record<EditionNotice['severity'], string> = {
  blocking: 'border-red-300 bg-red-50 text-red-900',
  warning: 'border-amber-300 bg-amber-50 text-amber-900',
  info: 'border-slate-300 bg-surface-2 text-slate-700',
};

const ACTION_STYLES: Record<EditionNotice['severity'], { primary: string; secondary: string }> = {
  blocking: {
    primary: 'bg-red-600 text-white hover:bg-red-700',
    secondary: 'border border-red-300 text-red-900 hover:bg-red-100',
  },
  warning: {
    primary: 'bg-amber-600 text-white hover:bg-amber-700',
    secondary: 'border border-amber-300 text-amber-900 hover:bg-amber-100',
  },
  info: {
    primary: 'bg-teal-600 text-white hover:bg-teal-700',
    secondary: 'border border-slate-300 text-slate-700 hover:bg-surface-1',
  },
};

/** A path is same-origin; anything else is a proven-safe http(s) or mailto: link. */
function isExternal(href: string): boolean {
  return !href.startsWith('/');
}

export function EditionNoticeBar({ notices }: { notices?: EditionNotice[] }) {
  if (!notices || notices.length === 0) return null;

  // Copied before sorting: mutating a prop array would reorder the caller's data.
  const ordered = [...notices].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );

  return (
    <div className="space-y-2 px-4 pt-3">
      {ordered.map((notice) => (
        <div
          key={notice.id}
          // `alert` interrupts a screen reader, `status` does not. A blocking
          // notice means the user cannot proceed, which is worth interrupting for;
          // an informational one is not.
          role={notice.severity === 'blocking' ? 'alert' : 'status'}
          className={`flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border px-4 py-2.5 text-sm ${SEVERITY_STYLES[notice.severity]}`}
        >
          <div className="min-w-0 flex-1">
            <p className="font-medium">{notice.title}</p>
            {notice.detail ? <p className="mt-0.5 opacity-80">{notice.detail}</p> : null}
          </div>
          {notice.actions && notice.actions.length > 0 ? (
            <div className="flex flex-shrink-0 flex-wrap gap-2">
              {notice.actions.map((action) => (
                <a
                  key={`${action.label}:${action.href}`}
                  href={action.href}
                  // Board and org-tree URLs carry ids. Sending a Referer to a
                  // payment provider would hand them internal identifiers for
                  // free; an internal link keeps it, which our own analytics uses.
                  rel={isExternal(action.href) ? 'noreferrer' : undefined}
                  className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                    action.primary
                      ? ACTION_STYLES[notice.severity].primary
                      : ACTION_STYLES[notice.severity].secondary
                  }`}
                >
                  {action.label}
                </a>
              ))}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

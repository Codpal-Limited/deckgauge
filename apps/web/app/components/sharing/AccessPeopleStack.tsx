'use client';

import type { AccessEntry } from '@deckgauge/shared';

const MAX_AVATARS = 4;

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() ?? '').join('') || '?';
}

/**
 * One accessible button, not one tab stop per avatar: the avatars are a summary,
 * and the names live in the dialog the button opens.
 */
export function AccessPeopleStack({
  entries,
  nounLabel,
  onOpen,
}: {
  entries: AccessEntry[];
  nounLabel: string;
  onOpen: () => void;
}) {
  if (entries.length === 0) return null;

  const shown = entries.slice(0, MAX_AVATARS);
  const overflow = entries.length - shown.length;

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`${nounLabel} access: ${entries.length} ${entries.length === 1 ? 'person' : 'people'}`}
      // 32x32 measured (a single 28px avatar plus `p-0.5`). The avatars
      // themselves stay `h-7 w-7` — only the button's hit box grows, so the
      // stack looks identical and just becomes reachable. With two or more
      // avatars the width already clears 44; the height never did.
      className="flex min-h-11 min-w-11 items-center justify-center -space-x-2 rounded-full p-0.5 hover:ring-2 hover:ring-teal-500/30 focus:outline-none focus:ring-2 focus:ring-teal-500 md:min-h-0 md:min-w-0"
    >
      {shown.map((entry) => (
        <span
          key={entry.userId}
          title={`${entry.user.name} · ${entry.role}`}
          className="inline-flex h-7 w-7 items-center justify-center rounded-full border-2 border-surface-1 bg-teal-100 text-[10px] font-semibold text-teal-800"
        >
          {entry.user.avatarUrl ? (
            <img src={entry.user.avatarUrl} alt="" className="h-full w-full rounded-full object-cover" />
          ) : (
            initials(entry.user.name)
          )}
        </span>
      ))}
      {overflow > 0 && (
        <span className="inline-flex h-7 w-7 items-center justify-center rounded-full border-2 border-surface-1 bg-surface-2 text-[10px] font-semibold text-slate-600">
          +{overflow}
        </span>
      )}
    </button>
  );
}

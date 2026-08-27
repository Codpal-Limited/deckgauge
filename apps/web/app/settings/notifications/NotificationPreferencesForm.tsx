'use client';

import { useState } from 'react';
import type {
  NotificationKindValue,
  NotificationMode,
  NotificationPreference,
} from '@deckgauge/shared';
import { saveNotificationPreferences } from '../../actions/notification-preferences';

/**
 * The per-kind preference screen.
 *
 * Saves on change rather than behind a Save button: one radio is one decision,
 * and a form that batches eleven of them makes the reader confirm choices they
 * have already made. Optimistic, reverting with an inline message when the write
 * does not land — an optimism that survives a failed write is a lie about what
 * the server holds.
 *
 * The three labels are the UI copy; `IMMEDIATE` / `DIGEST` / `OFF` are wire
 * values and never appear on screen.
 */

const MODES: Array<{ mode: NotificationMode; label: string }> = [
  { mode: 'IMMEDIATE', label: 'Immediately' },
  { mode: 'DIGEST', label: 'In the digest' },
  { mode: 'OFF', label: 'Never' },
];

/**
 * One line each, in the reader's terms — what happens, not which table changed.
 * Ordered as the screen reads: the things you did, then the things that happened
 * to your work, then the workspace.
 */
const KIND_COPY: Record<NotificationKindValue, { label: string; description: string }> = {
  MENTION: {
    label: 'Mentions',
    description: 'Someone writes your name in an update.',
  },
  ITEM_ASSIGNED: {
    label: 'Assigned to you',
    description: 'An item becomes yours.',
  },
  ITEM_COMMENT_ADDED: {
    label: 'Comments on your items',
    description: 'Someone comments on an item you own or have commented on.',
  },
  ITEM_STATUS_CHANGED: {
    label: 'Status changes',
    description: 'The status moves on an item you are involved in.',
  },
  ITEM_DUE_DATE_CHANGED: {
    label: 'Due dates moved',
    description: 'A due date shifts on an item you are involved in.',
  },
  ITEM_DUE_SOON: {
    label: 'Due soon',
    description: 'One of your items falls due within a day.',
  },
  ITEM_OVERDUE: {
    label: 'Overdue',
    description: 'One of your items passes its due date.',
  },
  ENTITY_SHARED: {
    label: 'Shared with you',
    description: 'You are given access to a board, roadmap, org tree or comparison.',
  },
  ACCESS_ROLE_CHANGED: {
    label: 'Your role changes',
    description: 'Someone changes what you can do with something shared with you.',
  },
  ORG_MEMBER_INVITED: {
    label: 'Added to a workspace',
    description: 'You join a new workspace.',
  },
  AUTOMATION_NOTIFY: {
    label: 'Automations',
    description: 'A board rule you or a colleague built says to tell you.',
  },
  DIGEST: {
    label: 'The digest itself',
    description: 'The daily roll-up of everything held back above.',
  },
};

/** The order the screen reads in. Keyed on the same enum the API sends. */
const KIND_ORDER: NotificationKindValue[] = [
  'MENTION',
  'ITEM_ASSIGNED',
  'ITEM_COMMENT_ADDED',
  'ITEM_STATUS_CHANGED',
  'ITEM_DUE_DATE_CHANGED',
  'ITEM_DUE_SOON',
  'ITEM_OVERDUE',
  'ENTITY_SHARED',
  'ACCESS_ROLE_CHANGED',
  'ORG_MEMBER_INVITED',
  'AUTOMATION_NOTIFY',
  'DIGEST',
];

interface NotificationPreferencesFormProps {
  initial: NotificationPreference[];
}

export function NotificationPreferencesForm({ initial }: NotificationPreferencesFormProps) {
  const [modeOf, setModeOf] = useState<Record<string, NotificationMode>>(() =>
    Object.fromEntries(initial.map((p) => [p.kind, p.mode])),
  );
  const [error, setError] = useState<string | null>(null);

  // Only kinds the API actually sent, in the screen's order. A kind missing from
  // the response is a kind this deployment does not have.
  const kinds = KIND_ORDER.filter((kind) => kind in modeOf);

  const choose = async (kind: NotificationKindValue, mode: NotificationMode) => {
    const previous = modeOf[kind];
    if (previous === mode) return;

    setError(null);
    setModeOf((prev) => ({ ...prev, [kind]: mode }));

    const ok = await saveNotificationPreferences([{ kind, mode }]);
    if (!ok) {
      setModeOf((prev) => ({ ...prev, [kind]: previous as NotificationMode }));
      setError('Could not save that change. Try again.');
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-slate-500">
        Choose how each kind of notification reaches you. Everything here is in-app.
      </p>

      {error && (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
        {kinds.map((kind) => (
          <li key={kind} className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1">
              <p id={`kind-${kind}`} className="text-sm font-medium text-slate-800">
                {KIND_COPY[kind].label}
              </p>
              <p className="text-xs text-slate-500">{KIND_COPY[kind].description}</p>
            </div>
            {/* Named by the VISIBLE label rather than an sr-only legend
                repeating it: a duplicate is read twice and shows up twice to
                anything querying the page by text. */}
            <fieldset className="flex shrink-0 gap-1" aria-labelledby={`kind-${kind}`}>
              {MODES.map(({ mode, label }) => (
                <label
                  key={mode}
                  className={`cursor-pointer rounded-md px-2.5 py-1 text-xs transition-colors ${
                    modeOf[kind] === mode
                      ? 'bg-teal-50 font-medium text-teal-700'
                      : 'text-slate-500 hover:bg-slate-50'
                  }`}
                >
                  <input
                    type="radio"
                    name={`mode-${kind}`}
                    className="sr-only"
                    checked={modeOf[kind] === mode}
                    onChange={() => void choose(kind, mode)}
                  />
                  {label}
                </label>
              ))}
            </fieldset>
          </li>
        ))}
      </ul>
    </div>
  );
}

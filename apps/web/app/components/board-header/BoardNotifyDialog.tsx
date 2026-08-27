'use client';

import { useEffect, useState } from 'react';
import type { BoardNotificationLevel } from '@deckgauge/shared';
import {
  fetchBoardNotificationLevel,
  saveBoardNotificationLevel,
} from '../../actions/notification-preferences';

/**
 * "Notify me about" for one board.
 *
 * Lives on the BOARD, not in settings: "this board is too noisy" is a thought
 * people have while looking at the board, and a global list is where that
 * control goes to never be found.
 *
 * The level narrows WHICH kinds arrive; the per-kind screen decides how each one
 * that survives is delivered. So "Only mentions" does not switch mentions back
 * on for someone who turned them off — it narrows the set, it does not override a
 * choice.
 */

const LEVELS: Array<{ level: BoardNotificationLevel; label: string; hint: string }> = [
  { level: 'ALL', label: 'Everything', hint: 'Every kind you have switched on.' },
  { level: 'MENTIONS_ONLY', label: 'Only mentions', hint: 'Just when someone names you.' },
  { level: 'NONE', label: 'Nothing', hint: 'Silence this board completely.' },
];

interface BoardNotifyDialogProps {
  boardId: string;
  onClose: () => void;
}

export function BoardNotifyDialog({ boardId, onClose }: BoardNotifyDialogProps) {
  const [level, setLevel] = useState<BoardNotificationLevel | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchBoardNotificationLevel(boardId).then((current) => {
      if (!cancelled) setLevel(current);
    });
    return () => {
      cancelled = true;
    };
  }, [boardId]);

  const choose = async (next: BoardNotificationLevel) => {
    const previous = level;
    if (previous === next) return;

    setError(null);
    setLevel(next);
    const ok = await saveBoardNotificationLevel(boardId, next);
    if (!ok) {
      setLevel(previous);
      setError('Could not save that change. Try again.');
    }
  };

  return (
    <div
      role="dialog"
      aria-label="Notify me about"
      className="absolute left-0 top-full z-30 mt-1 w-72 rounded-lg border border-slate-200 bg-surface-1 p-3 shadow-lg"
    >
      <div className="mb-2 flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-medium text-slate-800">Notify me about</p>
          <p className="text-xs text-slate-500">Applies to this board only.</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="text-slate-400 transition-colors hover:text-slate-600"
        >
          {'✕'}
        </button>
      </div>

      {error && (
        <p role="alert" className="mb-2 rounded bg-red-50 px-2 py-1 text-xs text-red-700">
          {error}
        </p>
      )}

      {level === null ? (
        <p className="py-2 text-xs text-slate-400">Loading…</p>
      ) : (
        <fieldset className="flex flex-col gap-1">
          <legend className="sr-only">Notification level for this board</legend>
          {LEVELS.map((option) => (
            <label
              key={option.level}
              className={`cursor-pointer rounded-md px-2 py-1.5 transition-colors ${
                level === option.level ? 'bg-teal-50' : 'hover:bg-slate-50'
              }`}
            >
              <input
                type="radio"
                name="board-notify-level"
                className="sr-only"
                checked={level === option.level}
                onChange={() => void choose(option.level)}
              />
              <span
                className={`block text-sm ${
                  level === option.level ? 'font-medium text-teal-700' : 'text-slate-700'
                }`}
              >
                {option.label}
              </span>
              <span className="block text-xs text-slate-500">{option.hint}</span>
            </label>
          ))}
        </fieldset>
      )}
    </div>
  );
}

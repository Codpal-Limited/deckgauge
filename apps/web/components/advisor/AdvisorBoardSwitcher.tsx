'use client';

import { useEffect, useState } from 'react';
import { fetchSelectableBoards } from '../../app/actions/comparison';

interface AdvisorBoardSwitcherProps {
  boardId: string;
  onSelect: (boardId: string) => void;
}

/**
 * The scope row's chip styling — the board chip below and `AdvisorPanel`'s
 * product-help chip. Lives here, beside the interactive chip, and is imported by
 * the panel rather than the other way around (the panel already imports this
 * module, so the reverse would be a cycle). The two arms of the scope row must
 * look identical; the string was duplicated inline in both files, which is how
 * they would have drifted.
 */
export const ADVISOR_SCOPE_CHIP_CLASS =
  'inline-flex w-fit items-center gap-1 rounded-full bg-indigo-50 px-2.5 py-0.5 text-[11px] font-medium text-indigo-700 ring-1 ring-indigo-200';

/**
 * The scope row's board chip. Reads its list from `fetchSelectableBoards`
 * (`GET /boards`), which is already access-scoped server-side, so this never
 * offers a board the user cannot read.
 *
 * Falls back to showing the raw board id if the list cannot be loaded — the
 * chip's job is to say what is being read, and it must not go blank.
 */
export function AdvisorBoardSwitcher({ boardId, onSelect }: AdvisorBoardSwitcherProps) {
  const [boards, setBoards] = useState<{ id: string; name: string }[]>([]);
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    let isActive = true;
    fetchSelectableBoards()
      .then((rows) => {
        if (isActive) setBoards(rows);
      })
      .catch(() => {
        // Non-fatal: the chip degrades to the raw id. Nothing to surface to
        // the user beyond that — the fallback below already says what is
        // being read.
      });
    return () => {
      isActive = false;
    };
  }, []);

  const current = boards.find((board) => board.id === boardId);

  return (
    <span className="relative">
      <button
        type="button"
        onClick={() => setIsOpen((open) => !open)}
        aria-expanded={isOpen}
        className={`${ADVISOR_SCOPE_CHIP_CLASS} hover:bg-indigo-100`}
      >
        {current?.name ?? boardId} · read-only
        <span aria-hidden="true">⌄</span>
      </button>
      {isOpen && (
        <span
          role="menu"
          aria-label="Other boards"
          className="absolute left-0 top-full z-10 mt-1 flex max-h-60 w-56 flex-col overflow-y-auto rounded-lg border border-slate-200 bg-surface-1 py-1 shadow-dropdown"
        >
          {boards
            .filter((board) => board.id !== boardId)
            .map((board) => (
              <button
                key={board.id}
                type="button"
                onClick={() => {
                  setIsOpen(false);
                  onSelect(board.id);
                }}
                className="px-3 py-1.5 text-left text-xs text-slate-700 hover:bg-slate-50"
              >
                {board.name}
              </button>
            ))}
        </span>
      )}
    </span>
  );
}

'use client';

import { useEffect, useRef, useCallback } from 'react';
import type { NavMode } from './hooks/useKeyboardNav';

interface ShortcutManagerProps {
  navMode: NavMode;
  focusedRowId: string | null;
  onSlashSearch: () => void;
  onQuestionHelp: () => void;
  onNAddItem: () => void;
  onDeleteRow: () => void;
  onCmdEnterExpand: () => void;
  onGGroupJump: (direction: 'up' | 'down') => void;
}

function isEditableElement(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if ((el as HTMLElement).isContentEditable) return true;
  return false;
}

export function ShortcutManager({
  navMode,
  focusedRowId,
  onSlashSearch,
  onQuestionHelp,
  onNAddItem,
  onDeleteRow,
  onCmdEnterExpand,
  onGGroupJump,
}: ShortcutManagerProps) {
  const gPendingRef = useRef(false);
  const gTimerRef = useRef<NodeJS.Timeout | undefined>(undefined);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const isEditing = navMode === 'edit' || isEditableElement(document.activeElement);

      // G chord: second key
      if (gPendingRef.current) {
        gPendingRef.current = false;
        clearTimeout(gTimerRef.current);
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          onGGroupJump('up');
          return;
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          onGGroupJump('down');
          return;
        }
      }

      // Single-char shortcuts — disabled when editing
      if (!isEditing) {
        if (e.key === '/') {
          e.preventDefault();
          onSlashSearch();
          return;
        }
        if (e.key === '?') {
          e.preventDefault();
          onQuestionHelp();
          return;
        }
        if (e.key === 'n' || e.key === 'N') {
          e.preventDefault();
          onNAddItem();
          return;
        }
        if (e.key === 'g' || e.key === 'G') {
          e.preventDefault();
          gPendingRef.current = true;
          gTimerRef.current = setTimeout(() => {
            gPendingRef.current = false;
          }, 500);
          return;
        }
      }

      // Shortcuts that require a focused row and no editing
      if (focusedRowId && !isEditing) {
        if (e.key === 'Delete' || e.key === 'Backspace') {
          e.preventDefault();
          onDeleteRow();
          return;
        }
      }

      // Modifier shortcuts — work in row/cell mode but not edit
      if (focusedRowId && navMode !== 'edit') {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
          e.preventDefault();
          onCmdEnterExpand();
          return;
        }
      }
    },
    [navMode, focusedRowId, onSlashSearch, onQuestionHelp, onNAddItem, onDeleteRow, onCmdEnterExpand, onGGroupJump],
  );

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      clearTimeout(gTimerRef.current);
    };
  }, [handleKeyDown]);

  return null; // Renders nothing — pure side-effect component
}

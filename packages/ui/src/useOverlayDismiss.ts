'use client';

import { useEffect } from 'react';

/**
 * The single owner of `document.body.style.overflow` in this codebase.
 *
 * Before this existed there were FOUR independent owners, and three of them
 * cleared the property UNCONDITIONALLY on cleanup — `SlideOverPanel`,
 * `ProjectModal` and `ColumnManager`; `ImageLightbox` saved and restored
 * correctly. Unconditional clearing is fine for exactly one overlay and wrong
 * for two: whichever closed FIRST unlocked the page while the other was still
 * covering it. That nesting is genuinely reachable — `ItemDetailPanel` renders
 * a `CommentItem`, which renders `ImageLightbox`.
 *
 * All four now route through here — `SlideOverPanel`, `ProjectModal`,
 * `ColumnManager` and `ImageLightbox` — so "one owner" is a fact rather than an
 * aspiration, and `grep -rn 'style.overflow' apps packages` is how to keep it
 * one. If you add a fifth overlay, use one of these two hooks instead of
 * touching `document.body` yourself.
 *
 * There is deliberately NO double-release guard. React calls an effect's
 * cleanup exactly once per effect instance — StrictMode's development
 * double-invoke is create → destroy → create, not two destroys of the same
 * cleanup — and the returned closure is only ever handed to React, so a second
 * call is unreachable through the public API. An earlier version carried such a
 * latch justified by a claim about React that is simply untrue.
 *
 * The lock is REFERENCE COUNTED, which is the reason this is module-level
 * mutable state rather than per-hook state: the page unlocks when the LAST
 * overlay closes, not the first. Vitest gives each test file its own module
 * registry, so the counter cannot leak between suites.
 *
 * The counter is deliberately never reset wholesale — every increment is paired
 * with a decrement in the same effect's cleanup, so it returns to zero on its
 * own, and a stray reset would race a legitimately open overlay.
 */
let lockCount = 0;
/** The inline value `overflow` had before the first lock, restored by the last unlock. */
let previousOverflow: string | null = null;

function acquireBodyScrollLock(): () => void {
  if (lockCount === 0) {
    previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
  lockCount += 1;

  return () => {
    lockCount -= 1;
    if (lockCount === 0) {
      document.body.style.overflow = previousOverflow ?? '';
      previousOverflow = null;
    }
  };
}

/**
 * Locks body scroll while `locked` is true, reference counted against every
 * other overlay.
 *
 * Use this when the component already handles its own dismissal — `ProjectModal`
 * and `ColumnManager` both trap focus and handle Escape themselves, so adding
 * the hook's Escape listener would give them two. Use `useOverlayDismiss` when
 * you want Escape as well.
 */
export function useBodyScrollLock(locked: boolean): void {
  useEffect(() => {
    if (!locked) return;
    return acquireBodyScrollLock();
  }, [locked]);
}

/** Body scroll lock, plus Escape-to-close. */
export function useOverlayDismiss(isOpen: boolean, onClose: () => void): void {
  useBodyScrollLock(isOpen);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);
}

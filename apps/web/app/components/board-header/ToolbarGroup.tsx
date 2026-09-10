'use client';

import type { ReactNode } from 'react';

/**
 * Segmented shell for the board's view controls (search, filter, sort,
 * columns). One border around the set instead of one border per button: the
 * controls read as a single instrument, which is what takes the visual noise
 * out of the action bar without removing anything from it.
 */
export function ToolbarGroup({ children }: { children: ReactNode }) {
  return (
    // The frame carries the touch floor, not just the segments inside it.
    // `items-stretch` sizes an item to the line and only THEN clamps it to
    // `min-height`, so flooring the segments against the old unconditional
    // `h-9` left them protruding through the bottom border — dividers and
    // active tint outside the `rounded-lg`, crossing the wrap gap in
    // `BoardView` into the neighbouring controls.
    //
    // Measured in Chromium at 390px, border-box (frame / input / segment):
    //
    //   pre-fix (`h-9`, floored segments)   36.0  34.0  44.0   +9.0px over
    //   post-fix                            46.0  44.0  44.0   contained
    //   at `md:`                            36.0  34.0  34.0   unchanged
    //
    // Flooring the LINE rather than the buttons also fixes the embedded
    // SearchBar for free: its wrapper stretches to the line and the input is
    // `h-full`, taking it 34 → 44px with no rule of its own. That input is
    // invisible to the e2e probe, which selects only
    // `button, a, [role="button"]`.
    //
    // Note the 46px comes from the CHILD, not from this `min-h-11`:
    // `min-height` is border-box, so 44px here means 44px TOTAL, i.e. 42px of
    // content. Same frame class, varying what it holds:
    //
    //   + a `min-h-11` segment    frame 46.00   child 44.00
    //   only the search field     frame 44.00   child 42.00   <- 2px under
    //   neither floored           frame 18.00   child 16.00
    //
    // So this floor is a BACKSTOP, not a guarantee — on its own it yields a
    // 42px child. Keep it anyway: it bounds the damage if a segment ever drops
    // `min-h-11` (42px, not the 16px a bare line box gives, since `md:h-9`
    // leaves no definite height below `md`). Floor the children too, and a
    // group holding only the search field still needs its own rule.
    <div className="inline-flex h-auto min-h-11 items-stretch divide-x divide-slate-200 rounded-lg border border-slate-200 bg-surface-1 shadow-sm md:h-9 md:min-h-0">
      {children}
    </div>
  );
}

interface ToolbarSegmentProps {
  label: string;
  icon: ReactNode;
  onClick: () => void;
  /** Hides the text label, leaving the icon and the accessible name. */
  iconOnly?: boolean;
  /** Non-zero renders a count badge and puts the segment in its active tone. */
  count?: number;
  isActive?: boolean;
}

export function ToolbarSegment({
  label,
  icon,
  onClick,
  iconOnly,
  count = 0,
  isActive,
}: ToolbarSegmentProps) {
  const active = isActive || count > 0;

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      // `min-h-11` below `md`: Filter and Sort measured 34px. The segment takes
      // its height from the toolbar group, so this floor is only contained
      // because `ToolbarGroup` floors the line to match — on its own it
      // overflows the frame. Desktop keeps the 34px rhythm via `md:min-h-0`.
      className={`inline-flex min-h-11 items-center gap-1.5 px-2.5 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-500/40 md:min-h-0 ${
        active
          ? 'bg-teal-500/10 text-teal-600 hover:bg-teal-500/20'
          : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
      }`}
    >
      <span aria-hidden="true" className="flex items-center">
        {icon}
      </span>
      {!iconOnly && <span>{label}</span>}
      {count > 0 && (
        <span className="ml-0.5 inline-flex min-w-[1.1rem] items-center justify-center rounded-full bg-teal-600 px-1 text-[10px] font-semibold leading-4 text-white">
          {count}
        </span>
      )}
    </button>
  );
}

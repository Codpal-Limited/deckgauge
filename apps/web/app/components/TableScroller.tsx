import type { ReactNode } from 'react';

/**
 * Gives a wide `<table>` its own horizontal scroll container, so the PAGE BODY
 * never scrolls sideways on a phone.
 *
 * Ten files use it. The original estimate was seventeen, from grepping the
 * literal string `overflow-x` — which misses `overflow-auto` (the both-axes
 * shorthand) and `overflow-y-auto` (which makes the other axis's `visible`
 * compute to `auto`, CSS Overflow §3), so it could not see scroll parents that
 * were already there.
 *
 * DO NOT wrap a table that already has a scrolling ancestor. Two of the files
 * that estimate named freeze their headers with `sticky top-0` against an
 * `overflow-auto` parent, and inserting this component between the two makes it
 * the sticky cell's nearest scrollport at `height: auto` — scroll offset
 * permanently 0, so `sticky` degrades to a silent no-op and the frozen header
 * rides the outer container's scroll out of view.
 *
 * The sweep stays mechanical only because this component has nothing to
 * configure: no props for direction or width, no measurement, no state, no
 * `useIsMobile`. If a call site ever seems to need one, the table needs the
 * change, not this wrapper.
 *
 * Deliberately a SERVER component — no `'use client'`. Nothing here needs
 * client-side React (no hooks, no handlers), and most consumers are
 * server-rendered panels that would otherwise drag their whole subtree into the
 * client bundle. `apps/web/app/components/__tests__/TableScroller.test.tsx`
 * pins that.
 *
 * The `-mx-4 px-4` pair cancels `<main>`'s phone gutter and re-adds it as
 * padding, so the scrollable strip bleeds to the viewport edge and the table
 * still starts flush with the text above it. `md:mx-0 md:px-0` makes the whole
 * arrangement inert from 768px up, where the gutter belongs to `<main>` again.
 */
const SCROLLER_CLASSES = 'overflow-x-auto -mx-4 px-4 md:mx-0 md:px-0';

export function TableScroller({
  children,
  className,
}: {
  children: ReactNode;
  /** Appended to the scroll classes, never a replacement for them. */
  className?: string;
}) {
  return (
    <div className={className ? `${SCROLLER_CLASSES} ${className}` : SCROLLER_CLASSES}>
      {children}
    </div>
  );
}

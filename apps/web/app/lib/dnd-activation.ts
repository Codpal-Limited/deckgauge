import type { PointerActivationConstraint } from '@dnd-kit/core';

/**
 * Drag activation, split by input device.
 *
 * **Why two sensors instead of one `PointerSensor`.** A single `PointerSensor`
 * serves mouse and touch from the same constraint, and the two devices need
 * opposite things:
 *
 * - A mouse wants `distance`. Press and move is the gesture; there is nothing
 *   to disambiguate, because a mouse cannot scroll by dragging.
 * - A finger wants `delay`. `distance` is indistinguishable from the opening
 *   few pixels of a scroll, so a distance constraint made every attempt to
 *   scroll a board, org tree, roadmap or sidebar pick something up instead.
 *
 * A delay constraint cannot be used for both, and this is the part that is easy
 * to get wrong: in `@dnd-kit/core@6.3.1`, `tolerance` under a delay constraint
 * is an **abort**, not a deferral —
 * `AbstractPointerSensor.handleMove` calls `handleCancel()` as soon as movement
 * exceeds it (`core.cjs.development.js:1555-1558`, euclidean via
 * `hasExceededDistance` at `:1050-1056`). So a mouse user who presses and moves
 * immediately — the normal gesture — has the drag cancelled outright and must
 * release and start again. Applying `{ delay, tolerance }` to `PointerSensor`
 * does not merely delay desktop dragging; it breaks it.
 *
 * The reverse also matters: a delay constraint activates on a stationary press
 * once the timer fires (`:1465`), and `handleStart` (`:1500`) then installs a
 * capture-phase `click` blocker on `document` (`:1511`) which `detach()` only
 * removes 50ms later (`:1484`) — after the gesture has ended, whether that is
 * `mouseup` or `touchend` (neither sensor sees `pointerup`; the event maps are
 * at `:1658` and `:1699`). So a press-and-hold-and-release swallows the click. On
 * touch that is a defensible trade for being able to drag at all; on a mouse it
 * would silently break every click target that also happens to be draggable —
 * sidebar rows and roadmap bars both open on click.
 *
 * Registering `MouseSensor` and `TouchSensor` separately is what dnd-kit ships
 * them for, and it buys one more thing: `TouchSensor.setup()` installs a
 * window-level non-passive `touchmove` listener that `PointerSensor` has no
 * equivalent of, and which the library's own source marks as required for iOS
 * Safari (`:1716-1722`).
 *
 * `tolerance: 8` on touch is load-bearing — a finger is never perfectly still,
 * and at `0` a 1px tremor cancels the hold, so no touch drag can start at all.
 *
 * `app/__isolation__/dnd-touch-activation.test.ts` scans source to keep every
 * registration on these constants and to keep a bare `useSensor(Sensor)` with
 * no constraint from slipping in.
 */

/** Mouse: press and move. 5px filters out click jitter and nothing else. */
export const MOUSE_DRAG_ACTIVATION = { distance: 5 } satisfies PointerActivationConstraint;

/** Touch: hold 200ms to drag, so a swipe scrolls instead. */
export const TOUCH_DRAG_ACTIVATION = {
  delay: 200,
  tolerance: 8,
} satisfies PointerActivationConstraint;

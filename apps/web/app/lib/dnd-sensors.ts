import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type TouchEvent as ReactTouchEvent,
} from 'react';
import { KeyboardSensor, MouseSensor, TouchSensor } from '@dnd-kit/core';

/**
 * The drag sensors every `DndContext` in this app registers.
 *
 * They exist because of one structural fact about how this codebase wires
 * dnd-kit: every draggable spreads `{...attributes} {...listeners}` onto a
 * WRAPPER element and none of them calls `setActivatorNodeRef`. So the drag
 * listeners sit on an ancestor of whatever the node renders — inline rename
 * fields, a nested dialog, buttons — and every pointer and key event inside
 * that subtree reaches them by bubbling.
 *
 * dnd-kit has a guard for exactly this, and registering no activator node is
 * what disables it. `KeyboardSensor`'s activator reads
 * (`@dnd-kit/core@6.3.1`, `core.cjs.development.js:1362-1374`):
 *
 * ```js
 * if (keyboardCodes.start.includes(code)) {          // start = [Space, Enter]
 *   const activator = active.activatorNode.current;
 *   if (activator && event.target !== activator) return false;
 *   event.preventDefault();
 *   onActivation({ event: event.nativeEvent });
 *   return true;
 * }
 * ```
 *
 * With `activatorNode.current` null the early return never fires, so a Space
 * typed into a text field inside a node is `preventDefault()`ed — the character
 * never arrives — and a keyboard drag of the enclosing node starts instead,
 * painting a `DragOverlay` ghost across the surface. Enter is in the same
 * `start` list, so it hijacks form submission the same way.
 *
 * The pointer sensors have the same exposure in a different key: a press and a
 * 5px move is a text selection inside an input and a drag activation outside
 * one, and `MOUSE_DRAG_ACTIVATION` alone cannot tell them apart.
 *
 * Setting an activator node ref would be the other fix, and it is the wrong one
 * for the wrapper-draggable surfaces: an org tree node, a sidebar row and a
 * roadmap bar are draggable by their whole body on purpose, so the activator IS
 * the wrapper and dnd-kit's guard would see the field as a foreign target only
 * by accident of bubbling. Declining on the target's own nature states the rule.
 *
 * But the app has BOTH shapes, and the guard has to serve them at once. The
 * board and the employee board reorder groups from a real grip —
 * `<button aria-label="Drag to reorder group" {...listeners}>` — where the
 * blocked element and the drag handle are the same node. So the guard takes the
 * handle as well as the target, and the sidebar rows, which are interactive and
 * meant to be dragged anyway, opt back in with `data-dnd-handle`.
 *
 * `app/__isolation__/dnd-touch-activation.test.ts` scans tracked source to keep
 * every registration on these subclasses; the unit tests are in
 * `app/lib/dnd-sensors.test.ts`.
 */

/** `MouseEvent.button` for the right button; dnd-kit's own MouseSensor declines it. */
const RIGHT_MOUSE_BUTTON = 2;

/**
 * Elements a drag must never start from. `[data-no-dnd="true"]` is the escape
 * hatch for anything interactive that none of these tags describe.
 */
const DRAG_BLOCK_SELECTOR =
  'input,textarea,select,button,a,[contenteditable="true"],[data-no-dnd="true"]';

/**
 * The opposite escape hatch: an interactive element that IS a grab area.
 *
 * Needed because blocking is not the only half of the rule. A sidebar board row
 * is a `<button>` that fills the row and a roadmap row is a `<Link>` that does
 * the same — both are meant to be dragged into and out of folders, and both are
 * clickable. Blocking alone leaves those rows draggable only from a few pixels
 * of padding.
 */
const DRAG_HANDLE_SELECTOR = '[data-dnd-handle="true"]';

/**
 * True when a drag may start from `target`.
 *
 * `handle` is the element the drag listeners are attached to — pass the event's
 * `currentTarget`. It matters because every grab grip in this app is built as
 * `<button aria-label="Drag to reorder…" {...listeners}>`: the blocked element
 * and the drag handle are then the SAME node, and a guard that only asks "is
 * this interactive?" refuses the very gesture it exists to protect. Omitting it
 * is what broke group reordering on the main board in `5f213061`.
 *
 * `closest` rather than a tag check, because the event target is routinely a
 * `<span>` or `<svg>` inside the control, not the control itself.
 */
function shouldStartDrag(
  target: EventTarget | null,
  handle: EventTarget | null | undefined,
  optInCounts: boolean
): boolean {
  // `Element`, not `HTMLElement`: an `<svg>` icon inside a blocked `<Link>` or
  // `<button>` is an SVGElement, and an HTMLElement test lets every press that
  // lands on an icon through before the selector runs. `closest` and `contains`
  // are both Element members.
  if (!(target instanceof Element)) return true;

  // Nearest ancestor wins, so a text field inside an opted-in grab area is
  // still protected — the field is found before the area is.
  const selector = optInCounts
    ? `${DRAG_BLOCK_SELECTOR},${DRAG_HANDLE_SELECTOR}`
    : DRAG_BLOCK_SELECTOR;
  const decisive = target.closest(selector);
  if (decisive === null) return true;
  if (optInCounts && decisive.matches(DRAG_HANDLE_SELECTOR)) return true;

  // `contains` is true of the node itself, which covers the handle-IS-the-button
  // case; the ancestor case covers an interactive wrapper around the handle.
  return handle instanceof Element && decisive.contains(handle);
}

/** Pointer rule: an opted-in control is a grab area. */
export function shouldStartPointerDrag(
  target: EventTarget | null,
  handle?: EventTarget | null
): boolean {
  return shouldStartDrag(target, handle, true);
}

/**
 * Keyboard rule: an opted-in control is still a CONTROL.
 *
 * `data-dnd-handle` exists so a press-and-move on a row that is wholly a
 * `<button>` or `<a>` can drag it. Enter and Space on that same element mean
 * "activate me" — opening the board, following the link — and a drag started
 * from them `preventDefault()`s the activation, which is the defect this branch
 * exists to remove. Honouring the opt-in here would reintroduce it one element
 * at a time.
 *
 * Keyboard dragging is not lost: dnd-kit's `attributes` put `role="button"` and
 * `tabIndex={0}` on the draggable wrapper, so the wrapper is focusable and a key
 * press landing on it (rather than on the inner control) still activates. And a
 * real grip resolves through the handle branch, not the opt-in branch, so
 * `<button {...listeners}>` keeps its keyboard drag either way.
 */
export function shouldStartKeyboardDrag(
  target: EventTarget | null,
  handle?: EventTarget | null
): boolean {
  return shouldStartDrag(target, handle, false);
}

/**
 * Each subclass keeps its base sensor's own refusal alongside the
 * `shouldStartPointerDrag` guard: `MouseSensor` declines right-click and
 * `TouchSensor` declines a second finger, and dropping either would be a
 * regression.
 */
export class DragMouseSensor extends MouseSensor {
  static activators = [
    {
      eventName: 'onMouseDown' as const,
      handler: (event: ReactMouseEvent) =>
        event.nativeEvent.button !== RIGHT_MOUSE_BUTTON &&
        shouldStartPointerDrag(event.nativeEvent.target, event.currentTarget),
    },
  ];
}

export class DragTouchSensor extends TouchSensor {
  static activators = [
    {
      eventName: 'onTouchStart' as const,
      handler: (event: ReactTouchEvent) =>
        // `<= 1` mirrors dnd-kit's own refusal, which is `touches.length > 1`
        // (`core.cjs.development.js:1745`). `=== 1` would additionally refuse a
        // zero-touch event — behaviourally identical, since no real
        // `touchstart` has none, but this is the faithful form.
        event.nativeEvent.touches.length <= 1 &&
        shouldStartPointerDrag(event.nativeEvent.target, event.currentTarget),
    },
  ];
}

export class DragKeyboardSensor extends KeyboardSensor {
  static activators = [
    {
      eventName: 'onKeyDown' as const,
      handler: (
        event: ReactKeyboardEvent,
        options: Parameters<(typeof KeyboardSensor.activators)[0]['handler']>[1],
        context: Parameters<(typeof KeyboardSensor.activators)[0]['handler']>[2]
      ): boolean => {
        if (!shouldStartKeyboardDrag(event.target, event.currentTarget)) return false;
        return KeyboardSensor.activators[0].handler(event, options, context) ?? false;
      },
    },
  ];
}

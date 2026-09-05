import {
  DEFAULT_NOTIFICATION_MODES,
  type BoardNotificationLevel,
  type NotificationKindValue,
  type NotificationMode,
} from '@deckgauge/shared';

/**
 * Two stages, in this order — which is what removes the ambiguity of "which
 * setting wins":
 *
 *   1. The BOARD level decides which kinds survive at all.
 *   2. The per-kind mode decides how a survivor is delivered.
 *
 * So MENTIONS_ONLY narrows the set; it never PROMOTES a mention the reader has
 * switched OFF. Pure and synchronous: every input is passed in, so the whole
 * precedence table is testable without a database.
 */

export type Delivery = 'IMMEDIATE' | 'DIGEST' | 'DROP';

export interface ResolveDeliveryInput {
  kind: NotificationKindValue;
  /** The reader's explicit choice, or null to use the default. */
  kindMode: NotificationMode | null;
  /**
   * The reader's level for the board in scope. `null` means either "no explicit
   * level" or "this kind has no board" — an org invite is not board-scoped, and
   * a board level must not swallow it.
   */
  boardLevel: BoardNotificationLevel | null;
}

export function resolveDelivery(input: ResolveDeliveryInput): Delivery {
  if (input.boardLevel === 'NONE') return 'DROP';
  if (input.boardLevel === 'MENTIONS_ONLY' && input.kind !== 'MENTION') return 'DROP';

  const mode = input.kindMode ?? DEFAULT_NOTIFICATION_MODES[input.kind];
  if (mode === 'OFF') return 'DROP';
  return mode === 'DIGEST' ? 'DIGEST' : 'IMMEDIATE';
}

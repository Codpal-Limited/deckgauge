import type { PrismaClient } from '@deckgauge/db';
import { NotificationDispatcher, itemParticipants } from '@deckgauge/notifications';
import { BOARD_STATUS_LABEL_TO_ENUM } from './board-status-enum.js';

/**
 * The ONE place an automation rule is evaluated.
 *
 * It lives here rather than in `apps/api` because the WORKER is the other caller:
 * a sync writes statuses on the same rows a person does, and a rule that only
 * fires for hand-edits reads as an automation that is simply broken. The worker
 * has no dependency on `apps/api`, so the shared home is a package — the same
 * reasoning that put the dispatcher in `@deckgauge/notifications`.
 */

export interface AutomationChanges {
  status?: string;
  previousStatus?: string;
  statusId?: string | null;
  previousStatusId?: string | null;
}

/**
 * Who caused the change and which tenant it happened in. OPTIONAL because this is
 * called from paths that have neither — and a `notify` action with no organization
 * has nowhere to file a notification, so it stays silent rather than guessing at a
 * tenant.
 *
 * On the sync paths `actorId` is null: no person pressed anything. The dispatcher
 * drops the actor from the recipient list, so a null actor means nobody is excluded
 * — which is correct here, since the person who moved the ticket upstream is not a
 * Deckgauge actor.
 */
export interface AutomationContext {
  actorId: string | null;
  organizationId: string | null;
}

/** Structural shape of an AutomationRule row — avoids coupling to Prisma's model type. */
export interface AutomationRuleRow {
  id: string;
  name: string;
  trigger: unknown;
  action: unknown;
}

export interface EvaluateAutomationsInput {
  boardId: string;
  projectId: string;
  changes: AutomationChanges;
  context?: AutomationContext;
}

export interface EvaluateAutomationsOptions {
  /**
   * Pre-loaded rules for this board. A sync evaluates every row it touches, and
   * re-reading the same handful of rules once per row is the difference between
   * one query and one per issue. Omit it and the rules are loaded here.
   */
  rules?: readonly AutomationRuleRow[];
}

/** The enabled rules for a board, in creation order. */
export async function loadEnabledRules(
  prisma: PrismaClient,
  boardId: string,
): Promise<AutomationRuleRow[]> {
  return await prisma.automationRule.findMany({
    where: { boardId, enabled: true },
    select: { id: true, name: true, trigger: true, action: true },
  });
}

interface ParsedTrigger {
  type: string;
  value?: string;
}

interface ParsedAction {
  type: string;
  targetGroupId?: string;
  targetStatus?: string;
  message?: string;
}

/**
 * Does this rule's trigger match the change that just happened?
 *
 * Handles two status-change paths:
 *  1. `status` enum changed directly (boards without custom statuses).
 *  2. `statusId` changed (custom board statuses via DynamicStatusPill) but the enum
 *     `status` field was not updated — we look up the board status label and map it
 *     to the enum equivalent so triggers still fire correctly.
 */
async function triggerMatches(
  prisma: PrismaClient,
  trigger: ParsedTrigger,
  changes: AutomationChanges,
): Promise<boolean> {
  if (trigger.type === 'status_change') {
    // The AutomationPanel UI stores the board-status *label* (e.g. "Done") as
    // trigger.value, but the live status is compared in its enum form ("DONE").
    // Normalize the trigger value through the same label→enum map so
    // default-status labels match. Custom labels (no enum equivalent) and legacy
    // enum-form trigger values pass through unchanged.
    const triggerValue = trigger.value
      ? BOARD_STATUS_LABEL_TO_ENUM[trigger.value] ?? trigger.value
      : undefined;

    // Path 1: enum status changed
    if (changes.status !== undefined && changes.status !== changes.previousStatus) {
      if (!triggerValue || triggerValue === changes.status) return true;
    }

    // Path 2: custom statusId changed but enum status did not
    if (
      changes.statusId !== undefined &&
      changes.statusId !== changes.previousStatusId &&
      changes.statusId !== null
    ) {
      const boardStatus = await prisma.boardStatus.findUnique({
        where: { id: changes.statusId },
      });
      if (boardStatus) {
        const enumEquivalent = BOARD_STATUS_LABEL_TO_ENUM[boardStatus.label];
        const effectiveStatus = enumEquivalent ?? boardStatus.label;
        if (!triggerValue || triggerValue === effectiveStatus) return true;
      }
    }
  }

  if (trigger.type === 'item_created' && changes.previousStatus === undefined) {
    return true;
  }

  return false;
}

/**
 * Evaluate every enabled rule on a board against one row's change, running the
 * action of each that matches.
 */
export async function evaluateAutomations(
  prisma: PrismaClient,
  input: EvaluateAutomationsInput,
  options: EvaluateAutomationsOptions = {},
): Promise<void> {
  const { boardId, projectId, changes, context } = input;
  const rules = options.rules ?? (await loadEnabledRules(prisma, boardId));

  for (const rule of rules) {
    const trigger = rule.trigger as ParsedTrigger;
    const action = rule.action as ParsedAction;

    if (!(await triggerMatches(prisma, trigger, changes))) continue;

    if (action.type === 'move_to_group' && action.targetGroupId) {
      await prisma.project.update({
        where: { id: projectId },
        data: { groupId: action.targetGroupId },
      });
    } else if (action.type === 'change_status' && action.targetStatus) {
      await prisma.project.update({
        where: { id: projectId },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data: { status: action.targetStatus as unknown as any },
      });
    } else if (action.type === 'notify' && action.message) {
      // Was a console.log since the action type shipped. Immediate by default:
      // somebody deliberately built a rule that says "tell me", and rolling that
      // into tomorrow's summary reads as the automation being broken.
      if (context?.organizationId) {
        const { participantIds } = await itemParticipants(prisma, {
          projectId,
          boardId,
          organizationId: context.organizationId,
        });
        if (participantIds.length > 0) {
          await new NotificationDispatcher(prisma).dispatch({
            kind: 'AUTOMATION_NOTIFY',
            organizationId: context.organizationId,
            actorId: context.actorId,
            recipientIds: participantIds,
            subject: { kind: 'project', id: projectId, boardId },
            payload: { message: action.message, ruleName: rule.name },
          });
        }
      }
    }
  }
}

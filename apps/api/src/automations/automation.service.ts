import type { PrismaClient } from '@deckgauge/db';
import { z } from 'zod';
import { evaluateAutomations } from '@deckgauge/automations';

const TriggerSchema = z.object({
  type: z.enum(['status_change', 'date_arrives', 'item_created']),
  field: z.string().optional(),
  value: z.string().optional(),
});

const ActionSchema = z.object({
  type: z.enum(['move_to_group', 'change_status', 'notify']),
  targetGroupId: z.string().uuid().optional(),
  targetStatus: z.string().optional(),
  message: z.string().optional(),
});

export const CreateAutomationInputSchema = z.object({
  name: z.string().trim().min(1),
  trigger: TriggerSchema,
  action: ActionSchema,
  enabled: z.boolean().default(true),
});
export type CreateAutomationInput = z.infer<typeof CreateAutomationInputSchema>;

export const UpdateAutomationInputSchema = z.object({
  name: z.string().trim().min(1).optional(),
  trigger: TriggerSchema.optional(),
  action: ActionSchema.optional(),
  enabled: z.boolean().optional(),
});
export type UpdateAutomationInput = z.infer<typeof UpdateAutomationInputSchema>;

export class AutomationService {
  constructor(private readonly prisma: PrismaClient) {}

  async listByBoard(boardId: string) {
    return await this.prisma.automationRule.findMany({
      where: { boardId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async create(boardId: string, input: CreateAutomationInput) {
    const validated = CreateAutomationInputSchema.parse(input);

    const board = await this.prisma.board.findUnique({
      where: { id: boardId },
    });
    if (!board) return null;

    return await this.prisma.automationRule.create({
      data: {
        boardId,
        name: validated.name,
        trigger: validated.trigger,
        action: validated.action,
        enabled: validated.enabled,
      },
    });
  }

  async update(id: string, input: UpdateAutomationInput) {
    const validated = UpdateAutomationInputSchema.parse(input);

    const existing = await this.prisma.automationRule.findUnique({
      where: { id },
    });
    if (!existing) return null;

    const data: Record<string, unknown> = {};
    if (validated.name !== undefined) data.name = validated.name;
    if (validated.trigger !== undefined) data.trigger = validated.trigger;
    if (validated.action !== undefined) data.action = validated.action;
    if (validated.enabled !== undefined) data.enabled = validated.enabled;

    return await this.prisma.automationRule.update({ where: { id }, data });
  }

  async delete(id: string): Promise<boolean> {
    const existing = await this.prisma.automationRule.findUnique({
      where: { id },
    });
    if (!existing) return false;

    await this.prisma.automationRule.delete({ where: { id } });
    return true;
  }

  /**
   * Evaluate automation rules after a project update.
   * Called by the project routes after POST /projects and PATCH /projects/:id.
   *
   * A thin delegate: the rule engine itself lives in `@deckgauge/automations` so
   * the sync worker evaluates the SAME rules against the rows it writes. See that
   * package for the two status-change paths and the trigger semantics.
   */
  async evaluateTriggers(
    boardId: string,
    projectId: string,
    changes: {
      status?: string;
      previousStatus?: string;
      statusId?: string | null;
      previousStatusId?: string | null;
    },
    context?: { actorId: string | null; organizationId: string | null },
  ) {
    await evaluateAutomations(this.prisma, { boardId, projectId, changes, context });
  }
}

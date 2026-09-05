import { z } from 'zod/v4';
import { SIZE_LABELS } from './roadmap-schedule.js';

export const SizeDurationsSchema = z.object(
  Object.fromEntries(SIZE_LABELS.map((s) => [s, z.number().positive()])) as Record<
    (typeof SIZE_LABELS)[number],
    z.ZodNumber
  >,
);

export const RoadmapConfigPayloadSchema = z.object({
  id: z.string().uuid(),
  boardViewId: z.string().uuid(),
  startDate: z.string(), // ISO date
  visibleQuarters: z.number().int().min(1).max(40),
  sizeDurations: SizeDurationsSchema,
  defaultSizeWeeks: z.number().positive(),
  hiddenGroupIds: z.array(z.string()),
});
export type RoadmapConfigPayload = z.infer<typeof RoadmapConfigPayloadSchema>;

export const UpdateRoadmapConfigInputSchema = z
  .object({
    startDate: z.string().optional(),
    visibleQuarters: z.number().int().min(1).max(40).optional(),
    sizeDurations: SizeDurationsSchema.optional(),
    defaultSizeWeeks: z.number().positive().optional(),
    hiddenGroupIds: z.array(z.string()).optional(),
  })
  .refine((d) => Object.keys(d).length > 0, {
    message: 'At least one field must be provided',
  });
export type UpdateRoadmapConfigInput = z.infer<typeof UpdateRoadmapConfigInputSchema>;

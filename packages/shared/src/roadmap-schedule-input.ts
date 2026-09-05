import { z } from 'zod/v4';
import { DURATION_RE } from './duration.js';

const isoDate = z.string().datetime();
const durationStr = z.string().regex(DURATION_RE, 'Invalid duration (use e.g. 1d, 2w, 1m, 1y)');

export const SetScheduleInputSchema = z
  .object({
    startDate: isoDate.nullable().optional(),
    endDate: isoDate.nullable().optional(),
    durationCode: durationStr.nullable().optional(),
  })
  .refine((d) => Object.keys(d).length > 0, { message: 'At least one field required' })
  .refine(
    (d) => !(d.startDate && d.endDate) || new Date(d.endDate) >= new Date(d.startDate),
    { message: 'endDate must be on or after startDate', path: ['endDate'] },
  );
export type SetScheduleInput = z.infer<typeof SetScheduleInputSchema>;

export const SYSTEM_FIELD_KEYS = ['size', 'startDate', 'endDate', 'duration'] as const;
export type SystemFieldKey = (typeof SYSTEM_FIELD_KEYS)[number];

export const HiddenSystemFieldsSchema = z.array(z.enum(SYSTEM_FIELD_KEYS));
export type HiddenSystemFields = z.infer<typeof HiddenSystemFieldsSchema>;

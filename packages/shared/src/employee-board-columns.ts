import { z } from 'zod';
import { MIN_COLUMN_WIDTH, MAX_COLUMN_WIDTH } from './column-layout-schemas.js';

export const EMPLOYEE_BOARD_COLUMN_KEYS = [
  'name',
  'businessTitle',
  'email',
  'manager',
  'hireDate',
  'employeeType',
  'timeType',
  'location',
  'phone',
  'salary',
  'rating',
] as const;

export const EmployeeBoardColumnKeySchema = z.enum(EMPLOYEE_BOARD_COLUMN_KEYS);
export type EmployeeBoardColumnKey = z.infer<typeof EmployeeBoardColumnKeySchema>;

export const DEFAULT_COLUMN_ORDER: EmployeeBoardColumnKey[] = [...EMPLOYEE_BOARD_COLUMN_KEYS];

export const EmployeeColumnTypeSchema = z.enum([
  'TEXT',
  'NUMBER',
  'DATE',
  'CHECKBOX',
  'DROPDOWN',
  'LINK',
]);
export type EmployeeColumnType = z.infer<typeof EmployeeColumnTypeSchema>;

export const EmployeeBoardColumnConfigSchema = z.object({
  order: z.array(z.string()),
  hidden: z.array(z.string()),
  // Per-column pixel widths (Monday-style resize). Keyed by column key (built-in
  // key or custom column id). Optional so configs saved before resize existed
  // still parse; consumers read `widths ?? {}`. Out-of-range widths are rejected
  // by the min/max bounds.
  widths: z
    .record(z.string(), z.number().int().min(MIN_COLUMN_WIDTH).max(MAX_COLUMN_WIDTH))
    .optional(),
});
export type EmployeeBoardColumnConfig = z.infer<typeof EmployeeBoardColumnConfigSchema>;

/**
 * Ordered visible columns (built-in keys ∪ custom column ids). Valid keys =
 * DEFAULT_COLUMN_ORDER ∪ customColumnIds. Filters order to valid keys, appends
 * any valid key missing from order (built-in defaults first, then new custom
 * ids), removes hidden. Ids that are neither a built-in key nor a current custom
 * id are dropped (deleted columns). A built-in is never dropped.
 */
export function resolveColumns(
  config: Pick<EmployeeBoardColumnConfig, 'order' | 'hidden'> | null,
  customColumnIds: string[] = []
): string[] {
  const valid = new Set<string>([...DEFAULT_COLUMN_ORDER, ...customColumnIds]);
  const ordered = (config?.order ?? []).filter((k) => valid.has(k));
  const seen = new Set(ordered);
  for (const k of DEFAULT_COLUMN_ORDER) if (!seen.has(k)) ordered.push(k);
  for (const id of customColumnIds) if (!seen.has(id) && !ordered.includes(id)) ordered.push(id);
  const hidden = new Set(config?.hidden ?? []);
  return ordered.filter((k) => !hidden.has(k));
}

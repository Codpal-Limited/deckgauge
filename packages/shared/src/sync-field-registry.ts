/**
 * The vocabulary of fields a board row can inherit from a sync source, and the
 * rules governing when a manual edit blocks that inheritance.
 *
 * Pure by design — no Prisma, no I/O — because both the worker (deciding what
 * to write) and the API (recording an edit, performing a revert) need the same
 * answers, and they share no runtime.
 */

export type SyncSource = 'jira' | 'ado' | 'github';

export interface SyncFieldSpec {
  /** Stable key stored in Project.overriddenFields and preOverrideValues. */
  key: string;
  /** Human label for the revert affordance. */
  label: string;
  /** Sources that can supply this field at all. */
  sources: readonly SyncSource[];
  /**
   * Whether the row's persisted allow-list (jiraSyncedFields / adoSyncedFields /
   * githubSyncedFields) governs this field.
   *
   * True only for the three fields EVERY provider's allow-list carries. A field
   * some provider's allow-list omits must be ungated: that provider's existing
   * rows were stamped without its key, so gating it would mean the field never
   * syncs on any row that already exists.
   */
  allowListGated: boolean;
}

export const SYNC_FIELDS: readonly SyncFieldSpec[] = [
  { key: 'name', label: 'Name', sources: ['jira', 'ado', 'github'], allowListGated: true },
  { key: 'status', label: 'Status', sources: ['jira', 'ado', 'github'], allowListGated: true },
  { key: 'owner', label: 'Owner', sources: ['jira', 'ado', 'github'], allowListGated: true },
  // Ungated because the JIRA and ADO allow-lists never contain it. GitHub's
  // `default_synced_fields` defaults to ["name","description","status","owner"],
  // but Jira's and ADO's default to ["name","status","owner"] — in the DB column
  // AND in the input schemas — and nothing in the product ever writes the column,
  // so for those two providers the gate could never be satisfied. Gating it meant
  // a Jira/ADO description was written once by the create path (which does not
  // consult the allow-list) and then frozen: PROJ-1721 was imported while its
  // Jira description was empty and could never pick it up afterwards.
  { key: 'description', label: 'Description', sources: ['jira', 'ado', 'github'], allowListGated: false },
  // GitHub issues carry no due date — only milestones do — so it is absent here
  // and the badge never appears on a GitHub row.
  { key: 'dueDate', label: 'Due date', sources: ['jira', 'ado'], allowListGated: false },
] as const;

const SPEC_BY_KEY = new Map(SYNC_FIELDS.map((f) => [f.key, f]));

export function syncFieldSpec(key: string): SyncFieldSpec | undefined {
  return SPEC_BY_KEY.get(key);
}

export function syncFieldsForSource(source: SyncSource): readonly SyncFieldSpec[] {
  return SYNC_FIELDS.filter((f) => f.sources.includes(source));
}

/** Namespace prefix that lets one flat key set span both storage shapes. */
export const CUSTOM_COLUMN_KEY_PREFIX = 'col:';

export function customColumnKey(columnId: string): string {
  return `${CUSTOM_COLUMN_KEY_PREFIX}${columnId}`;
}

export function isCustomColumnKey(key: string): boolean {
  return key.startsWith(CUSTOM_COLUMN_KEY_PREFIX);
}

export function columnIdFromKey(key: string): string | null {
  return isCustomColumnKey(key) ? key.slice(CUSTOM_COLUMN_KEY_PREFIX.length) : null;
}

/**
 * Whether sync may write this field on this row.
 *
 * An override always wins: it is the user's explicit instruction, whereas the
 * allow-list is per-board configuration.
 */
export function shouldSync(args: {
  key: string;
  overriddenFields: readonly string[];
  syncedFields: readonly string[];
}): boolean {
  if (args.overriddenFields.includes(args.key)) return false;
  const spec = syncFieldSpec(args.key);
  // Unknown keys and custom columns are ungated — nothing has ever written them
  // into a row's allow-list, so consulting it would always answer "no".
  if (!spec || !spec.allowListGated) return true;
  return args.syncedFields.includes(args.key);
}

export interface OverrideState {
  overriddenFields: string[];
  preOverrideValues: Record<string, unknown>;
}

/** Normalises the two nullable Prisma columns into a usable state object. */
export function readOverrideState(row: {
  overriddenFields?: unknown;
  preOverrideValues?: unknown;
}): OverrideState {
  return {
    overriddenFields: Array.isArray(row.overriddenFields) ? [...(row.overriddenFields as string[])] : [],
    preOverrideValues:
      row.preOverrideValues && typeof row.preOverrideValues === 'object'
        ? { ...(row.preOverrideValues as Record<string, unknown>) }
        : {},
  };
}

/**
 * Records a manual edit of `key`, capturing what the field held beforehand.
 *
 * The early return is the correctness crux of the whole feature: it captures
 * the pre-edit value only on the FIRST edit of a dirty streak. Without it, a
 * second edit would overwrite the snapshot with the first edit's value, and
 * "revert to synced value" would hand the user back their own earlier edit
 * instead of the source's value.
 */
export function markOverridden(
  state: OverrideState,
  key: string,
  currentValue: unknown,
): OverrideState {
  if (state.overriddenFields.includes(key)) return state;
  return {
    overriddenFields: [...state.overriddenFields, key],
    preOverrideValues: { ...state.preOverrideValues, [key]: currentValue ?? null },
  };
}

/** Re-links `key` to its source and prunes the snapshot entry it no longer needs. */
export function clearOverride(state: OverrideState, key: string): OverrideState {
  if (!state.overriddenFields.includes(key)) return state;
  const preOverrideValues = { ...state.preOverrideValues };
  delete preOverrideValues[key];
  return {
    overriddenFields: state.overriddenFields.filter((k) => k !== key),
    preOverrideValues,
  };
}

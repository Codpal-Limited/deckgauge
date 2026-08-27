import type { JiraFieldSchemaShape, MappableColumnType } from "./jira-field-schemas";

/**
 * How a joined multi-value column is stored and re-split.
 *
 * Storage is comma-separated because that is what a plain-text read of the
 * column should show. But component and version names may legally contain a
 * comma, so each value is percent-escaped before joining: without it, one
 * component named "Foo, Bar" would come back as two chips.
 *
 * Escape order matters. `%` MUST be escaped before `,`, or the `%` introduced
 * by escaping a comma gets escaped in turn and the value round-trips wrong.
 */
export const MULTI_VALUE_DELIMITER = ", ";

function escapeValue(value: string): string {
  return value.replace(/%/g, "%25").replace(/,/g, "%2C");
}

function unescapeValue(value: string): string {
  return value.replace(/%2C/g, ",").replace(/%25/g, "%");
}

export function joinMultiValue(values: string[]): string {
  return values.map(escapeValue).join(MULTI_VALUE_DELIMITER);
}

export function splitMultiValue(stored: string): string[] {
  if (stored === "") return [];
  return stored.split(MULTI_VALUE_DELIMITER).map(unescapeValue);
}

/** Jira `schema.type` → the board ColumnType that can represent it. */
const SCALAR_TYPE_MAP: Record<string, MappableColumnType> = {
  string: "TEXT",
  number: "NUMBER",
  date: "DATE",
  datetime: "DATE",
  user: "PERSON",
  option: "DROPDOWN",
  priority: "DROPDOWN",
  resolution: "DROPDOWN",
};

/** Array element types whose entries we know how to reduce to a string. */
const REPRESENTABLE_ITEM_TYPES = new Set([
  "string",
  "user",
  "component",
  "version",
  "option",
  "group",
  "priority",
  "resolution",
  // Sprint — a curated, top-pinned field — is `{ type: 'array', items: 'json' }`
  // on Jira Cloud, so omitting "json" made it unmappable and the picker showed
  // it disabled. `extractScalar` already reduces a sprint entry via its `name`
  // key, and an entry it cannot reduce yields null and is dropped, so the
  // "[object Object]" invariant holds for any other json-item field too.
  "json",
]);

export function columnTypeForJiraField(
  schema: JiraFieldSchemaShape | undefined,
): MappableColumnType | null {
  if (!schema) return null;
  if (schema.type === "array") {
    return schema.items && REPRESENTABLE_ITEM_TYPES.has(schema.items) ? "TEXT" : null;
  }
  return SCALAR_TYPE_MAP[schema.type] ?? null;
}

export function unsupportedReasonFor(
  schema: JiraFieldSchemaShape | undefined,
): string | null {
  if (!schema) return "Jira does not expose a value for this field";
  if (columnTypeForJiraField(schema) !== null) return null;
  if (schema.type === "array") {
    return `Lists of "${schema.items ?? "unknown"}" cannot be shown as a column`;
  }
  return `Fields of type "${schema.type}" cannot be shown as a column`;
}

/**
 * Reduce one Jira value to a display string, or null if we cannot.
 *
 * Returning null rather than guessing is the invariant that keeps
 * "[object Object]" out of the board: an unrecognised shape writes nothing and
 * leaves whatever the column already held.
 */
function extractScalar(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string") return raw === "" ? null : raw;
  if (typeof raw === "number") return String(raw);
  if (typeof raw === "boolean") return raw ? "Yes" : "No";
  if (typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    // Ordered by specificity: a user carries both emailAddress and displayName
    // and we prefer the email, because that is what the board matches
    // identities on elsewhere.
    for (const key of ["emailAddress", "value", "name", "displayName"]) {
      const candidate = obj[key];
      if (typeof candidate === "string" && candidate !== "") return candidate;
      if (typeof candidate === "number") return String(candidate);
    }
  }
  return null;
}

export function extractJiraFieldValue(
  schema: JiraFieldSchemaShape,
  raw: unknown,
): string | null {
  if (columnTypeForJiraField(schema) === null) return null;
  if (raw === null || raw === undefined) return null;

  if (schema.type === "array") {
    if (!Array.isArray(raw)) return null;
    const values = raw
      .map(extractScalar)
      .filter((v): v is string => v !== null);
    return values.length === 0 ? null : joinMultiValue(values);
  }

  return extractScalar(raw);
}

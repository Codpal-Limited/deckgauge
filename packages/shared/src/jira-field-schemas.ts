import { z } from "zod/v4";

/**
 * Jira's own `schema` block on a field descriptor, as returned by
 * `GET /rest/api/3/field`. `type` is the discriminator we map to a ColumnType;
 * `items` names the element type when `type` is "array".
 */
export const JiraFieldSchemaShapeSchema = z.object({
  type: z.string(),
  items: z.string().optional(),
  custom: z.string().optional(),
  customId: z.number().optional(),
});
export type JiraFieldSchemaShape = z.infer<typeof JiraFieldSchemaShapeSchema>;

/**
 * One entry from `GET /rest/api/3/field`.
 *
 * `schema` is optional because Jira omits it on navigable-only fields such as
 * "Key" and "Linked Issues"; those are unmappable anyway and surface as
 * unsupported.
 */
export const JiraFieldMetaSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  custom: z.boolean(),
  schema: JiraFieldSchemaShapeSchema.optional(),
});
export type JiraFieldMeta = z.infer<typeof JiraFieldMetaSchema>;

/** ColumnType values a discovered Jira field may map onto. */
export const MappableColumnTypeSchema = z.enum([
  "TEXT",
  "NUMBER",
  "DATE",
  "PERSON",
  "DROPDOWN",
]);
export type MappableColumnType = z.infer<typeof MappableColumnTypeSchema>;

/** A field as the picker sees it: Jira's metadata plus our verdict on it. */
export const DiscoveredJiraFieldSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  custom: z.boolean(),
  columnType: MappableColumnTypeSchema.nullable(),
  supported: z.boolean(),
  unsupportedReason: z.string().nullable().default(null),
  /**
   * Whether this field's values are a joined list rather than a scalar.
   *
   * Travels all the way to `BoardColumn.config` so the cell renderer knows to
   * split into chips. It cannot be re-derived downstream: the column's type is
   * TEXT either way, so a joined "backend, api" and a hand-typed "backend, api"
   * are indistinguishable once stored.
   */
  multiValue: z.boolean().default(false),
});
export type DiscoveredJiraField = z.infer<typeof DiscoveredJiraFieldSchema>;

export const DiscoveredJiraFieldListSchema = z.object({
  fields: z.array(DiscoveredJiraFieldSchema),
});

/** Body of `POST /boards/:boardId/sources/jira/:id/fields`. */
export const AttachJiraFieldInputSchema = z.object({
  fieldId: z.string().min(1),
  name: z.string().trim().min(1).max(100),
  columnType: MappableColumnTypeSchema,
  /** Recorded on the column so the renderer knows to split into chips. */
  multiValue: z.boolean().default(false),
});
export type AttachJiraFieldInput = z.infer<typeof AttachJiraFieldInputSchema>;

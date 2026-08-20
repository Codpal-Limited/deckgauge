import { z } from "zod/v4";

export const STATUS_COLORS = [
  // Original 20-color palette.
  "#C4C4C4", "#579BFC", "#FDAB3D", "#E44258",
  "#00C875", "#FF642E", "#FFCB00", "#A25DDC",
  "#FF7EB8", "#7F5347", "#175A63", "#BDA8F0",
  "#FF5AC4", "#4ECCC6", "#66CCFF", "#7E3B8A",
  "#BB3354", "#F37021", "#CAB641", "#009AFF",
  // Extended palette (30 more) so boards that map many distinct ADO states
  // rarely reuse a color. All distinct from the originals and each other.
  "#037F4C", "#00A881", "#9CD326", "#9AADBD",
  "#0086C0", "#2B76E5", "#00C2E0", "#401694",
  "#5559DF", "#784BD1", "#9D50DD", "#C397F5",
  "#FF158A", "#E2445C", "#D83A52", "#FF3D57",
  "#E8697D", "#FFADAD", "#FF9D48", "#FFA600",
  "#FDBC64", "#B07A3B", "#563E3E", "#225091",
  "#2C3E50", "#11A683", "#66E0CA", "#7BD235",
  "#808080", "#333333",
] as const;

export const DEFAULT_BOARD_STATUSES = [
  { label: "Not Started", color: "#C4C4C4", icon: "\u25CB", order: 0, isDefault: true },
  { label: "In Progress", color: "#579BFC", icon: "\u25D1", order: 1, isDefault: false },
  { label: "At Risk",     color: "#FDAB3D", icon: "\u26A0", order: 2, isDefault: false },
  { label: "Blocked",     color: "#E44258", icon: "\u2297", order: 3, isDefault: false },
  { label: "Done",        color: "#00C875", icon: "\u2713", order: 4, isDefault: false },
] as const;

/**
 * The status a sync applies to a board row whose source issue is gone from the
 * upstream tracker. Deliberately absent from both DEFAULT_BOARD_STATUSES (boards
 * that never lose an issue never show the option) and STATUS_COLORS (so
 * pickUnusedColor can never hand black to an unrelated status — black means
 * "the source issue is gone" and nothing else).
 *
 * The white pill text is not configured here: DynamicStatusPill renders every
 * status label in `text-white`, so black background gives white-on-black.
 */
export const DELETED_STATUS_LABEL = "Deleted";
export const DELETED_STATUS_COLOR = "#000000";

export const BoardStatusSchema = z.object({
  id: z.string().uuid(),
  boardId: z.string().uuid(),
  label: z.string().trim().min(1),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  icon: z.string().max(10).nullable().default(null),
  order: z.number().int().min(0),
  isDefault: z.boolean(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export type BoardStatus = z.infer<typeof BoardStatusSchema>;

export const CreateBoardStatusInputSchema = z.object({
  label: z.string().trim().min(1).max(50),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  icon: z.string().max(10).optional(),
});

export type CreateBoardStatusInput = z.infer<typeof CreateBoardStatusInputSchema>;

export const UpdateBoardStatusInputSchema = z.object({
  label: z.string().trim().min(1).max(50).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  icon: z.string().max(10).nullish(),
  order: z.number().int().min(0).optional(),
  isDefault: z.boolean().optional(),
});

export type UpdateBoardStatusInput = z.infer<typeof UpdateBoardStatusInputSchema>;

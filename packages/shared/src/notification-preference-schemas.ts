import { z } from "zod/v4";
import { NotificationKindSchema, type NotificationKindValue } from "./notification-schemas.js";

/**
 * Notification preferences. IN-APP ONLY — "IMMEDIATE" means the bell, and
 * "DIGEST" means the in-app roll-up, never email.
 */

export const NotificationModeSchema = z.enum(["IMMEDIATE", "DIGEST", "OFF"]);
export type NotificationMode = z.infer<typeof NotificationModeSchema>;

export const BoardNotificationLevelSchema = z.enum(["ALL", "MENTIONS_ONLY", "NONE"]);
export type BoardNotificationLevel = z.infer<typeof BoardNotificationLevelSchema>;

/**
 * The defaults live HERE, in code, and the preference tables are sparse — only a
 * deliberate choice is ever stored. So changing a default is a code change, not a
 * data migration over every user who never opened the settings screen.
 *
 * The two `DIGEST` entries are the kinds that fire in bursts. Without them the
 * digest has nothing to roll up and is only a list of things already seen.
 * `DIGEST` itself is `IMMEDIATE`: the summary row is the delivery.
 */
export const DEFAULT_NOTIFICATION_MODES: Record<NotificationKindValue, NotificationMode> = {
  MENTION: "IMMEDIATE",
  ITEM_ASSIGNED: "IMMEDIATE",
  ITEM_COMMENT_ADDED: "IMMEDIATE",
  ITEM_DUE_SOON: "IMMEDIATE",
  ITEM_OVERDUE: "IMMEDIATE",
  ENTITY_SHARED: "IMMEDIATE",
  ACCESS_ROLE_CHANGED: "IMMEDIATE",
  ORG_MEMBER_INVITED: "IMMEDIATE",
  AUTOMATION_NOTIFY: "IMMEDIATE",
  ITEM_STATUS_CHANGED: "DIGEST",
  ITEM_DUE_DATE_CHANGED: "DIGEST",
  DIGEST: "IMMEDIATE",
};

/** One row of the settings screen. */
export const NotificationPreferenceSchema = z.object({
  kind: NotificationKindSchema,
  mode: NotificationModeSchema,
});
export type NotificationPreference = z.infer<typeof NotificationPreferenceSchema>;

export const NotificationPreferencesResponseSchema = z.object({
  preferences: z.array(NotificationPreferenceSchema),
});
export type NotificationPreferencesResponse = z.infer<typeof NotificationPreferencesResponseSchema>;

export const UpdateNotificationPreferencesInputSchema = z.object({
  preferences: z.array(NotificationPreferenceSchema).min(1),
});
export type UpdateNotificationPreferencesInput = z.infer<
  typeof UpdateNotificationPreferencesInputSchema
>;

export const BoardNotificationSettingSchema = z.object({
  boardId: z.string().uuid(),
  level: BoardNotificationLevelSchema,
});
export type BoardNotificationSetting = z.infer<typeof BoardNotificationSettingSchema>;

export const UpdateBoardNotificationSettingInputSchema = z.object({
  level: BoardNotificationLevelSchema,
});
export type UpdateBoardNotificationSettingInput = z.infer<
  typeof UpdateBoardNotificationSettingInputSchema
>;

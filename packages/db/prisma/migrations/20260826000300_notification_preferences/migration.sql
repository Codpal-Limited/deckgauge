-- Per-kind and per-board notification preferences (notification system §5.2-3).
--
-- Both tables are SPARSE: only a deliberate choice is stored. Defaults live in
-- packages/shared (DEFAULT_NOTIFICATION_MODES), so changing one is a code change,
-- not a backfill over every user who never opened the settings screen.
--
-- `mode` and `level` are TEXT with a CHECK rather than Postgres enums: they are
-- read only by application code that already has the Zod enum, and a TEXT column
-- makes adding a level a one-line constraint change instead of ALTER TYPE.
CREATE TABLE "notification_preferences" (
    "id"              TEXT NOT NULL,
    "user_id"         TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "kind"            "notification_kind" NOT NULL,
    "mode"            TEXT NOT NULL,
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "notification_preferences_mode_check" CHECK ("mode" IN ('IMMEDIATE', 'DIGEST', 'OFF'))
);

CREATE UNIQUE INDEX "notification_preferences_user_id_organization_id_kind_key"
  ON "notification_preferences"("user_id", "organization_id", "kind");

ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "board_notification_settings" (
    "id"         TEXT NOT NULL,
    "user_id"    TEXT NOT NULL,
    "board_id"   TEXT NOT NULL,
    "level"      TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "board_notification_settings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "board_notification_settings_level_check" CHECK ("level" IN ('ALL', 'MENTIONS_ONLY', 'NONE'))
);

CREATE UNIQUE INDEX "board_notification_settings_user_id_board_id_key"
  ON "board_notification_settings"("user_id", "board_id");
CREATE INDEX "board_notification_settings_board_id_idx"
  ON "board_notification_settings"("board_id");

ALTER TABLE "board_notification_settings" ADD CONSTRAINT "board_notification_settings_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "board_notification_settings" ADD CONSTRAINT "board_notification_settings_board_id_fkey"
  FOREIGN KEY ("board_id") REFERENCES "boards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

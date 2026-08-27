-- Superseded by overridden_fields / pre_override_values, back-filled by
-- 20260826000100_project_field_overrides. No code has read this column since
-- the per-field override set landed.
ALTER TABLE "projects" DROP COLUMN "owner_overridden";

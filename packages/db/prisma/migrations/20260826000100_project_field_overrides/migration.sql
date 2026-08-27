ALTER TABLE "projects" ADD COLUMN "overridden_fields" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "projects" ADD COLUMN "pre_override_values" JSONB;

-- Carry the bespoke owner dirty bit over. `assignee` is the closest available
-- truth for the pre-edit value: it is exactly what the old
-- resetOwnerToAssignee would have restored.
--
-- owner_overridden itself is dropped in a later migration (Task 11), once no
-- code reads it. Keeping both readable for a few commits is what lets each
-- task in between compile and test on its own.
UPDATE "projects"
   SET "overridden_fields"   = ARRAY['owner'],
       "pre_override_values" = jsonb_build_object('owner', "assignee")
 WHERE "owner_overridden" = true;

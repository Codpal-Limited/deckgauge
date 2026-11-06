-- Org employee photos (spec docs/superpowers/specs/2026-11-04-org-employee-photos-design.md).
--
-- Hand-written: `prisma migrate dev` cannot run here (shadow-DB P3006).
--
--   photo_upload_id — the stored copy of the person's photo. Imports DOWNLOAD the
--     photo because BambooHR's photo URLs are signed and expire 30 days after
--     export. ON DELETE SET NULL: losing the file must not take the employee with it.
--   photo_source — the source URL without its query string (the signed part changes
--     on every export; the path carries the photo's version), so a re-import of an
--     unchanged photo is recognised and not re-downloaded.

ALTER TABLE "org_employees"
  ADD COLUMN "photo_upload_id" TEXT,
  ADD COLUMN "photo_source" TEXT;

CREATE UNIQUE INDEX "org_employees_photo_upload_id_key" ON "org_employees"("photo_upload_id");

ALTER TABLE "org_employees"
  ADD CONSTRAINT "org_employees_photo_upload_id_fkey"
  FOREIGN KEY ("photo_upload_id") REFERENCES "uploads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

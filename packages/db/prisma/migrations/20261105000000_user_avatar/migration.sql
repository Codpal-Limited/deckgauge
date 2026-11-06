-- A signed-in person's own profile photo (stored upload).
ALTER TABLE "users" ADD COLUMN "avatar_upload_id" TEXT;

CREATE UNIQUE INDEX "users_avatar_upload_id_key" ON "users"("avatar_upload_id");

ALTER TABLE "users" ADD CONSTRAINT "users_avatar_upload_id_fkey" FOREIGN KEY ("avatar_upload_id") REFERENCES "uploads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

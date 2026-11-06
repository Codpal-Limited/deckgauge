-- A row a user added from a pasted source link: it bypasses the board source's
-- scope filters on sync instead of being flagged removed by them.
ALTER TABLE "projects" ADD COLUMN "linked_from_source" BOOLEAN NOT NULL DEFAULT false;

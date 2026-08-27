-- Split name on the account (notification system design §4).
--
-- Nullable, and backfilled by splitting the existing combined name on the FIRST
-- space: "Dana Levi Cohen" is Dana / Levi Cohen, which is the right guess far
-- more often than the reverse. Rows whose name is an email address are left NULL
-- rather than producing a first name of "dana@example.com" — those fill in from
-- the `given_name` / `family_name` claims on next login.
ALTER TABLE "users"
  ADD COLUMN "first_name" TEXT,
  ADD COLUMN "last_name"  TEXT;

-- btrim before splitting, and NULLIF after, so a name that is padded or has
-- doubled spaces yields NULL rather than an empty-string "first name" that would
-- read as a real value everywhere downstream.
UPDATE "users"
SET "first_name" = NULLIF(split_part(btrim("name"), ' ', 1), ''),
    "last_name"  = NULLIF(
      btrim(substring(btrim("name") FROM position(' ' IN btrim("name")) + 1)),
      ''
    )
WHERE btrim("name") LIKE '% %'
  AND "name" NOT LIKE '%@%';

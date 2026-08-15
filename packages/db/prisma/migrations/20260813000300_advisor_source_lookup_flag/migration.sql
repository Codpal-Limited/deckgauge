-- Operator off switch for the Advisor's source-lookup tools (search_source /
-- read_source). Default TRUE, which preserves the behaviour of every existing
-- row: those tools read only source this repo already publishes under
-- FSL-1.1-Apache-2.0, and only through a path allowlist (three roots, three
-- extensions, realpath-resolved, symlinks rejected). An operator who keeps
-- private modules inside the source tree flips this to FALSE.
--
-- "AdvisorConfig" is quoted and the column is camelCase on purpose: unlike the
-- rest of this schema, that model carries no @@map/@map, so its table really is
-- mixed-case with camelCase columns (see 20260803000000_advisor_config).
ALTER TABLE "AdvisorConfig"
  ADD COLUMN IF NOT EXISTS "sourceLookupEnabled" BOOLEAN NOT NULL DEFAULT true;

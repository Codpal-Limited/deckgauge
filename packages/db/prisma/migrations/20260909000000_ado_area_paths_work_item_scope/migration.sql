-- Area path is now the ADO work-item scope: it narrows the BOARD as well as
-- Engineering Intelligence, so the `intelligence_` prefix is no longer true.
-- A rename preserves values, so boards that already selected area paths keep
-- them with no backfill.
ALTER TABLE board_ado_sources RENAME COLUMN intelligence_area_paths TO area_paths;

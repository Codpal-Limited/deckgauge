-- Per-board ADO area-path scope for engineering intelligence.
--
-- `intelligence_repos` cannot narrow work items: ado_work_items has no
-- repository column, so a repo restriction is structurally inapplicable to
-- tickets. area_path is ADO's team-ownership dimension and is already ingested.
--
-- Empty array means ALL area paths in the project, so this is a no-op for every
-- existing board_ado_sources row. Matching is by PREFIX — selecting
-- 'Platform\Compliance' also admits 'Platform\Compliance\AnySubTeam'.
ALTER TABLE board_ado_sources
  ADD COLUMN intelligence_area_paths TEXT[] NOT NULL DEFAULT '{}';

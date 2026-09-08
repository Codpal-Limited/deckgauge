-- Per-board repository scope for engineering intelligence.
-- Empty array means ALL repositories in the project, so this is a no-op for
-- every existing board_ado_sources row.
ALTER TABLE board_ado_sources
  ADD COLUMN intelligence_repos TEXT[] NOT NULL DEFAULT '{}';

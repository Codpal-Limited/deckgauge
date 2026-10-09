// The JiraSyncConfig schemas (and the DEFAULT_STATUS_MAPPING / Field- and
// StatusMappingSchema they were built from) are gone with the legacy model and
// its `/sync-configs` routes (p9 cleanup, eb4ddc10); nothing imported them.

/** Legacy enum values for backwards compatibility with old sync configs. */
export const LEGACY_STATUS_LABELS: Record<string, string> = {
  NOT_STARTED: 'Not Started',
  IN_PROGRESS: 'In Progress',
  AT_RISK: 'At Risk',
  BLOCKED: 'Blocked',
  DONE: 'Done',
};

export const CURATED_JIRA_FIELDS = [
  { key: 'duedate', label: 'Due Date', columnType: 'DATE' as const },
  { key: 'priority', label: 'Priority', columnType: 'TEXT' as const },
  { key: 'labels', label: 'Labels', columnType: 'TEXT' as const },
  { key: 'customfield_10016', label: 'Story Points', columnType: 'NUMBER' as const },
  { key: 'sprint', label: 'Sprint', columnType: 'TEXT' as const },
  { key: 'fixVersions', label: 'Fix Version', columnType: 'TEXT' as const },
  { key: 'components', label: 'Component', columnType: 'TEXT' as const },
  { key: 'reporter', label: 'Reporter', columnType: 'PERSON' as const },
] as const;

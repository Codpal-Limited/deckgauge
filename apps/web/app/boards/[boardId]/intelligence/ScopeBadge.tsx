'use client';

import type { IntelligenceSchema } from '@deckgauge/shared';

interface Props {
  scope: IntelligenceSchema['scope'];
}

export function ScopeBadge({ scope }: Props) {
  const parts: string[] = [];
  if (scope.repos.length) parts.push(`${scope.repos.length} repos`);
  if (scope.jiraProjectKeys.length) parts.push(`${scope.jiraProjectKeys.length} jira projects`);
  if (scope.adoProjects.length) parts.push(`${scope.adoProjects.length} ado projects`);
  if (scope.gitlabProjectPaths.length)
    parts.push(`${scope.gitlabProjectPaths.length} gitlab projects`);
  if (scope.bitbucketRepoFullNames?.length)
    parts.push(`${scope.bitbucketRepoFullNames.length} bitbucket repos`);
  return <span className="text-xs text-slate-500">Scope: {parts.join(' · ') || '(none)'}</span>;
}

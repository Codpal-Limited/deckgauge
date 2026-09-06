'use client';

import { BoardRow, type VisibleColumns } from '@deckgauge/ui';
import { CostClassificationCell } from './CostClassificationCell';
import type {
  Project,
  ProjectStatus,
  BoardColumn,
  BoardOwner,
  BoardStatus,
} from '@deckgauge/shared';
import type { JiraSourceLinks } from '@deckgauge/shared';

export interface ProjectRowProps {
  project: Project;
  onEdit?: () => void;
  onDelete?: () => void;
  columns?: BoardColumn[];
  fieldValues?: Record<string, string>;
  onFieldChange?: (columnId: string, value: string) => void;
  onNameChange?: (name: string) => void;
  onOwnerChange?: (owner: string) => void;
  ownerOptions?: string[];
  /** Field keys whose value a manual edit has taken over from sync. */
  overriddenFields?: string[];
  /** What each overridden field held before its first manual edit. */
  preOverrideValues?: Record<string, unknown> | null;
  onRevertField?: (fieldKey: string) => void;
  onStatusChange?: (status: ProjectStatus) => void;
  onStatusIdChange?: (statusId: string) => void;
  onOwnerIdChange?: (ownerId: string | null) => void;
  onDuplicate?: () => void;
  onMoveToGroup?: (groupId: string) => void;
  availableGroups?: { id: string; name: string }[];
  selected?: boolean;
  onSelect?: (selected: boolean) => void;
  onExpand?: () => void;
  commentCount?: number;
  jiraLinks?: JiraSourceLinks;
  hasGitHubIntegration?: boolean;
  adoOrgUrls?: Record<string, string>;
  hasAdoIntegration?: boolean;
  boardOwners?: BoardOwner[];
  boardStatuses?: BoardStatus[];
  onManageStatuses?: () => void;
  isFocused?: boolean;
  focusedCell?: number | null;
  isKbSelected?: boolean;
  onCellKeyDown?: (cellIndex: number, e: React.KeyboardEvent) => void;
  groupColor?: string;
  startDate?: Date | null;
  endDate?: Date | null;
  dueDate?: Date | null;
  durationCode?: string | null;
  onSystemFieldChange?: (field: 'startDate' | 'endDate' | 'dueDate' | 'durationCode', value: string) => void;
  onCostClassificationChange?: (value: 'CAPEX' | 'OPEX' | null) => void;
  // The real type from @deckgauge/ui, not a re-declaration. This was an inline
  // copy that made every field optional, so it could not be forwarded to
  // BoardRow, whose VisibleColumns requires name/owner/status/description/
  // updated — the five BoardRow defaults when the prop is absent entirely.
  // GroupList's `boardVisibleColumns`, the only thing that ever populates it,
  // supplies all five.
  visibleColumns?: VisibleColumns;
}

export function ProjectRow({
  project,
  onEdit,
  onDelete,
  columns,
  fieldValues,
  onFieldChange,
  onNameChange,
  onOwnerChange,
  ownerOptions,
  overriddenFields,
  preOverrideValues,
  onRevertField,
  onStatusChange,
  onStatusIdChange,
  onOwnerIdChange,
  onDuplicate,
  onMoveToGroup,
  availableGroups,
  selected,
  onSelect,
  onExpand,
  commentCount,
  jiraLinks,
  hasGitHubIntegration,
  adoOrgUrls,
  hasAdoIntegration,
  boardOwners,
  boardStatuses,
  onManageStatuses,
  isFocused,
  focusedCell,
  isKbSelected,
  onCellKeyDown,
  groupColor,
  startDate,
  endDate,
  dueDate,
  durationCode,
  onSystemFieldChange,
  onCostClassificationChange,
  visibleColumns,
}: ProjectRowProps) {
  return (
    <BoardRow
      id={project.id}
      name={project.name}
      owner={project.owner}
      ownerId={project.ownerId}
      assignee={project.assignee}
      ownerOptions={ownerOptions}
      overriddenFields={overriddenFields}
      preOverrideValues={preOverrideValues}
      onRevertField={onRevertField}
      status={project.status}
      statusId={project.statusId}
      description={project.description ?? undefined}
      updatedAt={project.updatedAt}
      jiraKey={project.jiraKey}
      // `jiraProjectKey` is deliberately NOT passed: it is not on the Project
      // contract. The Prisma model has the column (schema.prisma:332), but
      // `mapToProject` serialises through `ProjectSchema`, which does not
      // declare it — and z.object() strips unknown keys, so the value never
      // reaches the client. Passing `project.jiraProjectKey` was therefore
      // always `undefined`, which makes `resolveJiraBrowseUrl` fall through to
      // `links.fallback`; `links.byProjectKey` is consequently dead for board
      // rows. Enabling the per-project mapping is a one-line addition to
      // ProjectSchema, but it CHANGES which URL a row opens, so it is a product
      // decision rather than part of a type cleanup.
      jiraLinks={jiraLinks}
      githubIssueId={project.githubIssueId}
      githubRepoFullName={project.githubRepoFullName}
      hasGitHubIntegration={hasGitHubIntegration}
      adoWorkItemId={project.adoWorkItemId}
      adoProject={project.adoProject}
      adoOrgUrls={adoOrgUrls}
      hasAdoIntegration={hasAdoIntegration}
      onEdit={onEdit}
      onDelete={onDelete}
      onConfirmDelete={onDelete}
      columns={columns}
      fieldValues={fieldValues}
      onFieldChange={onFieldChange}
      onOwnerChange={onOwnerChange}
      onOwnerIdChange={onOwnerIdChange}
      onNameChange={onNameChange}
      onStatusChange={onStatusChange}
      onStatusIdChange={onStatusIdChange}
      onDuplicate={onDuplicate}
      onMoveToGroup={onMoveToGroup}
      availableGroups={availableGroups}
      selected={selected}
      onSelect={onSelect}
      onExpand={onExpand}
      commentCount={commentCount}
      boardOwners={boardOwners}
      boardStatuses={boardStatuses}
      onManageStatuses={onManageStatuses}
      isFocused={isFocused}
      focusedCell={focusedCell}
      isKbSelected={isKbSelected}
      onCellKeyDown={onCellKeyDown}
      groupColor={groupColor}
      startDate={startDate}
      endDate={endDate}
      dueDate={dueDate}
      durationCode={durationCode}
      onSystemFieldChange={onSystemFieldChange}
      visibleColumns={visibleColumns}
      extraSystemCell={
        project.boardId && visibleColumns?.classification !== false ? (
          <CostClassificationCell
            projectId={project.id}
            boardId={project.boardId}
            value={project.costClassification ?? null}
            onChange={onCostClassificationChange}
          />
        ) : undefined
      }
    />
  );
}

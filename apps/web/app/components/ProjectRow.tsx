'use client';

import { BoardRow } from '@deckgauge/ui';
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
  visibleColumns?: {
    name?: boolean;
    owner?: boolean;
    assignee?: boolean;
    status?: boolean;
    description?: boolean;
    updated?: boolean;
    startDate?: boolean;
    endDate?: boolean;
    dueDate?: boolean;
    duration?: boolean;
    source?: boolean;
    classification?: boolean;
  };
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
      jiraProjectKey={project.jiraProjectKey}
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

'use client';

import { useState, useRef, useEffect, useMemo } from 'react';
import type { ProjectStatus, BoardColumn, BoardOwner, BoardStatus } from '@deckgauge/shared';
import { resolveJiraBrowseUrl, hasAnyJiraLink, type JiraSourceLinks } from '@deckgauge/shared';
import { RelativeTime } from './RelativeTime';
import { StatusPill } from './StatusPill';
import { DynamicStatusPill } from './DynamicStatusPill';
import { OwnerAvatar } from './OwnerAvatar';
import { OwnerSelect } from './OwnerSelect';
import { OverrideBadge } from './OverrideBadge';
import { CommentBadge } from './CommentBadge';
import type { VisibleColumns } from './ColumnToggle';
import { CustomColumnCell } from './CustomColumnCell';
import { JiraKeyBadge } from './JiraKeyBadge';
import { GitHubIssueBadge } from './GitHubIssueBadge';
import { AdoWorkItemBadge } from './AdoWorkItemBadge';
import { getRowClasses } from './hooks/useFocusIndicator';

const STATUS_OPTIONS: ProjectStatus[] = [
  'NOT_STARTED',
  'IN_PROGRESS',
  'AT_RISK',
  'BLOCKED',
  'DONE',
];

interface BoardRowProps {
  id?: string;
  name: string;
  owner?: string;
  ownerId?: string | null;
  /** Synced source person (read-only Assignee column). */
  assignee?: string;
  /** Distinct owner/assignee values on the board, for the Owner combobox. */
  ownerOptions?: string[];
  /** Field keys a human has edited; each renders a revert affordance. */
  overriddenFields?: string[];
  /** Pre-edit synced value per dirty key — what the popover offers to restore. */
  preOverrideValues?: Record<string, unknown> | null;
  /** Re-link one field to its sync source. */
  onRevertField?: (fieldKey: string) => void;
  status: ProjectStatus;
  statusId?: string | null;
  description?: string;
  updatedAt?: Date | string;
  onEdit?: () => void;
  onDelete?: () => void;
  onConfirmDelete?: () => void;
  visibleColumns?: VisibleColumns;
  onOwnerChange?: (newOwner: string) => void;
  onOwnerIdChange?: (ownerId: string | null) => void;
  onNameChange?: (newName: string) => void;
  onStatusChange?: (newStatus: ProjectStatus) => void;
  onStatusIdChange?: (statusId: string) => void;
  onDuplicate?: () => void;
  onMoveToGroup?: (groupId: string) => void;
  availableGroups?: { id: string; name: string }[];
  columns?: BoardColumn[];
  fieldValues?: Record<string, string>;
  onFieldChange?: (columnId: string, value: string) => void;
  startDate?: string | Date | null;
  endDate?: string | Date | null;
  dueDate?: string | Date | null;
  durationCode?: string | null;
  onSystemFieldChange?: (field: 'startDate' | 'endDate' | 'dueDate' | 'durationCode', value: string) => void;
  commentCount?: number;
  selected?: boolean;
  onSelect?: (selected: boolean) => void;
  onExpand?: () => void;
  jiraKey?: string | null;
  /** The row's own Jira project, used to pick its site out of `jiraLinks`. */
  jiraProjectKey?: string | null;
  jiraLinks?: JiraSourceLinks;
  githubIssueId?: string | null;
  githubRepoFullName?: string | null;
  hasGitHubIntegration?: boolean;
  adoWorkItemId?: number | null;
  adoProject?: string | null;
  /** Keyed by ADO project name — a board can source work items from multiple ADO orgs. */
  adoOrgUrls?: Record<string, string>;
  hasAdoIntegration?: boolean;
  boardOwners?: BoardOwner[];
  boardStatuses?: BoardStatus[];
  onManageStatuses?: () => void;
  // Keyboard navigation
  isFocused?: boolean;
  focusedCell?: number | null;
  isKbSelected?: boolean;
  onCellKeyDown?: (cellIndex: number, e: React.KeyboardEvent) => void;
  groupColor?: string;
  /** Optional extra system-field cell rendered just before the action menu. */
  extraSystemCell?: React.ReactNode;
}

function toDateInputValue(v: string | Date | null | undefined): string {
  if (!v) return '';
  return new Date(v).toISOString().slice(0, 10);
}

/** Formats a snapshot value for the badge popover. */
function snapshotLabel(value: unknown): string {
  if (value == null || value === '') return '';
  // Date-shaped snapshots are stored as ISO strings by the API.
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    }
  }
  return String(value);
}

export function BoardRow({
  id,
  name,
  owner,
  ownerId,
  assignee,
  ownerOptions,
  overriddenFields,
  preOverrideValues,
  onRevertField,
  status,
  statusId,
  description,
  updatedAt,
  onEdit,
  onDelete,
  onConfirmDelete,
  visibleColumns = {
    name: true,
    owner: true,
    status: true,
    description: false,
    updated: true,
  },
  onOwnerChange,
  onOwnerIdChange,
  onNameChange,
  onStatusChange,
  onStatusIdChange,
  onDuplicate,
  onMoveToGroup,
  availableGroups,
  columns,
  fieldValues,
  onFieldChange,
  startDate,
  endDate,
  dueDate,
  durationCode,
  onSystemFieldChange,
  commentCount,
  selected,
  onSelect,
  onExpand,
  jiraKey,
  jiraProjectKey,
  jiraLinks,
  githubIssueId,
  githubRepoFullName,
  hasGitHubIntegration,
  adoWorkItemId,
  adoProject,
  adoOrgUrls,
  hasAdoIntegration,
  boardOwners,
  boardStatuses,
  onManageStatuses,
  isFocused = false,
  focusedCell: _focusedCell = null,
  isKbSelected = false,
  onCellKeyDown: _onCellKeyDown,
  groupColor = '#6C6CFF',
  extraSystemCell,
}: BoardRowProps) {
  const [isDeleting, setIsDeleting] = useState(false);
  const [isEditingOwner, setIsEditingOwner] = useState(false);
  const [ownerSearch, setOwnerSearch] = useState('');
  const [isEditingName, setIsEditingName] = useState(false);
  const [nameValue, setNameValue] = useState(name);
  const [showStatusDropdown, setShowStatusDropdown] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [showMoveSubmenu, setShowMoveSubmenu] = useState(false);
  const [editingFieldId, setEditingFieldId] = useState<string | null>(null);
  const [fieldInputValue, setFieldInputValue] = useState('');
  const nameInputRef = useRef<HTMLInputElement>(null);
  const ownerSearchRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const statusRef = useRef<HTMLDivElement>(null);
  const ownerRef = useRef<HTMLDivElement>(null);

  const useDynamicOwners = boardOwners && boardOwners.length > 0;
  const useDynamicStatuses = boardStatuses && boardStatuses.length > 0;

  const dirty = new Set(overriddenFields ?? []);
  const renderBadge = (fieldKey: string, label: string) =>
    dirty.has(fieldKey) && onRevertField ? (
      <OverrideBadge
        label={label}
        syncedValueLabel={snapshotLabel((preOverrideValues ?? {})[fieldKey])}
        onRevert={() => onRevertField(fieldKey)}
      />
    ) : null;

  const currentOwner = useMemo(() => {
    if (!useDynamicOwners || !ownerId) return null;
    return boardOwners.find((o) => o.id === ownerId) ?? null;
  }, [useDynamicOwners, ownerId, boardOwners]);

  const currentBoardStatus = useMemo(() => {
    if (!useDynamicStatuses || !statusId) return null;
    return boardStatuses.find((s) => s.id === statusId) ?? null;
  }, [useDynamicStatuses, statusId, boardStatuses]);

  const filteredOwners = useMemo(() => {
    if (!useDynamicOwners) return [];
    if (!ownerSearch) return boardOwners;
    const q = ownerSearch.toLowerCase();
    return boardOwners.filter((o) => o.name.toLowerCase().includes(q));
  }, [useDynamicOwners, boardOwners, ownerSearch]);

  const isBlocked = status === 'BLOCKED';
  // Translucent tint (not the fixed-light bg-red-50) so it reads as a subtle red wash
  // over the row in both light and dark themes instead of a glaring light band in dark.
  const blockedClass = isBlocked ? 'bg-red-500/10' : '';

  useEffect(() => {
    setNameValue(name);
  }, [name]);

  useEffect(() => {
    if (isEditingName) nameInputRef.current?.select();
  }, [isEditingName]);

  useEffect(() => {
    if (isEditingOwner && useDynamicOwners) ownerSearchRef.current?.focus();
  }, [isEditingOwner, useDynamicOwners]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false);
        setShowMoveSubmenu(false);
      }
      if (statusRef.current && !statusRef.current.contains(e.target as Node)) {
        setShowStatusDropdown(false);
      }
      if (ownerRef.current && !ownerRef.current.contains(e.target as Node)) {
        setIsEditingOwner(false);
        setOwnerSearch('');
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const handleNameSave = () => {
    const trimmed = nameValue.trim();
    if (trimmed && trimmed !== name) {
      onNameChange?.(trimmed);
    } else {
      setNameValue(name);
    }
    setIsEditingName(false);
  };

  const handleFieldEdit = (columnId: string, value: string) => {
    setEditingFieldId(columnId);
    setFieldInputValue(value);
  };

  const handleFieldSave = (columnId: string, explicitValue?: string) => {
    onFieldChange?.(columnId, explicitValue ?? fieldInputValue);
    setEditingFieldId(null);
    setFieldInputValue('');
  };

  const handleFieldCancel = () => {
    setEditingFieldId(null);
    setFieldInputValue('');
  };

  if (isDeleting) {
    return (
      <div
        className="grid items-center border-b border-slate-200 bg-red-500/10 transition-colors"
        style={{ gridTemplateColumns: 'var(--board-grid-cols)' }}
        data-row-id={id}
      >
        <div className="h-full bg-red-400" />
        <div
          style={{ gridColumn: '2 / -1' }}
          className="flex items-center justify-between px-4 py-2.5"
        >
          <span className="text-sm text-slate-600">
            Delete <span className="font-semibold text-slate-800">&quot;{name}&quot;</span>?
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setIsDeleting(false)}
              className="btn-ghost text-xs"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => onConfirmDelete?.()}
              className="rounded-lg bg-red-500/20 border border-red-500/30 px-3 py-1.5 text-xs text-red-600 hover:bg-red-500/30 transition-colors"
            >
              Delete
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Backgrounds for the pinned Item block (stripe/checkbox/name) so columns
  // scrolling underneath don't show through. Mirrors the row's own hover/select
  // states since the sticky cells sit above the row background.
  // Sticky cells must be OPAQUE (columns scroll underneath), so they use the themed
  // surface (bg-white → dark surface in dark mode) rather than the fixed-light
  // bg-indigo-50 that glared in dark. Selection is still shown by the row's
  // translucent indigo tint + border on the scrollable cells.
  const stickyBg = 'bg-white group-hover:bg-slate-50';

  return (
    <div
      className={`group grid items-center border-b border-slate-100 transition-all duration-150 hover:bg-slate-50 ${blockedClass} ${selected ? 'bg-indigo-500/10 border-indigo-500/30' : ''} ${getRowClasses({ isFocused, isSelected: isKbSelected })}`}
      style={{ gridTemplateColumns: 'var(--board-grid-cols)' }}
      tabIndex={isFocused ? 0 : -1}
      data-row-id={id}
    >
      {/* Left color stripe (pinned) */}
      <div className="sticky left-0 z-10 h-full" style={{ backgroundColor: groupColor }} />

      {/* Selection checkbox (pinned) */}
      <div
        className={`sticky z-10 ${stickyBg} flex items-center justify-center px-1 py-2 border-r border-slate-100`}
        style={{ left: 6 }}
      >
        {onSelect ? (
          <input
            type="checkbox"
            checked={selected || false}
            onChange={(e) => onSelect(e.target.checked)}
            className="h-4 w-4 rounded border-white/20 bg-white/5 text-indigo-500 focus:ring-indigo-500/20"
          />
        ) : (
          <div className="h-4 w-4" />
        )}
      </div>

      {/* Name column — draggable like the rest of the row. The pointer sensor's
          5px activation distance separates a click (opens the inline editor) from a
          drag (reorders the row), and the edit <input> is itself in the drag-block
          selector so clicking into it never starts a drag. */}
      {visibleColumns.name && (
        <div
          className={`sticky z-10 ${stickyBg} px-3 py-2 border-r border-slate-100 min-w-0`}
          style={{ left: 34 }}
        >
          {isEditingName ? (
            <input
              ref={nameInputRef}
              type="text"
              value={nameValue}
              onChange={(e) => setNameValue(e.target.value)}
              onBlur={handleNameSave}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleNameSave();
                if (e.key === 'Escape') {
                  setNameValue(name);
                  setIsEditingName(false);
                }
              }}
              className="w-full text-sm font-medium text-slate-800 bg-white border border-indigo-500 rounded-md px-1.5 py-0.5 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
            />
          ) : (
            <div className="flex items-center gap-2">
              <p
                className={`truncate text-sm font-medium text-slate-700 ${onNameChange ? 'cursor-pointer hover:text-indigo-500 rounded px-1 py-0.5 transition-colors' : ''}`}
                onClick={() => onNameChange && setIsEditingName(true)}
              >
                {name}
              </p>
              {commentCount !== undefined && (
                <CommentBadge count={commentCount} onClick={onExpand} />
              )}
            </div>
          )}
          {visibleColumns.description && description && (
            <p className="truncate text-xs text-slate-500">{description}</p>
          )}
        </div>
      )}

      {/* Owner column */}
      {visibleColumns.owner && (
        <div className="px-2 py-2 border-r border-slate-100 relative" ref={ownerRef}>
          {useDynamicOwners ? (
            <>
              <div
                onClick={() =>
                  (onOwnerIdChange || onOwnerChange) && setIsEditingOwner(!isEditingOwner)
                }
                className={`flex items-center justify-center gap-1.5 truncate text-xs ${onOwnerIdChange || onOwnerChange ? 'cursor-pointer hover:bg-slate-50 rounded px-1 py-1 transition-colors' : 'px-1 py-1'}`}
              >
                {currentOwner ? (
                  <>
                    <OwnerAvatar name={currentOwner.name} color={currentOwner.color} size={22} />
                    <span className="truncate text-slate-600">{currentOwner.name}</span>
                  </>
                ) : (
                  <span className="text-slate-400">{'\u2014'}</span>
                )}
              </div>
              {isEditingOwner && (
                <div className="dropdown-menu top-8 left-0 w-48 max-h-60 overflow-y-auto">
                  {boardOwners.length > 5 && (
                    <div className="px-2 pb-1">
                      <input
                        ref={ownerSearchRef}
                        type="text"
                        value={ownerSearch}
                        onChange={(e) => setOwnerSearch(e.target.value)}
                        placeholder="Search owners..."
                        className="w-full rounded-md bg-slate-50 border border-slate-200 px-2 py-1 text-xs text-slate-700 focus:outline-none focus:ring-1 focus:ring-indigo-500/30"
                      />
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      onOwnerIdChange?.(null);
                      onOwnerChange?.('');
                      setIsEditingOwner(false);
                      setOwnerSearch('');
                    }}
                    className={`w-full text-left px-3 py-1.5 text-xs transition-colors hover:bg-slate-50 text-slate-400 ${!ownerId ? 'bg-blue-50/50' : ''}`}
                  >
                    Unassigned
                  </button>
                  {filteredOwners.map((o) => (
                    <button
                      key={o.id}
                      type="button"
                      onClick={() => {
                        onOwnerIdChange?.(o.id);
                        onOwnerChange?.(o.name);
                        setIsEditingOwner(false);
                        setOwnerSearch('');
                      }}
                      className={`w-full text-left px-3 py-1.5 text-xs transition-colors hover:bg-slate-50 flex items-center gap-2 ${o.id === ownerId ? 'bg-blue-50/50' : ''}`}
                    >
                      <OwnerAvatar name={o.name} color={o.color} size={20} />
                      <span className="truncate">{o.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </>
          ) : onOwnerChange ? (
            <div className="flex items-center gap-1">
              <OwnerSelect
                value={owner || ''}
                options={ownerOptions ?? []}
                onChange={onOwnerChange}
              />
              {renderBadge('owner', 'Owner')}
            </div>
          ) : (
            <div className="truncate text-xs text-slate-400 text-center">
              {owner || '\u2014'}
            </div>
          )}
        </div>
      )}

      {/* Assignee column (read-only synced source person) */}
      {visibleColumns.assignee && (
        <div className="px-2 py-2 border-r border-slate-100">
          <div className="truncate text-xs text-slate-500 text-center" title={assignee || undefined}>
            {assignee || '\u2014'}
          </div>
        </div>
      )}

      {/* Status column */}
      {visibleColumns.status && (
        <div className="px-1 py-1 border-r border-slate-100 relative" ref={statusRef}>
          <div
            className={onStatusChange || onStatusIdChange ? 'cursor-pointer' : ''}
            onClick={() =>
              (onStatusChange || onStatusIdChange) && setShowStatusDropdown(!showStatusDropdown)
            }
          >
            {useDynamicStatuses && currentBoardStatus ? (
              <DynamicStatusPill
                label={currentBoardStatus.label}
                color={currentBoardStatus.color}
                icon={currentBoardStatus.icon}
              />
            ) : (
              <StatusPill status={status} />
            )}
          </div>
          {showStatusDropdown && (
            <div className="dropdown-menu top-8 left-0 w-44">
              {useDynamicStatuses ? (
                <>
                  {boardStatuses.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => {
                        onStatusIdChange?.(s.id);
                        setShowStatusDropdown(false);
                      }}
                      className={`w-full text-left px-3 py-1.5 text-sm transition-colors hover:bg-slate-50 ${s.id === statusId ? 'bg-blue-50/50' : ''}`}
                    >
                      <DynamicStatusPill label={s.label} color={s.color} icon={s.icon} />
                    </button>
                  ))}
                  {onManageStatuses && (
                    <>
                      <div className="border-t border-slate-200 my-1" />
                      <button
                        type="button"
                        onClick={() => {
                          onManageStatuses();
                          setShowStatusDropdown(false);
                        }}
                        className="w-full text-left px-3 py-1.5 text-xs text-indigo-500 hover:bg-indigo-50 transition-colors"
                      >
                        Manage statuses...
                      </button>
                    </>
                  )}
                </>
              ) : (
                STATUS_OPTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => {
                      onStatusChange?.(s);
                      setShowStatusDropdown(false);
                    }}
                    className={`w-full text-left px-3 py-1.5 text-sm transition-colors hover:bg-slate-50 ${s === status ? 'bg-blue-50/50' : ''}`}
                  >
                    <StatusPill status={s} />
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      )}

      {/* Custom columns */}
      {columns?.map((col) => (
        <div key={col.id} className="px-2 py-2 border-r border-slate-100">
          <CustomColumnCell
            column={col}
            value={fieldValues?.[col.id] || ''}
            isEditing={editingFieldId === col.id}
            onEdit={() => handleFieldEdit(col.id, fieldValues?.[col.id] || '')}
            onSave={(v) => handleFieldSave(col.id, v)}
            onCancel={handleFieldCancel}
            fieldInputValue={fieldInputValue}
            onFieldInputChange={(value) => setFieldInputValue(value)}
          />
        </div>
      ))}

      {visibleColumns.startDate && (
        <div className="px-2 py-2 border-r border-slate-100 flex items-center justify-center">
          <input
            type="date"
            value={toDateInputValue(startDate)}
            disabled={!onSystemFieldChange}
            onChange={(e) => onSystemFieldChange?.('startDate', e.target.value)}
            className="w-full bg-transparent text-xs text-slate-600 outline-none"
            aria-label="Start date"
          />
        </div>
      )}
      {visibleColumns.endDate && (
        <div className="px-2 py-2 border-r border-slate-100 flex items-center justify-center">
          <input
            type="date"
            value={toDateInputValue(endDate)}
            disabled={!onSystemFieldChange}
            onChange={(e) => onSystemFieldChange?.('endDate', e.target.value)}
            className="w-full bg-transparent text-xs text-slate-600 outline-none"
            aria-label="End date"
          />
        </div>
      )}
      {visibleColumns.dueDate && (
        <div className="px-2 py-2 border-r border-slate-100 flex items-center justify-center gap-1">
          <input
            type="date"
            value={toDateInputValue(dueDate)}
            disabled={!onSystemFieldChange}
            onChange={(e) => onSystemFieldChange?.('dueDate', e.target.value)}
            className="w-full bg-transparent text-xs text-slate-600 outline-none"
            aria-label="Due date"
          />
          {renderBadge('dueDate', 'Due date')}
        </div>
      )}
      {visibleColumns.duration && (
        <div className="px-2 py-2 border-r border-slate-100 flex items-center justify-center">
          <input
            type="text"
            defaultValue={durationCode ?? ''}
            disabled={!onSystemFieldChange}
            onBlur={(e) => onSystemFieldChange?.('durationCode', e.target.value.trim())}
            placeholder="e.g. 2w"
            className="w-full bg-transparent text-xs text-slate-600 outline-none text-center"
            aria-label="Duration"
          />
        </div>
      )}

      {/* Source Link column */}
      {visibleColumns.source !== false &&
        (hasAnyJiraLink(jiraLinks) || hasGitHubIntegration || hasAdoIntegration) && (
        <div className="px-2 py-2 border-r border-slate-100 flex items-center justify-center">
          {jiraKey && resolveJiraBrowseUrl(jiraLinks, jiraProjectKey) ? (
            <JiraKeyBadge
              jiraKey={jiraKey}
              atlassianUrl={resolveJiraBrowseUrl(jiraLinks, jiraProjectKey)!}
            />
          ) : githubIssueId && githubRepoFullName ? (
            <GitHubIssueBadge
              githubIssueId={githubIssueId}
              githubRepoFullName={githubRepoFullName}
            />
          ) : adoWorkItemId && adoProject && adoOrgUrls?.[adoProject] ? (
            <AdoWorkItemBadge
              workItemId={adoWorkItemId}
              project={adoProject}
              orgUrl={adoOrgUrls[adoProject]}
            />
          ) : (
            <span className="text-xs text-slate-400">{'\u2014'}</span>
          )}
        </div>
      )}

      {/* Updated column */}
      {visibleColumns.updated && (
        <div className="px-2 py-2 border-r border-slate-100 text-xs text-slate-500 tabular-nums text-center">
          {updatedAt ? <RelativeTime date={updatedAt} /> : '\u2014'}
        </div>
      )}

      {/* Extra system-field cell (e.g. CapEx/OpEx classification) */}
      {extraSystemCell != null && (
        <div className="px-2 py-2 border-r border-slate-100 flex items-center justify-center">
          {extraSystemCell}
        </div>
      )}

      {/* Action menu cell */}
      <div className="flex items-center justify-center px-1 py-2">
        {onExpand && (
          <button
            type="button"
            onClick={onExpand}
            className="opacity-0 group-hover:opacity-100 transition-opacity text-xs text-slate-500 hover:text-indigo-500"
            aria-label="Expand item details"
          >
            {'\u2922'}
          </button>
        )}
        {(onEdit || onDelete || onDuplicate || onMoveToGroup) && (
          <div className="relative" ref={menuRef}>
            <button
              type="button"
              onClick={() => setShowMenu(!showMenu)}
              className="opacity-0 group-hover:opacity-100 transition-opacity text-slate-500 hover:text-slate-600 px-1"
              aria-label="Item actions"
            >
              {'\u22EE'}
            </button>
            {showMenu && (
              <div className="dropdown-menu right-0 top-6 w-44">
                {onEdit && (
                  <button
                    type="button"
                    onClick={() => {
                      onEdit();
                      setShowMenu(false);
                    }}
                    className="dropdown-item"
                  >
                    Edit details
                  </button>
                )}
                {onDuplicate && (
                  <button
                    type="button"
                    onClick={() => {
                      onDuplicate();
                      setShowMenu(false);
                    }}
                    className="dropdown-item"
                  >
                    Duplicate
                  </button>
                )}
                {onMoveToGroup && availableGroups && availableGroups.length > 0 && (
                  <div
                    className="relative"
                    onMouseEnter={() => setShowMoveSubmenu(true)}
                    onMouseLeave={() => setShowMoveSubmenu(false)}
                  >
                    <button type="button" className="dropdown-item flex justify-between">
                      Move to group <span>{'\u25B8'}</span>
                    </button>
                    {showMoveSubmenu && (
                      <div className="dropdown-menu left-full top-0 w-40">
                        {availableGroups?.map((g) => (
                          <button
                            key={g.id}
                            type="button"
                            onClick={() => {
                              onMoveToGroup(g.id);
                              setShowMenu(false);
                              setShowMoveSubmenu(false);
                            }}
                            className="dropdown-item"
                          >
                            {g.name}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {onDelete && (
                  <>
                    <div className="border-t border-slate-200 my-1" />
                    <button
                      type="button"
                      onClick={() => {
                        setIsDeleting(true);
                        setShowMenu(false);
                      }}
                      className="dropdown-item-danger"
                    >
                      Delete
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

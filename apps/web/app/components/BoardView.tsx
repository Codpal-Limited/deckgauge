"use client";

import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { toast } from "sonner";
import type { AccessEntry, Group, Project, BoardColumn, BoardOwner, BoardStatus } from "@deckgauge/shared";
import { canEditEntity } from "@deckgauge/shared";
import { KeyboardNavProvider, ShortcutHelpPanel } from "@deckgauge/ui";
import type { SortConfig } from "../utils/sort-projects";
import { BoardToolbar } from "./BoardToolbar";
import type { SearchBarHandle } from "./SearchBar";
import { BoardHeader } from "./BoardHeader";
import { SyncControls } from "./SyncControls";
import { BoardSharePill } from "./board-header/BoardSharePill";
import { AskAdvisorButton } from "../../components/advisor/AskAdvisorButton";
import { GroupList } from "./GroupList";
import { ProjectModal } from "./ProjectModal";
import { GitHubGroupSection } from "./GitHubGroupSection";
import { BoardColumnsPanel } from "./BoardColumnsPanel";
import { ColumnManager } from "./ColumnManager";
import { setBoardColumnLayout } from "../actions/roadmap";
import { deleteColumn } from "../actions/projects";
import { ColumnLayoutSchema, isSystemColumnVisible, type ColumnLayout } from "@deckgauge/shared";
import { hasAnyJiraLink, type JiraSourceLinks } from "@deckgauge/shared";

const DEFAULT_HIDDEN_SYSTEM_FIELDS = ["startDate", "endDate", "duration"];

interface BoardViewProps {
  board: {
    id: string;
    name: string;
    description?: string | null;
    hiddenSystemFields?: string[];
    columnLayout?: ColumnLayout | null;
    kind?: string;
  } | null;
  groups: (Group & { projects: (Project & { fieldValues?: Record<string, string> })[] })[];
  columns: BoardColumn[];
  boardId: string;
  jiraLinks?: JiraSourceLinks;
  hasGitHubIntegration?: boolean;
  adoOrgUrls?: Record<string, string>;
  hasAdoIntegration?: boolean;
  commentCounts?: Record<string, number>;
  boardOwners?: BoardOwner[];
  boardStatuses?: BoardStatus[];
  userRole?: 'OWNER' | 'EDITOR' | 'VIEWER' | null;
  currentUserId?: string | null;
  boardAccess?: AccessEntry[];
  onProjectDeleted?: (projectId: string) => void;
  /**
   * Open one item — and optionally one comment inside it — straight from the
   * URL, so a notification lands on what it is about. Threaded from
   * `page.tsx` search params down to `GroupList`, which owns the panel state.
   */
  deepLink?: { itemId: string; commentId?: string };

  onGroupsChange?: (
    groups: (Group & { projects: (Project & { fieldValues?: Record<string, string> })[] })[]
  ) => void;
}

export function BoardView({ board, groups, columns, boardId, jiraLinks, hasGitHubIntegration, adoOrgUrls, hasAdoIntegration, commentCounts, boardOwners, boardStatuses, userRole, currentUserId, boardAccess, onProjectDeleted, onGroupsChange, deepLink }: BoardViewProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [filterRules, setFilterRules] = useState<
    { column: string; condition: string; value: string }[]
  >([]);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [sortConfig, setSortConfig] = useState<SortConfig | null>(null);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [navItems, setNavItems] = useState<string[]>([]);
  // Seed the layout from the board's saved columnLayout, falling back to the
  // legacy hiddenSystemFields for boards that predate the layout column.
  const initialLayout = useMemo<ColumnLayout>(() => {
    const raw = board?.columnLayout;
    if (raw) {
      const parsed = ColumnLayoutSchema.safeParse(raw);
      if (parsed.success) return parsed.data;
    }
    return { hidden: board?.hiddenSystemFields ?? DEFAULT_HIDDEN_SYSTEM_FIELDS, widths: {} };
  }, [board]);

  const [layout, setLayout] = useState<ColumnLayout>(initialLayout);
  const [showColumnManager, setShowColumnManager] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>();
  const pendingSave = useRef<ColumnLayout | null>(null);

  const searchRef = useRef<SearchBarHandle>(null);

  const canToggleFields = canEditEntity(userRole ?? null);

  const hiddenSet = useMemo(() => new Set(layout.hidden), [layout.hidden]);

  // Owner/Status/Updated/Source/CapEx default visible (hidden only when listed);
  // Start/End/Duration default hidden. GroupList honors these booleans directly.
  const visibleSystemFields = useMemo(
    () => ({
      owner: !hiddenSet.has('owner'),
      assignee: isSystemColumnVisible('assignee', hiddenSet),
      status: !hiddenSet.has('status'),
      updated: !hiddenSet.has('updated'),
      source: !hiddenSet.has('source'),
      classification: !hiddenSet.has('classification'),
      startDate: !hiddenSet.has('startDate'),
      endDate: !hiddenSet.has('endDate'),
      dueDate: !hiddenSet.has('dueDate'),
      duration: !hiddenSet.has('duration'),
    }),
    [hiddenSet],
  );

  // Size lives in the `columns` array as a BoardColumn named 'Size'. Hiding it
  // means dropping that column before handing the array to GroupList.
  const visibleColumns = useMemo(
    () => (hiddenSet.has('size') ? columns.filter((c) => c.name !== 'Size') : columns),
    [columns, hiddenSet],
  );

  const toggleColumn = useCallback(
    (key: string) => {
      if (!canToggleFields) return;
      const hidden = new Set(layout.hidden);
      if (hidden.has(key)) hidden.delete(key);
      else hidden.add(key);
      const next: ColumnLayout = { ...layout, hidden: Array.from(hidden) };
      const previous = layout;
      setLayout(next); // optimistic
      void setBoardColumnLayout(boardId, next).then(({ ok }) => {
        if (!ok) {
          setLayout(previous);
          toast.error("Couldn't update columns");
        }
      });
    },
    [canToggleFields, layout, boardId],
  );

  // Live width update on every resize frame; the server write is debounced so a
  // drag produces one PATCH, not dozens.
  const handleColumnResize = useCallback(
    (key: string, width: number) => {
      if (!canToggleFields) return;
      setLayout((prev) => {
        const next: ColumnLayout = { ...prev, widths: { ...prev.widths, [key]: width } };
        pendingSave.current = next;
        return next;
      });
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        if (pendingSave.current) void setBoardColumnLayout(boardId, pendingSave.current);
      }, 500);
    },
    [canToggleFields, boardId],
  );

  useEffect(() => () => clearTimeout(saveTimer.current), []);

  const handleColumnSort = useCallback((column: string) => {
    setSortConfig((prev) => {
      if (prev?.column === column) {
        // Same column: asc → desc → clear
        if (prev.direction === "asc") return { column, direction: "desc" };
        return null;
      }
      return { column, direction: "asc" };
    });
  }, []);

  // Global `/` and `?` shortcuts
  useEffect(() => {
    const handleGlobalKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      if (
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement ||
        (el instanceof HTMLElement && el.isContentEditable)
      ) {
        return;
      }
      if (e.key === '/') {
        e.preventDefault();
        searchRef.current?.focus();
      }
      if (e.key === '?') {
        e.preventDefault();
        setShowShortcuts((prev) => !prev);
      }
    };
    document.addEventListener('keydown', handleGlobalKey);
    return () => document.removeEventListener('keydown', handleGlobalKey);
  }, []);

  return (
    <KeyboardNavProvider items={navItems} cellCount={3 + (visibleColumns?.length ?? 0)}>
      <div className="space-y-5">
        {/* Action bar: identity + freshness on the left, controls on the right */}
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            {board && <BoardHeader board={board} userRole={userRole} />}
            <div className="mt-1">
              <SyncControls boardId={boardId} userRole={userRole ?? null} />
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <BoardToolbar
              columns={columns}
              onSearch={setSearchQuery}
              onFilterChange={setFilterRules}
              sortConfig={sortConfig}
              onSortChange={setSortConfig}
              searchRef={searchRef}
              columnsControl={
                canToggleFields ? (
                  <BoardColumnsPanel
                    columns={columns}
                    hidden={layout.hidden}
                    hasIntegration={
                      (hasAnyJiraLink(jiraLinks) || hasGitHubIntegration || hasAdoIntegration)
                    }
                    onToggle={toggleColumn}
                    onAddColumn={() => setShowColumnManager(true)}
                    onDeleteColumn={(id) => void deleteColumn(id, boardId)}
                  />
                ) : undefined
              }
            />
            {board && <AskAdvisorButton boardId={board.id} variant="header" />}
            {board && (
              <BoardSharePill
                boardId={board.id}
                boardName={board.name}
                userRole={userRole}
                currentUserId={currentUserId}
                boardAccess={boardAccess}
              />
            )}
          </div>
        </div>

        {/* Board content */}
        <GroupList
          groups={groups}
          deepLink={deepLink}
          boardId={boardId}
          boardKind={board?.kind}
          columns={visibleColumns}
          visibleSystemFields={visibleSystemFields}
          columnWidths={layout.widths}
          onColumnResize={canToggleFields ? handleColumnResize : undefined}
          onProjectEdit={(project) => setEditingProject(project)}
          onProjectDelete={onProjectDeleted}
          searchQuery={searchQuery}
          filterRules={filterRules}
          sortConfig={sortConfig}
          onColumnSort={handleColumnSort}
          commentCounts={commentCounts}
          boardOwners={boardOwners}
          boardStatuses={boardStatuses}
          jiraLinks={jiraLinks}
          hasGitHubIntegration={hasGitHubIntegration}
          adoOrgUrls={adoOrgUrls || {}}
          hasAdoIntegration={hasAdoIntegration}
          userRole={userRole}
          onNavItemsChange={setNavItems}
          onGroupsChange={onGroupsChange}
        />

        {/* GitHub groups (read-only, below manual groups) */}
        <GitHubGroupSection searchQuery={searchQuery} />

        {/* Project edit modal */}
        {editingProject && (
          <ProjectModal
            project={editingProject}
            boardId={boardId}
            onClose={() => setEditingProject(null)}
          />
        )}

        {/* Add-column modal (opened from the Columns panel) */}
        {showColumnManager && (
          <ColumnManager
            boardId={boardId}
            onClose={() => setShowColumnManager(false)}
            onSuccess={() => setShowColumnManager(false)}
          />
        )}
      </div>

      <ShortcutHelpPanel
        isOpen={showShortcuts}
        onClose={() => setShowShortcuts(false)}
      />
    </KeyboardNavProvider>
  );
}

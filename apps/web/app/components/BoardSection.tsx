"use client";

import { useTransition } from "react";
import { useState } from "react";
import { BoardRow, GroupHeader, ColumnToggle, type VisibleColumns } from "@deckgauge/ui";
import type { Project } from "@deckgauge/shared";
import { useGroupCollapse } from "../hooks/useGroupCollapse";
import { ProjectModal } from "./ProjectModal";
import { deleteProject, updateProject } from "../actions/projects";

interface BoardSectionProps {
  projects: Project[];
}

export function BoardSection({ projects }: BoardSectionProps) {
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const { collapsed, toggle } = useGroupCollapse("my-projects");
  const [_isPending, startTransition] = useTransition();
  const [visibleColumns, setVisibleColumns] = useState<VisibleColumns>({
    name: true,
    owner: true,
    status: true,
    description: false,
    updated: true,
  });

  // Calculate status distribution
  const statusCounts: Record<Project["status"], number> = {
    NOT_STARTED: 0,
    IN_PROGRESS: 0,
    AT_RISK: 0,
    BLOCKED: 0,
    DONE: 0,
  };

  projects.forEach((project) => {
    statusCounts[project.status]++;
  });

  // Owner combobox autocompletes from owner/assignee values already on the board.
  const ownerOptions = Array.from(
    new Set(
      projects.flatMap((p) => [p.owner, p.assignee]).filter((v): v is string => !!v && v.trim() !== ''),
    ),
  ).sort((a, b) => a.localeCompare(b));

  const handleToggleColumn = (column: keyof VisibleColumns) => {
    setVisibleColumns((prev) => ({
      ...prev,
      [column]: !prev[column],
    }));
  };

  const handleOwnerChange = (projectId: string, newOwner: string) => {
    const project = projects.find((p) => p.id === projectId);
    const boardId = project?.boardId ?? undefined;
    startTransition(async () => {
      await updateProject(projectId, { owner: newOwner }, boardId);
    });
  };

  return (
    <>
      <div className="flex items-center justify-between">
        <GroupHeader
          title="My Projects"
          count={projects.length}
          collapsed={collapsed}
          onToggle={toggle}
          statusCounts={statusCounts}
        />
        <div className="flex items-center gap-2">
          <ColumnToggle
            visibleColumns={visibleColumns}
            onToggle={handleToggleColumn}
          />
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
          >
            New project
          </button>
        </div>
      </div>

      {!collapsed && (
        <>
          {projects.length === 0 ? (
            <div className="mt-8 flex flex-col items-center justify-center py-8">
              <svg
                className="mb-3 h-8 w-8 text-gray-400"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4"
                />
              </svg>
              <p className="text-center text-sm text-gray-400">
                Nothing here yet. Click '+ New project' to add your first project, or configure Jira in Settings.
              </p>
            </div>
          ) : (
            <div className="mt-2 flex flex-col gap-2">
              {projects.map((project) => (
                <BoardRow
                  key={project.id}
                  name={project.name}
                  owner={project.owner}
                  assignee={project.assignee}
                  overriddenFields={project.overriddenFields ?? []}
                  preOverrideValues={project.preOverrideValues ?? null}
                  ownerOptions={ownerOptions}
                  status={project.status}
                  description={project.description ?? undefined}
                  updatedAt={new Date(project.updatedAt)}
                  visibleColumns={visibleColumns}
                  onOwnerChange={(newOwner) =>
                    handleOwnerChange(project.id, newOwner)
                  }
                  onEdit={() => setEditingProject(project)}
                  onDelete={() => {}}
                  onConfirmDelete={() => {
                    startTransition(async () => {
                      await deleteProject(project.id, project.boardId ?? undefined);
                    });
                  }}
                />
              ))}
            </div>
          )}
        </>
      )}

      {(showCreate || editingProject) && (
        <ProjectModal
          project={editingProject ?? undefined}
          onClose={() => {
            setShowCreate(false);
            setEditingProject(null);
          }}
        />
      )}
    </>
  );
}

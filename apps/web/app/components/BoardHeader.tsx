"use client";

import { useState, useRef, useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { AccessRoleValue } from "@deckgauge/shared";
import { canEditEntity, canManageEntity } from "@deckgauge/shared";
import { updateBoard, deleteBoard } from "../actions/projects";
import { AutomationPanel } from "./AutomationPanel";
import { ToolbarMenu, type ToolbarMenuItem } from "./board-header/ToolbarMenu";
import { BoardDescriptionPopover } from "./board-header/BoardDescriptionPopover";
import { BoardDeleteDialog } from "./board-header/BoardDeleteDialog";
import { BellIcon, BoltIcon, PencilIcon, TextIcon, TrashIcon } from "./board-header/icons";
import { BoardNotifyDialog } from "./board-header/BoardNotifyDialog";

interface BoardHeaderProps {
  board: { id: string; name: string; description?: string | null };
  userRole?: AccessRoleValue | null;
}

/**
 * The board's identity block: its name, and the board-level actions behind one
 * menu.
 *
 * Rename, description, automations and delete used to sit in the action bar as
 * four separate affordances — a bare caret, a trash glyph, and two toolbar
 * buttons. They are all board configuration, they are all rare, and they now
 * live together behind the chevron next to the name. Click-to-rename on the
 * title is kept, because it is the fastest path and the one people already know.
 */
export function BoardHeader({ board, userRole }: BoardHeaderProps) {
  const router = useRouter();
  const [isEditingName, setIsEditingName] = useState(false);
  const [nameValue, setNameValue] = useState(board.name);
  const [showDescription, setShowDescription] = useState(false);
  const [descValue, setDescValue] = useState(board.description || "");
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showAutomations, setShowAutomations] = useState(false);
  const [showNotifyLevel, setShowNotifyLevel] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [descError, setDescError] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  // Match the server's own tiers (route-inventory.snapshot.json): renaming is
  // `PATCH /boards/:id` -> board(EDITOR); deleting is `DELETE /boards/:id` ->
  // board(OWNER). They are NOT the same tier — a viewer must not be offered
  // either, and an editor may rename but must not be offered delete.
  const canRenameBoard = canEditEntity(userRole ?? null);
  const canDeleteBoard = canManageEntity(userRole ?? null);

  useEffect(() => {
    if (isEditingName) nameInputRef.current?.select();
  }, [isEditingName]);

  const handleNameSave = () => {
    const trimmed = nameValue.trim();
    if (trimmed && trimmed !== board.name) {
      startTransition(async () => {
        await updateBoard(board.id, { name: trimmed });
      });
    } else {
      setNameValue(board.name);
    }
    setIsEditingName(false);
  };

  const handleDescSave = () => {
    if (descValue !== (board.description || "")) {
      setDescError(null);
      startTransition(async () => {
        try {
          await updateBoard(board.id, { description: descValue || null });
        } catch {
          setDescError("Failed to save description. Please try again.");
        }
      });
    }
  };

  const handleDelete = () => {
    setDeleteError(null);
    startTransition(async () => {
      try {
        await deleteBoard(board.id);
        router.push("/");
      } catch {
        setDeleteError("Failed to delete board. Please try again.");
      }
    });
  };

  // Built by permission, so the chevron disappears entirely for a role with no
  // board-level action available (ToolbarMenu renders nothing on an empty list).
  const menuItems: ToolbarMenuItem[] = [
    ...(canRenameBoard
      ? [
          {
            label: "Rename board",
            icon: <PencilIcon />,
            onSelect: () => setIsEditingName(true),
          },
        ]
      : []),
    {
      label: canRenameBoard ? "Edit description" : "View description",
      icon: <TextIcon />,
      onSelect: () => setShowDescription((prev) => !prev),
    },
    // Unconditional, unlike everything around it: silencing a board is a
    // PERSONAL setting, so a viewer needs it as much as an owner does.
    {
      label: "Notify me about",
      icon: <BellIcon />,
      onSelect: () => setShowNotifyLevel((prev) => !prev),
    },
    ...(canRenameBoard
      ? [
          {
            label: "Automations",
            icon: <BoltIcon />,
            onSelect: () => setShowAutomations(true),
          },
        ]
      : []),
    ...(canDeleteBoard
      ? [
          {
            label: "Delete board",
            icon: <TrashIcon />,
            danger: true,
            onSelect: () => setShowDeleteConfirm(true),
          },
        ]
      : []),
  ];

  return (
    <div className="relative flex min-w-0 items-center gap-1">
      {isEditingName ? (
        <input
          ref={nameInputRef}
          type="text"
          value={nameValue}
          onChange={(e) => setNameValue(e.target.value)}
          onBlur={handleNameSave}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleNameSave();
            if (e.key === "Escape") {
              setNameValue(board.name);
              setIsEditingName(false);
            }
          }}
          aria-label="Board name"
          className="min-w-0 rounded-lg border border-teal-500 bg-surface-1 px-2 py-0.5 text-xl font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-teal-500/20"
        />
      ) : canRenameBoard ? (
        <h1
          onClick={() => setIsEditingName(true)}
          title="Click to rename"
          className="cursor-text truncate text-xl font-semibold leading-tight text-slate-800 transition-colors hover:text-teal-600"
        >
          {board.name}
        </h1>
      ) : (
        <h1 className="truncate text-xl font-semibold leading-tight text-slate-800">
          {board.name}
        </h1>
      )}

      <ToolbarMenu label="Board actions" items={menuItems} />

      {showDescription && (
        <BoardDescriptionPopover
          value={descValue}
          description={board.description ?? null}
          canEdit={canRenameBoard}
          error={descError}
          onChange={setDescValue}
          onCommit={handleDescSave}
          onClose={() => setShowDescription(false)}
        />
      )}

      {showDeleteConfirm && canDeleteBoard && (
        <BoardDeleteDialog
          boardName={board.name}
          isPending={isPending}
          error={deleteError}
          onConfirm={handleDelete}
          onCancel={() => setShowDeleteConfirm(false)}
        />
      )}

      {showNotifyLevel && (
        <BoardNotifyDialog boardId={board.id} onClose={() => setShowNotifyLevel(false)} />
      )}

      {showAutomations && canRenameBoard && (
        <AutomationPanel boardId={board.id} onClose={() => setShowAutomations(false)} />
      )}
    </div>
  );
}

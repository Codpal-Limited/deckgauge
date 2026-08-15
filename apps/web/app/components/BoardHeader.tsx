"use client";

import { useState, useRef, useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateBoard, deleteBoard } from "../actions/projects";
import { ShareBoardModal } from "./ShareBoardModal";
import { AskAdvisorButton } from "../../components/advisor/AskAdvisorButton";

interface BoardAccessEntry {
  id: string;
  boardId: string;
  userId: string;
  role: "OWNER" | "EDITOR" | "VIEWER";
  user: { id: string; name: string; email: string; avatarUrl: string | null };
}

interface BoardHeaderProps {
  board: { id: string; name: string; description?: string | null };
  userRole?: "OWNER" | "EDITOR" | "VIEWER";
  currentUserId?: string;
  boardAccess?: BoardAccessEntry[];
}

export function BoardHeader({ board, userRole, currentUserId, boardAccess }: BoardHeaderProps) {
  const router = useRouter();
  const [isEditingName, setIsEditingName] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [nameValue, setNameValue] = useState(board.name);
  const [showDescription, setShowDescription] = useState(false);
  const [descValue, setDescValue] = useState(board.description || "");
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

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
      startTransition(async () => {
        await updateBoard(board.id, {
          description: descValue || null,
        });
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

  return (
    <div className="flex items-center gap-3">
      {/* Board name */}
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
          className="text-xl font-semibold text-slate-800 bg-white border border-indigo-500 rounded-lg px-3 py-1 focus:outline-none focus:ring-1 focus:ring-indigo-500/20"
        />
      ) : (
        <h1
          className="text-xl font-semibold text-slate-800 cursor-pointer hover:text-indigo-500 transition-colors"
          onClick={() => setIsEditingName(true)}
        >
          {board.name}
        </h1>
      )}

      {/* Description toggle */}
      <button
        type="button"
        onClick={() => setShowDescription(!showDescription)}
        className="text-slate-500 hover:text-slate-600 text-xs transition-colors"
        aria-label="Toggle description"
      >
        {showDescription ? "\u25B2" : "\u25BC"}
      </button>

      {/* Ask the Advisor */}
      <AskAdvisorButton boardId={board.id} variant="header" />

      {/* Share button */}
      {userRole === "OWNER" && (
        <button
          onClick={() => setShowShare(true)}
          className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"
        >
          Share
        </button>
      )}
      {showShare && currentUserId && (
        <ShareBoardModal
          boardId={board.id}
          currentUserId={currentUserId}
          initialAccess={boardAccess ?? []}
          onClose={() => setShowShare(false)}
        />
      )}

      {/* Delete button */}
      <div className="relative">
        {showDeleteConfirm ? (
          <div className="flex items-center gap-2 glass-elevated px-3 py-2 animate-fade-in">
            <span className="text-xs text-slate-400">
              Delete &quot;{board.name}&quot; and all its groups/items?
            </span>
            <button
              type="button"
              onClick={handleDelete}
              disabled={isPending}
              className="rounded-lg bg-red-50 border border-red-200 px-2 py-1 text-xs text-red-600 hover:bg-red-100"
            >
              Delete
            </button>
            <button
              type="button"
              onClick={() => setShowDeleteConfirm(false)}
              className="btn-ghost text-xs"
            >
              Cancel
            </button>
            {deleteError && (
              <span className="text-xs text-red-500">{deleteError}</span>
            )}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setShowDeleteConfirm(true)}
            className="text-xs text-slate-500 hover:text-red-600 transition-colors"
            aria-label="Delete board"
          >
            {"\uD83D\uDDD1"}
          </button>
        )}
      </div>

      {/* Description panel */}
      {showDescription && (
        <div className="absolute mt-14 left-0 z-10 glass-elevated p-4 w-80 animate-slide-up">
          <textarea
            value={descValue}
            onChange={(e) => setDescValue(e.target.value)}
            onBlur={handleDescSave}
            placeholder="Add a board description (up to 500 characters)..."
            maxLength={500}
            rows={3}
            className="input-dark resize-none"
          />
          <p className="text-xs text-slate-500 mt-1.5">
            {descValue.length}/500
          </p>
        </div>
      )}
    </div>
  );
}

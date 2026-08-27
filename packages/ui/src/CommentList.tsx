"use client";

import { useEffect, useRef, useState } from "react";
import { CommentItem } from "./CommentItem";

/**
 * How long the "this one" marker stays on. It answers a question once — a
 * permanent highlight reads as a status the comment does not have.
 */
const HIGHLIGHT_DURATION_MS = 2500;

interface CommentData {
  id: string;
  projectId: string;
  content: unknown;
  authorName: string;
  authorAvatar: string | null;
  pinned: boolean;
  /**
   * OPTIONAL because this list is shared with project comments, which have no
   * privacy concept. Absent and false both mean "shown to everyone who can see
   * the item"; only employee comments ever set it.
   */
  isPrivate?: boolean;
  createdAt: Date | string;
  updatedAt: Date | string;
}

interface CommentListProps {
  comments: CommentData[];
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  onTogglePin: (id: string) => void;
  /**
   * Scroll to and briefly highlight this comment. Set when the reader arrived
   * from a notification — landing on the board was never the promise; landing on
   * the comment was.
   */
  targetCommentId?: string;
}

export function CommentList({
  comments,
  onEdit,
  onDelete,
  onTogglePin,
  targetCommentId,
}: CommentListProps) {
  const targetRef = useRef<HTMLDivElement>(null);
  const [isHighlightFaded, setIsHighlightFaded] = useState(false);

  useEffect(() => {
    // `targetRef` is only attached to a comment that EXISTS, so a target id
    // pointing at a deleted comment scrolls nothing rather than throwing.
    if (!targetCommentId || !targetRef.current) return;
    targetRef.current.scrollIntoView({ behavior: "smooth", block: "center" });

    const timer = setTimeout(() => setIsHighlightFaded(true), HIGHLIGHT_DURATION_MS);
    return () => clearTimeout(timer);
  }, [targetCommentId]);

  if (comments.length === 0) {
    return (
      <div className="flex items-center justify-center py-12">
        <p className="text-sm text-slate-400">No updates yet. Write the first one!</p>
      </div>
    );
  }

  return (
    <div>
      {comments.map((comment) => {
        const isTarget = comment.id === targetCommentId;
        return (
          <div
            key={comment.id}
            data-testid={`comment-${comment.id}`}
            data-highlighted={String(isTarget)}
            ref={isTarget ? targetRef : undefined}
            className={
              isTarget && !isHighlightFaded
                ? "rounded-lg ring-2 ring-teal-400/70 transition-shadow duration-700"
                : "transition-shadow duration-700"
            }
          >
            <CommentItem
              comment={comment}
              onEdit={onEdit}
              onDelete={onDelete}
              onTogglePin={onTogglePin}
            />
          </div>
        );
      })}
    </div>
  );
}

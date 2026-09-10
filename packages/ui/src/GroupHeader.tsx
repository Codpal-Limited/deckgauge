"use client";

import { useState, useRef, useEffect } from "react";
import type { ProjectStatus } from "@deckgauge/shared";
import { StatusDistributionBar, type BoardStatusSegment } from "./StatusDistributionBar";

const GROUP_COLORS = [
  "#6C6CFF", "#579BFC", "#00C875", "#9CD326",
  "#CAB641", "#FDAB3D", "#FF642E", "#E44258",
  "#FF158A", "#BB3354", "#7F5347", "#C4C4C4",
  "#784BD1", "#0086C0", "#037F4C", "#225091",
  "#FFCB00", "#A25DDC", "#1F76C2", "#757575",
];

interface GroupHeaderProps {
  title: string;
  count: number;
  collapsed?: boolean;
  onToggle?: () => void;
  statusCounts?: Record<ProjectStatus, number>;
  boardStatusDistribution?: BoardStatusSegment[];
  color?: string;
  onColorChange?: (color: string) => void;
  onRename?: (name: string) => void;
  onDuplicate?: () => void;
  onDelete?: () => void;
  onCollapseAll?: () => void;
}

export function GroupHeader({
  title,
  count,
  collapsed = false,
  onToggle,
  statusCounts,
  boardStatusDistribution,
  color = "#6C6CFF",
  onColorChange,
  onRename,
  onDuplicate,
  onDelete,
  onCollapseAll,
}: GroupHeaderProps) {
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [nameValue, setNameValue] = useState(title);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const colorRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setNameValue(title);
  }, [title]);

  useEffect(() => {
    if (isRenaming) inputRef.current?.select();
  }, [isRenaming]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false);
      }
      if (colorRef.current && !colorRef.current.contains(e.target as Node)) {
        setShowColorPicker(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const handleRenameSubmit = () => {
    const trimmed = nameValue.trim();
    if (trimmed && trimmed !== title) {
      onRename?.(trimmed);
    } else {
      setNameValue(title);
    }
    setIsRenaming(false);
  };

  return (
    <div className="relative flex items-center gap-2.5 py-1.5" ref={colorRef}>
      {onToggle && (
        <button
          type="button"
          onClick={onToggle}
          className="flex items-center justify-center w-5 h-5 transition-colors"
          style={{ color }}
          aria-label={collapsed ? "Expand group" : "Collapse group"}
        >
          <svg
            className={`w-3.5 h-3.5 transition-transform duration-200 ${collapsed ? "" : "rotate-90"}`}
            fill="currentColor"
            viewBox="0 0 20 20"
          >
            <path d="M6 4l8 6-8 6V4z" />
          </svg>
        </button>
      )}

      {/* Title */}
      {isRenaming ? (
        <input
          ref={inputRef}
          type="text"
          value={nameValue}
          onChange={(e) => setNameValue(e.target.value)}
          onBlur={handleRenameSubmit}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleRenameSubmit();
            if (e.key === "Escape") {
              setNameValue(title);
              setIsRenaming(false);
            }
          }}
          className="text-sm font-bold text-slate-700 bg-white border border-indigo-500 rounded-md px-1.5 py-0.5 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
        />
      ) : (
        <h2
          className="text-sm font-bold cursor-pointer transition-colors"
          style={{ color }}
          onClick={() => onRename && setIsRenaming(true)}
        >
          {title}
          <span className="text-slate-400 font-normal text-xs ml-1.5">
            {count} {count === 1 ? "item" : "items"}
          </span>
        </h2>
      )}

      {statusCounts && (
        <StatusDistributionBar
          statusCounts={statusCounts}
          boardStatusDistribution={boardStatusDistribution}
        />
      )}

      {/* Color picker popover (triggered from menu) */}
      {showColorPicker && (
        <div className="absolute z-50 top-8 left-0 glass-elevated p-2.5 grid grid-cols-4 gap-2 w-40 animate-fade-in">
          {GROUP_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => {
                onColorChange?.(c);
                setShowColorPicker(false);
              }}
              className={`w-6 h-6 rounded-full hover:ring-2 hover:ring-offset-1 hover:ring-offset-surface-2 hover:ring-white/20 transition-all ${c === color ? "ring-2 ring-offset-1 ring-offset-surface-2 ring-indigo-500" : ""}`}
              style={{ backgroundColor: c }}
              aria-label={`Color ${c}`}
            />
          ))}
        </div>
      )}

      {/* Three-dot menu */}
      {(onRename || onDuplicate || onDelete || onCollapseAll || onColorChange) && (
        <div className="relative ml-auto" ref={menuRef}>
          <button
            type="button"
            onClick={() => setShowMenu(!showMenu)}
            className="text-slate-400 hover:text-slate-600 px-1 transition-colors"
            aria-label="Group actions"
          >
            {"\u22EF"}
          </button>
          {showMenu && (
            <div className="dropdown-menu right-0 top-6 w-44">
              {onRename && (
                <button
                  type="button"
                  onClick={() => {
                    setIsRenaming(true);
                    setShowMenu(false);
                  }}
                  className="dropdown-item"
                >
                  Rename
                </button>
              )}
              {onColorChange && (
                <button
                  type="button"
                  onClick={() => {
                    setShowColorPicker(true);
                    setShowMenu(false);
                  }}
                  className="dropdown-item"
                >
                  Change color
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
                  Duplicate group
                </button>
              )}
              {onCollapseAll && (
                <button
                  type="button"
                  onClick={() => {
                    onCollapseAll();
                    setShowMenu(false);
                  }}
                  className="dropdown-item"
                >
                  Collapse all groups
                </button>
              )}
              {onDelete && (
                <>
                  <div className="border-t border-slate-200 my-1" />
                  {showDeleteConfirm ? (
                    <div className="px-4 py-2">
                      <p className="text-xs text-slate-400 mb-2">
                        Delete this group and all items?
                      </p>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            onDelete();
                            setShowMenu(false);
                            setShowDeleteConfirm(false);
                          }}
                          className="inline-flex min-h-11 items-center justify-center md:min-h-0 rounded-lg bg-red-500/20 border border-red-500/30 px-2 py-1 text-xs text-red-600 hover:bg-red-500/30 transition-colors"
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
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setShowDeleteConfirm(true)}
                      className="dropdown-item-danger"
                    >
                      Delete group
                    </button>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

'use client';

import { useState, useCallback, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  useDroppable,
  useDraggable,
  closestCenter,
  type DragEndEvent,
  type DragStartEvent,
  type DragOverEvent,
} from '@dnd-kit/core';
import type { BoardColumn, RoadmapDetail, RoadmapGroupResolved, RoadmapItem, SystemColumnKey } from '@deckgauge/shared';
import { useCrossBoardMove, type DroppedSummary } from './useCrossBoardMove';
import { resolveDropAction } from './resolveDropAction';
import { ItemDetailPanel } from '../ItemDetailPanel';
import { loadBoardColumns } from '../../actions/roadmap';
import { createRoadmapAdapter } from './roadmap-entity-adapter';
import { MOUSE_DRAG_ACTIVATION, TOUCH_DRAG_ACTIVATION } from '../../lib/dnd-activation';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ALL_SYSTEM_COLUMNS: { key: SystemColumnKey; label: string }[] = [
  { key: 'title', label: 'Title' },
  { key: 'size', label: 'Size' },
  { key: 'startDate', label: 'Start Date' },
  { key: 'endDate', label: 'End Date' },
  { key: 'duration', label: 'Duration' },
];

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface ColumnHeadersProps {
  hiddenSystemColumns: SystemColumnKey[];
}

function ColumnHeaders({ hiddenSystemColumns }: ColumnHeadersProps) {
  const visible = ALL_SYSTEM_COLUMNS.filter(
    (col) => col.key === 'title' || !hiddenSystemColumns.includes(col.key),
  );
  return (
    <div className="flex items-center gap-4 px-3 py-1 text-xs font-semibold text-gray-500 border-b border-gray-200 bg-gray-50">
      {visible.map((col) => (
        <span key={col.key} className={col.key === 'title' ? 'flex-1' : 'w-24 text-right'}>
          {col.label}
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Draggable item row
// ---------------------------------------------------------------------------

interface DraggableItemRowProps {
  item: RoadmapItem;
  hiddenSystemColumns: SystemColumnKey[];
  onOpen: (id: string) => void;
}

function DraggableItemRow({ item, hiddenSystemColumns, onOpen }: DraggableItemRowProps) {
  const showSize = !hiddenSystemColumns.includes('size');
  const showStart = !hiddenSystemColumns.includes('startDate');
  const showEnd = !hiddenSystemColumns.includes('endDate');
  const showDuration = !hiddenSystemColumns.includes('duration');

  const draggableId = `item-${item.id}`;
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: draggableId,
    data: { projectId: item.id, groupId: item.groupId, boardId: item.boardId },
  });

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onClick={() => { if (!isDragging) onOpen(item.id); }}
      className={[
        'flex items-center gap-4 px-3 py-2 border-b border-gray-100 text-sm',
        isDragging ? 'opacity-40 cursor-grabbing' : 'hover:bg-gray-50 cursor-pointer',
      ].join(' ')}
    >
      <span className="flex-1 truncate">{item.name}</span>
      {showSize && <span className="w-24 text-right text-gray-600">{item.sizeLabel ?? '—'}</span>}
      {showStart && <span className="w-24 text-right text-gray-600">{item.startDate ?? '—'}</span>}
      {showEnd && <span className="w-24 text-right text-gray-600">{item.endDate ?? '—'}</span>}
      {showDuration && (
        <span className="w-24 text-right text-gray-600">{item.durationCode ?? '—'}</span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cross-board drop confirm dialog
// ---------------------------------------------------------------------------

interface DropConfirmDialogProps {
  dropped: DroppedSummary;
  onConfirm: () => void;
  onCancel: () => void;
}

function DropConfirmDialog({ dropped, onConfirm, onCancel }: DropConfirmDialogProps) {
  const losses: string[] = [];
  if (dropped.ownerCleared) losses.push('Owner will be cleared');
  if (dropped.statusReset) losses.push('Status will be reset');
  if (dropped.columnsDropped.length > 0) {
    losses.push(`Custom columns lost: ${dropped.columnsDropped.join(', ')}`);
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Confirm cross-board move"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
    >
      <div className="bg-white rounded-lg shadow-xl p-6 max-w-sm w-full">
        <h2 className="text-base font-semibold mb-2">Move to another board?</h2>
        {losses.length > 0 ? (
          <>
            <p className="text-sm text-gray-600 mb-3">
              The following will be affected by this move:
            </p>
            <ul className="text-sm text-amber-700 list-disc list-inside mb-4 space-y-1">
              {losses.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          </>
        ) : (
          <p className="text-sm text-gray-600 mb-4">
            This item will be moved to the target board group.
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-sm rounded border border-gray-300 hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="px-3 py-1.5 text-sm rounded bg-blue-600 text-white hover:bg-blue-700"
          >
            Move
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Droppable group section
// ---------------------------------------------------------------------------

interface GroupSectionProps {
  group: RoadmapGroupResolved;
  hiddenSystemColumns: SystemColumnKey[];
  isDropTarget: boolean;
  onOpen: (id: string) => void;
}

function GroupSection({ group, hiddenSystemColumns, isDropTarget, onOpen }: GroupSectionProps) {
  const { setNodeRef, isOver } = useDroppable({
    id: `group-${group.groupId}`,
    data: { groupId: group.groupId, boardId: group.boardId },
  });

  const highlight = isDropTarget && isOver;

  return (
    <section
      ref={setNodeRef}
      aria-label={group.name}
      className={highlight ? 'ring-2 ring-blue-400 ring-inset rounded' : undefined}
    >
      <div
        data-testid="group-header"
        className="flex items-center gap-2 px-3 py-2 bg-white border-b border-gray-200"
      >
        <span
          className="inline-block w-2.5 h-2.5 rounded-full flex-shrink-0"
          style={{ backgroundColor: group.color }}
          aria-hidden="true"
        />
        <span className="font-medium text-sm">{group.name}</span>
        <span className="ml-1 px-1.5 py-0.5 text-xs rounded bg-gray-100 text-gray-500 border border-gray-200">
          {group.boardName}
        </span>
      </div>
      {group.items.map((item) => (
        <DraggableItemRow
          key={item.id}
          item={item}
          hiddenSystemColumns={hiddenSystemColumns}
          onOpen={onOpen}
        />
      ))}
      {group.items.length === 0 && (
        <div className="px-3 py-3 text-xs text-gray-400 italic">No items</div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Pending cross-board drop state
// ---------------------------------------------------------------------------

interface PendingCrossBoardDrop {
  projectId: string;
  targetGroupId: string;
  /** Preview of what will be lost — fetched optimistically before confirm */
  preview: DroppedSummary;
}

// ---------------------------------------------------------------------------
// RoadmapGrid (public)
// ---------------------------------------------------------------------------

interface RoadmapGridProps {
  roadmap: RoadmapDetail;
}

export function RoadmapGrid({ roadmap }: RoadmapGridProps) {
  const router = useRouter();
  const [openId, setOpenId] = useState<string | null>(null);
  const [pendingDrop, setPendingDrop] = useState<PendingCrossBoardDrop | null>(null);
  const [activeItemName, setActiveItemName] = useState<string | null>(null);
  const [dropTargetGroupId, setDropTargetGroupId] = useState<string | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);

  // Build itemId → boardId map and load columns per distinct board (mirrors RoadmapEntityCanvas).
  const boardByItem = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of roadmap.groups) for (const it of g.items) m.set(it.id, it.boardId);
    return m;
  }, [roadmap.groups]);

  const boardIds = useMemo(() => Array.from(new Set(boardByItem.values())), [boardByItem]);

  const [columnsByBoard, setColumnsByBoard] = useState<Map<string, BoardColumn[]>>(new Map());

  useEffect(() => {
    let cancelled = false;
    Promise.all(boardIds.map((b) => loadBoardColumns(b).then((c) => [b, c] as const))).then(
      (entries) => {
        if (!cancelled) setColumnsByBoard(new Map(entries));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [boardIds]);

  const adapter = useMemo(
    () => createRoadmapAdapter({ roadmapId: roadmap.id, boardByItem, columnsByBoard }),
    [roadmap.id, boardByItem, columnsByBoard],
  );

  const { move, pending: movePending } = useCrossBoardMove({
    onMoved: () => {
      // Refresh server data so the grid reflects the moved item immediately.
      router.refresh();
    },
  });

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: MOUSE_DRAG_ACTIVATION }),
    useSensor(TouchSensor, { activationConstraint: TOUCH_DRAG_ACTIVATION }),
    useSensor(KeyboardSensor),
  );

  // Sorted by position (roadmap-local order)
  const sortedGroups = [...roadmap.groups].sort((a, b) => a.position - b.position);

  // Build a lookup: groupId → group (for cross-board move preview + same-board move)
  const groupById = new Map(sortedGroups.map((g) => [g.groupId, g]));

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveItemName(null);
      setDropTargetGroupId(null);

      const { active, over } = event;
      if (!over) return;

      const dragData = active.data.current as
        | { projectId: string; groupId: string; boardId: string }
        | undefined;
      const dropData = over.data.current as
        | { groupId: string; boardId: string }
        | undefined;

      if (!dragData || !dropData) return;

      const action = resolveDropAction(
        { projectId: dragData.projectId, groupId: dragData.groupId, boardId: dragData.boardId },
        { groupId: dropData.groupId, boardId: dropData.boardId },
      );

      if (action.type === 'no-op') return;

      if (action.type === 'same-board') {
        // Same-board relocate: routes through POST /projects/:id/move-to-board,
        // which reassigns the item's group on the same board.
        // V1 known limitation: drop-index ordering within the target group is not
        // honored — the item appends to the bottom of the target group.
        void move({ projectId: action.projectId, targetGroupId: action.targetGroupId }).then(() => {
          router.refresh();
        });
        return;
      }

      // Cross-board: determine field-loss preview by comparing source vs target group schemas.
      // For now, build a conservative preview based on whether the target board differs.
      // The API response from move() returns the authoritative DroppedSummary.
      const targetGroup = groupById.get(action.targetGroupId);
      const sourceGroup = groupById.get(action.sourceGroupId);

      const preview: DroppedSummary = {
        ownerCleared: false,
        statusReset: false,
        // If boards differ, custom columns (non-system) won't carry unless the target board
        // has matching column definitions. We show a generic warning here; the API result
        // is authoritative after confirm.
        columnsDropped:
          targetGroup && sourceGroup && targetGroup.boardId !== sourceGroup.boardId
            ? ['Custom fields may not carry over']
            : [],
      };

      setPendingDrop({
        projectId: action.projectId,
        targetGroupId: action.targetGroupId,
        preview,
      });
    },
    [move, groupById, router],
  );

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const dragData = event.active.data.current as { projectId?: string } | undefined;
      if (!dragData) return;
      // Find the item name for the DragOverlay label.
      // Do NOT highlight the source group — handleDragOver drives the drop-target highlight.
      for (const group of sortedGroups) {
        const item = group.items.find((i) => i.id === dragData.projectId);
        if (item) {
          setActiveItemName(item.name);
          setDropTargetGroupId(null);
          return;
        }
      }
    },
    [sortedGroups],
  );

  const handleDragOver = useCallback((event: DragOverEvent) => {
    const overData = event.over?.data.current as { groupId?: string } | undefined;
    setDropTargetGroupId(overData?.groupId ?? null);
  }, []);

  const handleConfirmMove = async () => {
    if (!pendingDrop) return;
    const { projectId, targetGroupId } = pendingDrop;
    setPendingDrop(null);
    setMoveError(null);
    try {
      await move({ projectId, targetGroupId });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Move failed. Please try again.';
      setMoveError(message);
    }
  };

  const handleCancelMove = () => {
    setPendingDrop(null);
  };

  return (
    <>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
      >
        <div className="rounded-lg border border-gray-200 overflow-hidden">
          <ColumnHeaders hiddenSystemColumns={roadmap.hiddenSystemColumns} />
          {sortedGroups.map((group) => (
            <GroupSection
              key={group.groupId}
              group={group}
              hiddenSystemColumns={roadmap.hiddenSystemColumns}
              isDropTarget={dropTargetGroupId === group.groupId}
              onOpen={setOpenId}
            />
          ))}
        </div>

        <DragOverlay>
          {activeItemName ? (
            <div className="bg-white border border-blue-400 rounded shadow-lg px-3 py-2 text-sm text-blue-700 opacity-90">
              {activeItemName}
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      {pendingDrop && (
        <DropConfirmDialog
          dropped={pendingDrop.preview}
          onConfirm={handleConfirmMove}
          onCancel={handleCancelMove}
        />
      )}

      {movePending && (
        <div
          role="status"
          aria-label="Moving item…"
          className="fixed bottom-4 right-4 z-40 bg-white border border-gray-200 rounded shadow px-3 py-2 text-sm text-gray-600"
        >
          Moving…
        </div>
      )}

      {moveError && (
        <div
          role="alert"
          className="fixed bottom-4 right-4 z-40 bg-white border border-red-300 rounded shadow px-3 py-2 text-sm text-red-700 flex items-center gap-2"
        >
          <span>{moveError}</span>
          <button
            onClick={() => setMoveError(null)}
            aria-label="Dismiss error"
            className="ml-1 text-red-500 hover:text-red-700 font-bold"
          >
            ×
          </button>
        </div>
      )}

      {openId && (() => {
        const openItem = roadmap.groups.flatMap((g) => g.items).find((it) => it.id === openId);
        if (!openItem) return null;
        const detailProject = {
          id: openItem.id,
          name: openItem.name,
          status: openItem.status as Parameters<typeof ItemDetailPanel>[0]['project']['status'],
          ownerId: null,
          owner: openItem.owner,
          statusId: null,
          description: null,
          updatedAt: new Date().toISOString(),
          jiraKey: null,
          githubIssueId: null,
          githubRepoFullName: null,
          adoWorkItemId: null,
          adoProject: null,
          startDate: openItem.startDate,
          endDate: openItem.endDate,
          durationCode: openItem.durationCode,
          fieldValues: {},
        } as unknown as Parameters<typeof ItemDetailPanel>[0]['project'];
        return (
          <ItemDetailPanel
            project={detailProject}
            columns={adapter.columnsFor(openId)}
            boardId={boardByItem.get(openId) ?? ''}
            defaultTab="details"
            onClose={() => {
              setOpenId(null);
              router.refresh();
            }}
            onSave={(field, value) => {
              if (field === 'startDate' || field === 'endDate' || field === 'durationCode') {
                void adapter.saveSchedule(openId, { [field]: value || null });
              } else {
                void adapter.updateField(openId, field, value);
              }
            }}
          />
        );
      })()}
    </>
  );
}

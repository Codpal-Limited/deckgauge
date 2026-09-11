'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  pointerWithin,
  rectIntersection,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import type { OrgTreeDto, OrgEmployeeDto } from '@deckgauge/shared';
import { wouldCreateCycle } from '@deckgauge/shared';
import { OrgEmployeeNode } from './OrgEmployeeNode';
import { moveEmployee } from '../../actions/org-trees';
import { MOUSE_DRAG_ACTIVATION, TOUCH_DRAG_ACTIVATION } from '../../lib/dnd-activation';

// ---------------------------------------------------------------------------
// Pure DnD helper (exported for testing)
// ---------------------------------------------------------------------------

export type DropIntent =
  | { type: 'onto'; targetId: string }
  | { type: 'between'; managerId: string | null; position: number };

export interface MoveResult {
  employeeId: string;
  managerId: string | null;
  position: number;
}

/**
 * Resolve a drag-end drop intent into a MoveResult, or null when the move is
 * illegal (cycle) or a no-op.
 */
export function resolveMove(
  employees: Pick<OrgEmployeeDto, 'id' | 'managerId'>[],
  employeeId: string,
  drop: DropIntent,
): MoveResult | null {
  if (drop.type === 'onto') {
    const { targetId } = drop;
    // Dropping onto self is a no-op
    if (targetId === employeeId) return null;
    // Guard against cycles
    if (wouldCreateCycle(employees, employeeId, targetId)) return null;
    // Append: position = current child count of targetId
    const childCount = employees.filter((e) => e.managerId === targetId).length;
    return { employeeId, managerId: targetId, position: childCount };
  }

  // type === 'between': reorder under a specific manager
  const { managerId, position } = drop;
  if (wouldCreateCycle(employees, employeeId, managerId)) return null;
  return { employeeId, managerId, position };
}

// ---------------------------------------------------------------------------
// DnD collision strategy (prefer exact droppable over root)
// ---------------------------------------------------------------------------

const DROPPABLE_PREFIX = 'emp:';

const collisionDetection: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  // Prefer the innermost employee droppable over the root canvas droppable
  const empHit = hits.find((c) => String(c.id).startsWith(DROPPABLE_PREFIX));
  if (empHit) return [empHit];
  if (hits.length > 0) return hits;
  return rectIntersection(args);
};

// ---------------------------------------------------------------------------
// Per-node draggable + droppable wrapper
// ---------------------------------------------------------------------------

function buildChildMap(
  employees: OrgEmployeeDto[],
): Map<string | null, OrgEmployeeDto[]> {
  const map = new Map<string | null, OrgEmployeeDto[]>();
  for (const emp of employees) {
    const key = emp.managerId ?? null;
    const existing = map.get(key) ?? [];
    map.set(key, [...existing, emp]);
  }
  return map;
}

interface DraggableNodeProps {
  employee: OrgEmployeeDto;
  childMap: Map<string | null, OrgEmployeeDto[]>;
  /** Flat roster, forwarded to the node purely for the cascade delete dialog. */
  employees: OrgEmployeeDto[];
  orgTreeId: string;
  onRefresh: () => void;
  onSelectEmployee?: (id: string) => void;
}

function DraggableNode({ employee, childMap, employees, orgTreeId, onRefresh, onSelectEmployee }: DraggableNodeProps) {
  const [collapsed, setCollapsed] = useState(false);

  const { attributes, listeners, setNodeRef: setDragRef, isDragging } = useDraggable({
    id: `emp:${employee.id}`,
  });
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `emp:${employee.id}`,
  });

  const children = childMap.get(employee.id) ?? [];

  // 38px of inset per level (26 + 12) is desktop arithmetic: at 390px a depth-6 node
  // had 228px of its 358px content box spent on indentation. 16px keeps the connector
  // line legible and the card usable; `md:` restores the original.
  const childrenNodes =
    !collapsed && children.length > 0 ? (
      <div className="ml-2 border-l border-slate-200 pl-2 md:ml-[26px] md:pl-3">
        {children.map((child) => (
          <DraggableNode
            key={child.id}
            employee={child}
            childMap={childMap}
            employees={employees}
            orgTreeId={orgTreeId}
            onRefresh={onRefresh}
            onSelectEmployee={onSelectEmployee}
          />
        ))}
      </div>
    ) : null;

  const caret =
    children.length > 0 ? (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setCollapsed((c) => !c);
        }}
        aria-label={collapsed ? 'Expand' : 'Collapse'}
        className="grid h-11 w-11 place-items-center rounded-md text-slate-400 transition hover:bg-indigo-50 hover:text-indigo-600 md:h-5 md:w-5"
      >
        <svg
          className={`h-4 w-4 transition-transform md:h-3.5 md:w-3.5 ${collapsed ? '-rotate-90' : ''}`}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.4}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
    ) : null;

  return (
    <div
      ref={(node) => {
        setDragRef(node);
        setDropRef(node);
      }}
      className={[
        isDragging ? 'opacity-40' : '',
        isOver ? 'rounded-xl ring-2 ring-indigo-400 ring-offset-2' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      {...attributes}
      {...listeners}
    >
      <OrgEmployeeNode
        employee={employee}
        orgTreeId={orgTreeId}
        childrenNodes={childrenNodes}
        employees={employees}
        onRefresh={onRefresh}
        onSelectEmployee={onSelectEmployee}
        leading={caret}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// OrgTreeView
// ---------------------------------------------------------------------------

interface OrgTreeViewProps {
  tree: OrgTreeDto;
  onRefresh?: () => void;
  onSelectEmployee?: (id: string) => void;
}

export function OrgTreeView({ tree, onRefresh, onSelectEmployee }: OrgTreeViewProps) {
  const [draggingEmp, setDraggingEmp] = useState<OrgEmployeeDto | null>(null);
  const [, startTransition] = useTransition();
  const router = useRouter();

  const refresh = () => { onRefresh?.(); router.refresh(); };

  const childMap = buildChildMap(tree.employees);
  const roots = childMap.get(null) ?? [];

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: MOUSE_DRAG_ACTIVATION }),
    useSensor(TouchSensor, { activationConstraint: TOUCH_DRAG_ACTIVATION }),
    useSensor(KeyboardSensor),
  );

  const onDragStart = (e: DragStartEvent) => {
    const id = String(e.active.id);
    if (id.startsWith(DROPPABLE_PREFIX)) {
      const empId = id.slice(DROPPABLE_PREFIX.length);
      setDraggingEmp(tree.employees.find((em) => em.id === empId) ?? null);
    }
  };

  const onDragEnd = (e: DragEndEvent) => {
    setDraggingEmp(null);
    const activeId = String(e.active.id);
    const overId = e.over ? String(e.over.id) : null;
    if (!activeId.startsWith(DROPPABLE_PREFIX) || !overId?.startsWith(DROPPABLE_PREFIX)) return;

    const employeeId = activeId.slice(DROPPABLE_PREFIX.length);
    const targetId = overId.slice(DROPPABLE_PREFIX.length);
    if (employeeId === targetId) return;

    const result = resolveMove(tree.employees, employeeId, { type: 'onto', targetId });
    if (!result) return;

    startTransition(async () => {
      await moveEmployee(result.employeeId, {
        managerId: result.managerId,
        position: result.position,
      });
      refresh();
    });
  };

  if (roots.length === 0) {
    return (
      <div className="py-8 text-center text-gray-400">
        No employees in this org tree yet. Import a chart or trigger a sync.
      </div>
    );
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setDraggingEmp(null)}
    >
      <div className="overflow-auto">
        {roots.map((root) => (
          <DraggableNode
            key={root.id}
            employee={root}
            childMap={childMap}
            employees={tree.employees}
            orgTreeId={tree.id}
            onRefresh={refresh}
            onSelectEmployee={onSelectEmployee}
          />
        ))}
      </div>
      <DragOverlay dropAnimation={null}>
        {draggingEmp ? (
          <div className="rounded border border-indigo-200 bg-white px-3 py-1.5 text-sm text-slate-700 shadow-lg">
            {draggingEmp.name}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

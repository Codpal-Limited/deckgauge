'use client';

import { useMemo, useState } from 'react';
import {
  DndContext,
  MouseSensor,
  TouchSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
} from '@dnd-kit/core';
import { toast } from 'sonner';
import type { BoardColumn, SizeDurations } from '@deckgauge/shared';
import { addCalendarDays } from '@deckgauge/shared';
import { RoadmapHeader } from './RoadmapHeader';
import { TodayLine } from './TodayLine';
import { RoadmapProgressBar } from './RoadmapProgressBar';
import { RoadmapGroupLane } from './RoadmapGroupLane';
import { RoadmapSettings } from './RoadmapSettings';
import { useScheduleWorker } from './useScheduleWorker';
import type { ScheduleInput } from './useScheduleWorker';
import {
  PX_PER_DAY,
  LANE_LABEL_WIDTH,
  daysBetween,
  quartersFrom,
  quarterCount,
  timelineWidthPx,
  dateToX,
  xToDate,
  snapToDay,
} from './geometry';
import { classifyDrag } from './drag';
import { ItemDetailPanel } from '../ItemDetailPanel';
import type { RoadmapPersistenceAdapter } from './roadmap-adapter';
import { DragDateOverlay } from './DragDateOverlay';
import { MOUSE_DRAG_ACTIVATION, TOUCH_DRAG_ACTIVATION } from '../../lib/dnd-activation';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RoadmapConfigShape {
  id: string;
  boardViewId: string;
  startDate: string;
  visibleQuarters: number;
  sizeDurations: Record<string, number>;
  defaultSizeWeeks: number;
  hiddenGroupIds: string[];
}

export interface RoadmapProjectShape {
  id: string;
  name: string;
  status: string;
  groupId: string | null;
  order: number | null;
  assigneeId: string | null;
  owner: string;
  sizeLabel: string | null;
  sizeWeeks: number | null;
  startDate: string | null;
  endDate: string | null;
  durationCode: string | null;
}

interface RoadmapGroupShape {
  id: string;
  name: string;
  color: string;
  position: number;
}

export interface RoadmapViewPayloadShape {
  config: RoadmapConfigShape;
  groups: RoadmapGroupShape[];
  projects: RoadmapProjectShape[];
}

interface RoadmapCanvasProps {
  boardId: string;
  initial: RoadmapViewPayloadShape;
  columns: BoardColumn[];
  owners?: string[];
  canEdit: boolean;
  adapter: RoadmapPersistenceAdapter;
}

/** Height of a single assignee row in pixels — must match RoadmapAssigneeRow */
const ASSIGNEE_ROW_HEIGHT = 46;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function RoadmapCanvas({
  boardId,
  initial,
  columns,
  owners,
  canEdit,
  adapter,
}: RoadmapCanvasProps) {
  const [projects, setProjects] = useState<RoadmapProjectShape[]>(initial.projects);
  const [config, setConfig] = useState<RoadmapConfigShape>({
    ...initial.config,
    hiddenGroupIds: initial.config.hiddenGroupIds ?? [],
  });
  const [visibleQuarters, setVisibleQuarters] = useState(initial.config.visibleQuarters);
  const [openId, setOpenId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [overlay, setOverlay] = useState<{ x: number | null; date: Date | null }>({
    x: null,
    date: null,
  });

  const viewStart = useMemo(() => new Date(config.startDate), [config.startDate]);

  const visibleGroups = useMemo(
    () =>
      [...initial.groups]
        .sort((a, b) => a.position - b.position)
        .filter((g) => !config.hiddenGroupIds.includes(g.id)),
    [initial.groups, config.hiddenGroupIds],
  );

  // NOTE: keep this useMemo — building scheduleInput inline causes an infinite
  // render loop because the object identity changes every render.
  const scheduleInput: ScheduleInput = useMemo(
    () => ({
      groups: visibleGroups.map((g) => ({ id: g.id })),
      projects: projects
        .filter((p) => p.groupId === null || visibleGroups.some((g) => g.id === p.groupId))
        .map((p) => ({
          id: p.id,
          groupId: p.groupId,
          order: p.order,
          assigneeId: p.assigneeId,
          sizeWeeks: p.sizeWeeks,
          sizeLabel: p.sizeLabel,
          durationCode: p.durationCode,
          startDate: p.startDate ? new Date(p.startDate) : null,
          endDate: p.endDate ? new Date(p.endDate) : null,
        })),
      config: {
        startDate: viewStart,
        sizeDurations: config.sizeDurations as unknown as SizeDurations,
        defaultSizeWeeks: config.defaultSizeWeeks,
      },
    }),
    [visibleGroups, projects, config, viewStart],
  );

  const { schedule, computing, progress } = useScheduleWorker(scheduleInput);

  // Quarter grid sized to cover all scheduled work (never clip a bar), but at
  // least the zoom extent the user selected.
  const maxEndDays = useMemo(() => {
    let m = 0;
    for (const bar of schedule.values()) {
      m = Math.max(m, daysBetween(viewStart, bar.endDate));
    }
    return m;
  }, [schedule, viewStart]);

  const quarters = useMemo(
    () => quartersFrom(viewStart, quarterCount(visibleQuarters, maxEndDays)),
    [viewStart, visibleQuarters, maxEndDays],
  );
  const tlWidth = useMemo(() => timelineWidthPx(quarters), [quarters]);

  // The default "Size" board column drives bar length; used to persist + live-
  // reschedule when the size is changed from the detail panel.
  const sizeColumn = useMemo(() => columns.find((c) => c.name === 'Size'), [columns]);

  // ---------------------------------------------------------------------------
  // DnD sensors — distance:5 prevents a plain click from activating drag
  // ---------------------------------------------------------------------------

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: MOUSE_DRAG_ACTIVATION }),
    useSensor(TouchSensor, { activationConstraint: TOUCH_DRAG_ACTIVATION }),
    useSensor(KeyboardSensor),
  );

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  const handleRename = async (id: string, title: string) => {
    const snapshot = projects;
    setProjects((prev) => prev.map((p) => (p.id === id ? { ...p, name: title } : p)));
    try {
      await adapter.updateField(id, 'name', title);
    } catch {
      setProjects(snapshot);
      toast.error('Failed to rename item');
    }
  };

  const handleHorizontalDrag = async (id: string, deltaX: number) => {
    const current = schedule.get(id);
    if (!current) return;
    const snapshot = projects;
    const days = Math.round(deltaX / PX_PER_DAY);
    const shifted = addCalendarDays(current.startDate, days);
    const snapped = new Date(
      Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()),
    );
    const startDate = snapped.toISOString();
    setProjects((prev) => prev.map((p) => (p.id === id ? { ...p, startDate } : p)));
    const result = await adapter.saveSchedule(id, { startDate });
    if (!result.ok) {
      setProjects(snapshot);
      toast.error('Failed to set start date');
    }
  };

  const handleResize = async (id: string, endDate: Date) => {
    const current = schedule.get(id);
    if (!current) return;
    const snapshot = projects;
    const proj = projects.find((p) => p.id === id);
    // An end date needs a start; if none yet, anchor at the bar's current start.
    const startDate = proj?.startDate ?? snapToDay(current.startDate).toISOString();
    const endIso = endDate.toISOString();
    setProjects((prev) =>
      prev.map((p) => (p.id === id ? { ...p, startDate, endDate: endIso } : p)),
    );
    const result = await adapter.saveSchedule(id, { startDate, endDate: endIso });
    if (!result.ok) {
      setProjects(snapshot);
      toast.error('Failed to set end date');
    }
  };

  const handleGroupMove = async (id: string, targetGroupId: string) => {
    const snapshot = projects;
    setProjects((prev) => prev.map((p) => (p.id === id ? { ...p, groupId: targetGroupId } : p)));
    try {
      await adapter.reorderItem(id, { groupId: targetGroupId });
    } catch {
      setProjects(snapshot);
      toast.error('Failed to move item to group');
    }
  };

  const handleReorder = async (id: string, newOrder: number) => {
    const snapshot = projects;
    setProjects((prev) => prev.map((p) => (p.id === id ? { ...p, order: newOrder } : p)));
    try {
      await adapter.reorderItem(id, { order: newOrder });
    } catch {
      setProjects(snapshot);
      toast.error('Failed to reorder item');
    }
  };

  const handleSettingsChange = async (patch: Parameters<typeof adapter.saveConfig>[0]) => {
    try {
      const updated = await adapter.saveConfig(patch);
      setConfig((prev) => ({
        ...prev,
        startDate: updated.startDate ?? prev.startDate,
        visibleQuarters: updated.visibleQuarters ?? prev.visibleQuarters,
        sizeDurations: (updated.sizeDurations as Record<string, number>) ?? prev.sizeDurations,
        defaultSizeWeeks: updated.defaultSizeWeeks ?? prev.defaultSizeWeeks,
        hiddenGroupIds: updated.hiddenGroupIds ?? prev.hiddenGroupIds,
      }));
      if (updated.visibleQuarters !== undefined) {
        setVisibleQuarters(updated.visibleQuarters);
      }
    } catch {
      toast.error('Failed to update roadmap settings');
    }
  };

  // Routes saves from the detail panel back to the board AND updates local
  // state so the timeline reschedules live (owner → parallel track, size → bar
  // length). `field` is a built-in key (name/owner/status/description) or a
  // custom column id.
  const handleDetailSave = async (field: string, value: string) => {
    if (!openId) return;
    const id = openId;

    if (field === 'name') {
      void handleRename(id, value);
      return;
    }

    if (field === 'description') {
      try {
        await adapter.updateField(id, 'description', value);
      } catch {
        toast.error('Failed to update description');
      }
      return;
    }

    if (field === 'status') {
      const snapshot = projects;
      setProjects((prev) => prev.map((p) => (p.id === id ? { ...p, status: value } : p)));
      try {
        await adapter.updateField(id, 'status', value);
      } catch {
        setProjects(snapshot);
        toast.error('Failed to update status');
      }
      return;
    }

    if (field === 'owner') {
      const snapshot = projects;
      const assignee = value.trim().length > 0 ? value.trim() : null;
      // Mirror loadView: with no structured BoardOwner, the owner string is the
      // parallel-track key, so editing it re-parallelizes immediately.
      setProjects((prev) =>
        prev.map((p) => (p.id === id ? { ...p, owner: value, assigneeId: assignee } : p)),
      );
      try {
        await adapter.updateField(id, 'owner', value);
      } catch {
        setProjects(snapshot);
        toast.error('Failed to update owner');
      }
      return;
    }

    if (field === 'startDate' || field === 'endDate') {
      const iso = value ? new Date(value + 'T00:00:00.000Z').toISOString() : null;
      const snapshot = projects;
      setProjects((prev) => prev.map((p) => (p.id === id ? { ...p, [field]: iso } : p)));
      const result = await adapter.saveSchedule(id, { [field]: iso });
      if (!result.ok) { setProjects(snapshot); toast.error('Failed to update date'); }
      return;
    }

    if (field === 'durationCode') {
      const code = value.trim() === '' ? null : value.trim();
      const snapshot = projects;
      setProjects((prev) => prev.map((p) => (p.id === id ? { ...p, durationCode: code } : p)));
      const result = await adapter.saveSchedule(id, { durationCode: code });
      if (!result.ok) { setProjects(snapshot); toast.error('Failed to update duration'); }
      return;
    }

    // Custom column field value (e.g. the Size column).
    const snapshot = projects;
    if (sizeColumn && field === sizeColumn.id) {
      const weeks = (config.sizeDurations as Record<string, number>)[value] ?? null;
      setProjects((prev) =>
        prev.map((p) =>
          p.id === id ? { ...p, sizeLabel: value || null, sizeWeeks: weeks } : p,
        ),
      );
    }
    try {
      await adapter.updateField(id, field, value);
    } catch {
      setProjects(snapshot);
      toast.error('Failed to update field');
    }
  };

  const handleDragMove = (event: DragMoveEvent) => {
    const id = String(event.active.id);
    const bar = schedule.get(id);
    if (!bar) return;
    const x = dateToX(bar.startDate, viewStart) + event.delta.x;
    const date = snapToDay(xToDate(x, viewStart));
    setOverlay({ x, date });
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setOverlay({ x: null, date: null });
    const { active, over, delta } = event;
    const activeId = String(active.id);
    const activeGroupId = (active.data.current?.groupId as string | null) ?? null;
    const overGroupId = over ? String(over.id) : null;

    const result = classifyDrag({
      activeId,
      activeGroupId,
      overGroupId,
      delta,
      rowHeight: ASSIGNEE_ROW_HEIGHT,
    });

    switch (result.kind) {
      case 'group-move':
        void handleGroupMove(result.id, result.targetGroupId);
        break;

      case 'move':
        void handleHorizontalDrag(result.id, result.deltaX);
        break;

      case 'reorder': {
        const project = projects.find((p) => p.id === result.id);
        if (!project) break;

        const siblings = projects
          .filter((p) => p.groupId === project.groupId && p.assigneeId === project.assigneeId)
          .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

        const currentIndex = siblings.findIndex((p) => p.id === result.id);
        const shift = Math.round(result.deltaY / ASSIGNEE_ROW_HEIGHT);
        const targetIndex = Math.max(0, Math.min(siblings.length - 1, currentIndex + shift));

        if (targetIndex === currentIndex) break;

        // NOTE: approximation — reuses the displaced sibling's order value
        // rather than a full atomic re-index. Good enough for MVP.
        const targetSibling = siblings[targetIndex];
        const newOrder = targetSibling.order ?? targetIndex;
        void handleReorder(result.id, newOrder);
        break;
      }

      case 'none':
        break;
    }
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (projects.length === 0) {
    return (
      <div style={{ padding: 64, textAlign: 'center', color: '#64748b', fontSize: 14 }}>
        Add items on the Board tab to see them here.
      </div>
    );
  }

  if (computing) {
    return <RoadmapProgressBar progress={progress} count={projects.length} />;
  }

  const openProject = openId ? projects.find((p) => p.id === openId) : null;

  // Build a typed object for ItemDetailPanel from the fields we have.
  // TODO: enrich roadmap payload with full project fields
  const detailProject = openProject
    ? ({
        id: openProject.id,
        name: openProject.name,
        status: openProject.status as Parameters<typeof ItemDetailPanel>[0]['project']['status'],
        ownerId: null,
        owner: openProject.owner,
        statusId: null,
        description: null,
        updatedAt: new Date().toISOString(),
        jiraKey: null,
        githubIssueId: null,
        githubRepoFullName: null,
        adoWorkItemId: null,
        adoProject: null,
        startDate: openProject.startDate,
        endDate: openProject.endDate,
        durationCode: openProject.durationCode,
        // Seed the Size dropdown with the current value so it shows selected.
        fieldValues:
          sizeColumn && openProject.sizeLabel
            ? { [sizeColumn.id]: openProject.sizeLabel }
            : {},
      } as unknown as Parameters<typeof ItemDetailPanel>[0]['project'])
    : null;

  return (
    <>
      <DndContext sensors={sensors} onDragMove={handleDragMove} onDragEnd={handleDragEnd}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {/* Toolbar */}
          {canEdit && (
            <div style={{ display: 'flex', justifyContent: 'flex-end', position: 'relative' }}>
              <button
                type="button"
                onClick={() => setShowSettings((v) => !v)}
                aria-expanded={showSettings}
                style={{
                  padding: '5px 12px',
                  fontSize: 13,
                  fontWeight: 600,
                  background: '#ffffff',
                  border: '1px solid #cbd5e1',
                  borderRadius: 8,
                  color: '#334155',
                  cursor: 'pointer',
                }}
              >
                Settings
              </button>
              {showSettings && (
                <div
                  style={{
                    position: 'absolute',
                    top: 38,
                    right: 0,
                    zIndex: 20,
                    background: '#fff',
                    border: '1px solid #e2e8f0',
                    borderRadius: 12,
                    boxShadow: '0 10px 30px rgba(15,23,42,0.12)',
                  }}
                >
                  <RoadmapSettings
                    config={{
                      startDate: config.startDate,
                      visibleQuarters: config.visibleQuarters,
                      sizeDurations: config.sizeDurations,
                      defaultSizeWeeks: config.defaultSizeWeeks,
                    }}
                    groups={[...initial.groups]
                      .sort((a, b) => a.position - b.position)
                      .map((g) => ({ id: g.id, name: g.name, color: g.color }))}
                    hiddenGroupIds={config.hiddenGroupIds}
                    onChange={handleSettingsChange}
                  />
                </div>
              )}
            </div>
          )}

          {/* Scroll region */}
          <div
            style={{
              overflow: 'auto',
              maxHeight: 'calc(100vh - 180px)',
              border: '1px solid #e2e8f0',
              borderRadius: 12,
              background: '#ffffff',
            }}
          >
            <RoadmapHeader
              quarters={quarters}
              timelineWidth={tlWidth}
              visibleQuarters={visibleQuarters}
              onChangeVisibleQuarters={setVisibleQuarters}
            />

            <div style={{ position: 'relative', width: LANE_LABEL_WIDTH + tlWidth }}>
              {/* Quarter gridlines (behind the translucent lanes) */}
              {quarters.map((q, i) =>
                i === 0 ? null : (
                  <div
                    key={q.label}
                    aria-hidden
                    style={{
                      position: 'absolute',
                      top: 0,
                      bottom: 0,
                      left: LANE_LABEL_WIDTH + q.x,
                      width: 1,
                      background: '#eef2f7',
                      zIndex: 0,
                    }}
                  />
                ),
              )}

              <TodayLine viewStart={viewStart} />

              <DragDateOverlay
                x={overlay.x}
                date={overlay.date}
                laneLabelWidth={LANE_LABEL_WIDTH}
                height={visibleGroups.length > 0 ? 4000 : 0}
              />

              {visibleGroups.length === 0 ? (
                <div style={{ padding: 48, textAlign: 'center', color: '#64748b', fontSize: 14 }}>
                  All groups hidden — enable one in Settings.
                </div>
              ) : (
                visibleGroups.map((g) => (
                  <RoadmapGroupLane
                    key={g.id}
                    group={g}
                    projects={projects.filter((p) => p.groupId === g.id)}
                    schedule={schedule}
                    viewStart={viewStart}
                    timelineWidth={tlWidth}
                    readOnly={!canEdit}
                    onOpen={setOpenId}
                    onRename={handleRename}
                    onResize={handleResize}
                    onResizePreview={(x, date) => setOverlay({ x, date })}
                  />
                ))
              )}
            </div>
          </div>
        </div>
      </DndContext>

      {detailProject && (
        <ItemDetailPanel
          project={detailProject}
          columns={openId ? adapter.columnsFor(openId) : columns}
          boardId={openId ? adapter.boardIdFor(openId) : boardId}
          owners={owners}
          defaultTab="details"
          onClose={() => setOpenId(null)}
          onSave={(field, value) => {
            void handleDetailSave(field, value);
          }}
        />
      )}
    </>
  );
}

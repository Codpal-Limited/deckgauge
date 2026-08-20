'use client';

import { useEffect, useMemo, useState } from 'react';
import type { BoardColumn, RoadmapDetail } from '@deckgauge/shared';
import { canEditEntity } from '@deckgauge/shared';
import { RoadmapCanvas, type RoadmapViewPayloadShape } from '../roadmap/RoadmapCanvas';
import { loadBoardColumns } from '../../actions/roadmap';
import { createRoadmapAdapter } from './roadmap-entity-adapter';

interface Props {
  roadmap: RoadmapDetail;
}

export default function RoadmapEntityCanvas({ roadmap }: Props) {
  // An ALLOWLIST (`canEditEntity`), not `role !== 'VIEWER'`: today
  // `getBoardRole` hands this a phantom `'OWNER'` (never null), so the two
  // forms behave identically now. But `roadmap.role` is a real, nullable
  // role once roadmap sharing lands — `null !== 'VIEWER'` is `true`, so the
  // negative form would fail OPEN on a lookup failure. `canEditEntity` is the
  // allowlist that stays safe when that day comes.
  const canEdit = canEditEntity(roadmap.role);

  // itemId → home boardId, and the set of distinct boards to load columns for.
  const boardByItem = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of roadmap.groups) for (const it of g.items) m.set(it.id, it.boardId);
    return m;
  }, [roadmap.groups]);

  const boardIds = useMemo(
    () => Array.from(new Set(boardByItem.values())),
    [boardByItem],
  );

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

  // Map the resolved roadmap into the shape RoadmapCanvas consumes. Lane labels
  // include the group's home board so cross-board origin stays visible.
  const initial: RoadmapViewPayloadShape = useMemo(
    () => ({
      config: roadmap.ganttConfig,
      groups: roadmap.groups.map((g) => ({
        id: g.groupId,
        name: `${g.name} · ${g.boardName}`,
        color: g.color,
        position: g.position,
      })),
      projects: roadmap.groups.flatMap((g) =>
        g.items.map((it) => ({
          id: it.id,
          name: it.name,
          status: it.status,
          groupId: it.groupId,
          order: it.order,
          // Parallel-track key per the board roadmap: structured BoardOwner id
          // if present, else the trimmed owner string (boards run in legacy
          // owner-string mode, so ownerId is null and the string is the key).
          // Without the string fallback every item shares one lane.
          assigneeId: it.ownerId ?? (it.owner.trim().length > 0 ? it.owner.trim() : null),
          owner: it.owner,
          sizeLabel: it.sizeLabel,
          sizeWeeks: it.sizeWeeks,
          startDate: it.startDate,
          endDate: it.endDate,
          durationCode: it.durationCode,
        })),
      ),
    }),
    [roadmap.ganttConfig, roadmap.groups],
  );

  // All represented boards' columns flattened — canvas fallback for the detail
  // panel; the adapter scopes columns per item via columnsFor.
  const allColumns = useMemo(() => Array.from(columnsByBoard.values()).flat(), [columnsByBoard]);

  return (
    <RoadmapCanvas
      boardId=""
      initial={initial}
      columns={allColumns}
      canEdit={canEdit}
      adapter={adapter}
    />
  );
}

import type {
  BoardFolderDTO,
  UserBoardPrefDTO,
  UserRoadmapPrefDTO,
  BoardSummary,
  RoadmapSummary,
  BoardTree,
  BoardNodeData,
  RoadmapNodeData,
  FolderNodeData,
  SidebarNode,
} from './board-tree-schemas.js';

const NO_PREF_POSITION = Number.MAX_SAFE_INTEGER;

function byPositionThenName(
  a: { position: number; name: string },
  b: { position: number; name: string },
): number {
  if (a.position !== b.position) return a.position - b.position;
  return a.name.localeCompare(b.name);
}

/**
 * Assemble the per-user folder tree + board + roadmap placements into the render tree.
 * Pure and deterministic — the unit-tested core of the sidebar.
 */
export function buildBoardTree(
  folders: BoardFolderDTO[],
  prefs: UserBoardPrefDTO[],
  boards: BoardSummary[],
  roadmaps: RoadmapSummary[] = [],
  roadmapPrefs: UserRoadmapPrefDTO[] = [],
): BoardTree {
  const folderIds = new Set(folders.map((f) => f.id));
  const prefByBoard = new Map(prefs.map((p) => [p.boardId, p]));
  const prefByRoadmap = new Map(roadmapPrefs.map((p) => [p.roadmapId, p]));

  // Normalize each accessible board into a BoardNodeData using its pref (or defaults).
  const boardNodes: BoardNodeData[] = boards.map((b) => {
    const p = prefByBoard.get(b.id);
    const effectiveFolderId =
      p?.folderId && folderIds.has(p.folderId) ? p.folderId : null;
    return {
      kind: 'board',
      id: b.id,
      name: b.name,
      position: p ? p.position : NO_PREF_POSITION,
      isFavorite: p?.isFavorite ?? false,
      folderId: effectiveFolderId,
    };
  });

  // Normalize each accessible roadmap into a RoadmapNodeData using its pref (or defaults).
  const roadmapNodes: RoadmapNodeData[] = roadmaps.map((r) => {
    const p = prefByRoadmap.get(r.id);
    const effectiveFolderId =
      p?.folderId && folderIds.has(p.folderId) ? p.folderId : null;
    return {
      kind: 'roadmap',
      id: r.id,
      name: r.name,
      position: p ? p.position : NO_PREF_POSITION,
      isFavorite: p?.isFavorite ?? false,
      folderId: effectiveFolderId,
    };
  });

  // Merge boards and roadmaps into a single list for joint processing.
  const allNodes = [...boardNodes, ...roadmapNodes];

  // Helper to check if a node (board or roadmap) is hidden.
  const isHidden = (n: { kind: string; id: string }): boolean =>
    n.kind === 'roadmap'
      ? prefByRoadmap.get(n.id)?.isHidden ?? false
      : prefByBoard.get(n.id)?.isHidden ?? false;

  const hidden = allNodes
    .filter((n) => isHidden(n))
    .sort((a, b) => byPositionThenName(a, b));

  const favorites = allNodes
    .filter((n) => n.isFavorite && !isHidden(n))
    .sort((a, b) => byPositionThenName(a, b));

  const visible = allNodes.filter((n) => !isHidden(n));

  // Group visible nodes (boards + roadmaps) by their (validated) folderId.
  const nodesByFolder = new Map<
    string | null,
    (BoardNodeData | RoadmapNodeData)[]
  >();
  for (const n of visible) {
    const list = nodesByFolder.get(n.folderId) ?? [];
    list.push(n);
    nodesByFolder.set(n.folderId, list);
  }

  // Group folders by parentId, normalizing missing parents to top-level (null).
  const childFoldersByParent = new Map<string | null, BoardFolderDTO[]>();
  for (const f of folders) {
    const key = f.parentId && folderIds.has(f.parentId) ? f.parentId : null;
    const list = childFoldersByParent.get(key) ?? [];
    list.push(f);
    childFoldersByParent.set(key, list);
  }

  const buildLevel = (parentId: string | null): SidebarNode[] => {
    const folderNodes: FolderNodeData[] = (childFoldersByParent.get(parentId) ?? [])
      .slice()
      .sort((a, b) => byPositionThenName(a, b))
      .map((f) => ({
        kind: 'folder',
        id: f.id,
        name: f.name,
        color: f.color,
        isExpanded: f.isExpanded,
        position: f.position,
        children: buildLevel(f.id),
      }));

    const childNodes = (nodesByFolder.get(parentId) ?? [])
      .slice()
      .sort((a, b) => byPositionThenName(a, b));

    // Folders above non-folder nodes (boards + roadmaps) within a level.
    return [...folderNodes, ...childNodes];
  };

  return { favorites, tree: buildLevel(null), hidden };
}

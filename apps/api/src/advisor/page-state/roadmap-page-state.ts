import type { PrismaClient } from '@deckgauge/db';
import {
  compareOrder,
  computeSchedule,
  durationToDays,
  sizeWeeksFromLabel,
  type RoadmapDetail,
  type ScheduleGroup,
  type ScheduleProject,
  type SizeDurations,
} from '@deckgauge/shared';
import { RoadmapService } from '../../roadmaps/roadmap.service.js';
import { internalIdentifiersNote } from './page-state-notes.js';
import { unavailable, type PageStateArgs, type PageStateDeps, type PageStateResult } from './page-state.types.js';

/** A chain member after date conversion — the shape `computeSchedule` and `compareOrder` operate on. */
type ScheduledRoadmapProject = ScheduleProject & { name: string };

/** One resolved, described chain member — what the model is shown per item. */
interface ChainMemberView {
  name: string;
  order: number | null;
  startDate: string | null;
  endDate: string | null;
  widthFrom: string;
  isPinned: boolean;
  isUnsized: boolean;
}

/** A described chain, capped so a large roadmap is never dumped whole. */
interface ChainSummary {
  members: ChainMemberView[];
  totalMembers: number;
  membersTruncated: boolean;
}

// Bounds on how much a resolver call ever reports. A single roadmap
// realistically has a handful of group x owner combinations and rarely more
// than a couple dozen sequential items behind one owner in one group; these
// caps keep the common case fully visible while still bounding the payload
// (and its cost as LLM context) on an unusually large roadmap, with an
// explicit truncation flag so the model never presents a partial roadmap —
// or a partial chain — as the complete one.
const MAX_CHAINS_IN_SUMMARY = 20;
const MAX_MEMBERS_PER_CHAIN = 20;

/**
 * Where an item's width came from, in the exact precedence `resolveWidthDays`
 * applies: explicit start+end dates, else a duration code that actually
 * parses (`durationToDays`), else a pre-computed `sizeWeeks` or a size label
 * that resolves against the roadmap's `sizeDurations` (`sizeWeeksFromLabel`),
 * else the roadmap default. Reuses those two helpers rather than truthy-
 * checking the raw fields, so a malformed duration code or an unmapped size
 * label falls through to the same later tier the real scheduler would use.
 *
 * The `sizeWeeks` and size-label tiers are reported separately because they are
 * separate fields: saying "size label" when a pre-set `sizeWeeks` decided the
 * width would be a claim about a field that was never consulted. (In today's
 * production path they coincide — `RoadmapService.readDetail` derives
 * `sizeWeeks` from the size label — but the scheduler reads whichever is set,
 * and this description must stay true of the input it was actually given.)
 */
function widthProvenance(
  project: Pick<ScheduleProject, 'startDate' | 'endDate' | 'durationCode' | 'sizeLabel' | 'sizeWeeks'>,
  sizeDurations: SizeDurations,
): string {
  if (project.startDate && project.endDate) return 'explicit start and end dates';
  if (durationToDays(project.durationCode) != null) return 'duration code';
  if (project.sizeWeeks != null) return 'size in weeks';
  if (sizeWeeksFromLabel(project.sizeLabel, sizeDurations) != null) return 'size label';
  return 'the board default duration';
}

/**
 * Reads the standalone `Roadmap` entity `/roadmap/[id]` renders.
 *
 * `userId` is part of the signature because `readDetail` drops groups whose
 * board the caller cannot view, and that check is what stops the Advisor
 * becoming a way to read project rows out of boards the asker holds no role
 * on — a roadmap role is granted independently of board roles. A fake injected
 * by a test takes it too, so a test cannot accidentally exercise a shape the
 * production path does not have.
 */
type ReadRoadmapDetail = (roadmapId: string, userId: string) => Promise<RoadmapDetail>;

function defaultReadRoadmapDetail(prisma: PrismaClient): ReadRoadmapDetail {
  const service = new RoadmapService(prisma);
  // `role` only decorates `RoadmapDetail.role`, read by the UI to decide
  // whether to show edit affordances. This caller is read-only and renders
  // nothing, so it has no role of its own to supply — pass the lowest one;
  // it has no effect on what is read or returned to the model. `userId`, by
  // contrast, decides what may be read at all.
  return (roadmapId, userId) => service.readDetail(roadmapId, 'VIEWER', userId);
}

export interface RoadmapPageStateDeps extends PageStateDeps {
  /** Injected so tests need no database; defaults to the real, read-only `RoadmapService.readDetail`. */
  readRoadmapDetail?: ReadRoadmapDetail;
}

const NOTE =
  'Deckgauge has no dependency or blocked-by concept. A chain is the set of items sharing one group and one owner; within a chain, items run in board order and an item with no explicit dates starts where the previous one ended. An item with an explicit start date is pinned and pushes everything after it in its chain. This read does not re-run the reconciliation that refreshes which boards\' groups belong to the roadmap — that happens when the roadmap page itself loads — so a board subscribed or unsubscribed moments ago may not yet be reflected here.';

/**
 * Answers "why is X scheduled after Y?" from the same computation the
 * standalone roadmap's UI uses (`RoadmapEntityCanvas` -> `RoadmapCanvas` ->
 * `computeSchedule`). Sequencing is computed, not stored: `computeSchedule`
 * buckets items by group -> owner into chains, sorts each chain by board
 * order (via the scheduler's own `compareOrder`, not a re-derived
 * comparator), and walks a cursor so an undated item starts where the
 * previous one ended. An item with an explicit start date is pinned and
 * drags the cursor when it ends later. This resolver reports the chain
 * around the requested item, or a capped roadmap-wide summary — never an
 * unbounded dump.
 */
export async function resolveRoadmapPageState(
  deps: RoadmapPageStateDeps,
  args: PageStateArgs,
): Promise<PageStateResult> {
  if (!deps.roadmapId) {
    return unavailable('No roadmap is bound to this conversation, so I cannot read its schedule.');
  }

  const read = deps.readRoadmapDetail ?? defaultReadRoadmapDetail(deps.prisma);
  // `deps.userId` is the authenticated caller the route captured, so the read
  // is filtered to the boards this person may see. The roadmap id was verified
  // separately (`RoadmapService.getRole`); roadmap access alone does not imply
  // access to the boards its groups come from.
  const roadmap = await read(deps.roadmapId, deps.userId);

  const sizeDurations = roadmap.ganttConfig.sizeDurations;

  // Groups map groupId -> id, exactly like RoadmapEntityCanvas — computeSchedule
  // buckets by this `id`, and roadmap items reference groups by `groupId`.
  const groups: ScheduleGroup[] = roadmap.groups.map((g) => ({ id: g.groupId }));

  // Items are nested in groups, not a flat array — flatten them, converting
  // ISO-string dates to `Date` ourselves. RoadmapEntityCanvas leaves that
  // conversion to RoadmapCanvas/useScheduleWorker downstream; this resolver
  // has no downstream, so it converts here.
  const scheduledProjects: ScheduledRoadmapProject[] = roadmap.groups.flatMap((g) =>
    g.items.map((it) => ({
      id: it.id,
      name: it.name,
      groupId: it.groupId,
      order: it.order,
      // Parallel-track key per the standalone roadmap's own canvas: structured
      // ownerId if present, else the trimmed owner string (boards run in
      // legacy owner-string mode, so ownerId is null and the string is the
      // key). Without the string fallback every item shares one lane —
      // RoadmapEntityGantt's mistake, and not what `/roadmap/[id]` renders.
      assigneeId: it.ownerId ?? (it.owner.trim() || null),
      sizeLabel: it.sizeLabel,
      sizeWeeks: it.sizeWeeks,
      durationCode: it.durationCode,
      startDate: it.startDate ? new Date(it.startDate) : null,
      endDate: it.endDate ? new Date(it.endDate) : null,
    })),
  );

  const schedule = computeSchedule({
    groups,
    projects: scheduledProjects,
    // The persisted config, not defaults and not a now-based start — the
    // same input `RoadmapEntityCanvas` passes down.
    config: {
      startDate: new Date(roadmap.ganttConfig.startDate),
      sizeDurations,
      defaultSizeWeeks: roadmap.ganttConfig.defaultSizeWeeks,
    },
  });

  // A chain is one group + one owner: exactly how computeSchedule buckets.
  // The owner is `assigneeId` (Project.ownerId, falling back to the trimmed
  // owner string), never `Project.assignee`, which the roadmap does not read.
  const chainKey = (p: { groupId: string | null; assigneeId: string | null }) =>
    `${p.groupId ?? '__nogroup__'}::${p.assigneeId ?? '__unassigned__'}`;

  const describe = (p: ScheduledRoadmapProject): ChainMemberView => {
    const bar = schedule.get(p.id);
    return {
      name: p.name,
      order: p.order,
      startDate: bar ? bar.startDate.toISOString() : null,
      endDate: bar ? bar.endDate.toISOString() : null,
      widthFrom: widthProvenance(p, sizeDurations),
      isPinned: bar ? bar.isPinned : false,
      isUnsized: bar ? bar.isUnsized : false,
    };
  };

  // Reuse the scheduler's own ordering rather than re-deriving it: a null
  // order sorts LAST (not first), and equal orders tie-break by ascending
  // id. Get either wrong and the displayed sequence contradicts the
  // displayed dates, which come from the real scheduler.
  const sortByOrder = (members: ScheduledRoadmapProject[]): ScheduledRoadmapProject[] =>
    [...members].sort(compareOrder);

  const summarizeChain = (members: ScheduledRoadmapProject[]): ChainSummary => {
    const sorted = sortByOrder(members);
    const shown = sorted.slice(0, MAX_MEMBERS_PER_CHAIN);
    return {
      members: shown.map(describe),
      totalMembers: sorted.length,
      membersTruncated: shown.length < sorted.length,
    };
  };

  if (!args.itemName) {
    const byChain = new Map<string, ScheduledRoadmapProject[]>();
    for (const p of scheduledProjects) {
      const list = byChain.get(chainKey(p)) ?? [];
      byChain.set(chainKey(p), [...list, p]);
    }
    const allChains = Array.from(byChain.values());
    const shownChains = allChains.slice(0, MAX_CHAINS_IN_SUMMARY);
    return {
      available: true,
      page: 'roadmap',
      state: {
        chains: shownChains.map(summarizeChain),
        totalChains: allChains.length,
        chainsTruncated: shownChains.length < allChains.length,
        note: NOTE,
      },
    };
  }

  const wanted = args.itemName.trim().toLowerCase();
  const target = scheduledProjects.find((p) => p.name.trim().toLowerCase() === wanted);
  if (!target) {
    return unavailable(
      `I could not find a roadmap item named "${args.itemName}" on this roadmap, so I cannot explain its position.`,
    );
  }

  const chainSummary = summarizeChain(scheduledProjects.filter((p) => chainKey(p) === chainKey(target)));

  return {
    available: true,
    page: 'roadmap',
    state: {
      item: target.name,
      groupId: target.groupId,
      ownerId: target.assigneeId,
      chain: chainSummary.members,
      chainTotalMembers: chainSummary.totalMembers,
      chainTruncated: chainSummary.membersTruncated,
      note: NOTE,
      identifiersNote: internalIdentifiersNote('groupId and ownerId'),
    },
  };
}

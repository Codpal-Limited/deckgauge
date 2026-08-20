// Presentation helpers for the org-tree employee card. Pure + framework-free so
// they can be unit-tested without rendering. Status is derived from the same
// OrgEmployeeDto fields the old text-colour scheme used (matched / isActive /
// isVacancy / isDeparted / lastContributionAt) — the redesign just renders them
// as an avatar ring + relative-time label instead of colouring the name.

import type { RankingTier } from '@deckgauge/shared';

/** An employee's activity health, one value drives ring, dot glyph, and label. */
export type ActivityStatus = 'active' | 'idle' | 'none' | 'vacancy' | 'departed';

/** The subset of OrgEmployeeDto needed to classify activity. */
export interface ActivityInput {
  isDeparted: boolean;
  isVacancy: boolean;
  matched: boolean;
  isActive: boolean;
  lastContributionAt: string | null;
}

/** Days since the last contribution before an active person reads as "going quiet". */
export const IDLE_AFTER_DAYS = 14;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Deterministic avatar background palette — cool, indigo-biased hues that sit
 * calmly on both the light and dark org-tree surfaces.
 */
export const AVATAR_COLORS = [
  '#4f46e5',
  '#0ea371',
  '#c9820a',
  '#db4d6d',
  '#7c3aed',
  '#0891b2',
  '#2563eb',
  '#059669',
  '#be123c',
  '#6d28d9',
] as const;

/** Up-to-two-letter initials from a display name (e.g. "Priya Nandakumar" -> "PN"). */
export function getInitials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

/** Stable avatar colour for a seed string (same seed -> same colour every render). */
export function avatarColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

/** Classify an employee's activity health. Order of precedence matters. */
export function deriveActivityStatus(e: ActivityInput, now: Date = new Date()): ActivityStatus {
  if (e.isDeparted) return 'departed';
  if (e.isVacancy) return 'vacancy';
  // Mirror the legacy "emerald when matched && isActive" gate for the real signal.
  if (!e.matched || !e.isActive || !e.lastContributionAt) return 'none';
  const ageDays = (now.getTime() - new Date(e.lastContributionAt).getTime()) / MS_PER_DAY;
  return ageDays <= IDLE_AFTER_DAYS ? 'active' : 'idle';
}

function agoLabel(ageMs: number): string {
  const hours = Math.floor(ageMs / (60 * 60 * 1000));
  if (hours < 1) return 'moments ago';
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(ageMs / MS_PER_DAY);
  return `${days}d ago`;
}

function quietFor(ageMs: number): string {
  const days = Math.round(ageMs / MS_PER_DAY);
  const weeks = Math.round(days / 7);
  if (weeks < 8) return `${weeks} weeks`;
  const months = Math.round(days / 30);
  return `${months} months`;
}

/** Human-readable activity line for the card, keyed off the derived status. */
export function formatActivityLabel(
  status: ActivityStatus,
  lastContributionAt: string | null,
  now: Date = new Date(),
): string {
  if (status === 'departed' || status === 'vacancy') return '';
  if (status === 'none' || !lastContributionAt) return 'No linked activity';
  const ageMs = now.getTime() - new Date(lastContributionAt).getTime();
  return status === 'active' ? `Active ${agoLabel(ageMs)}` : `Quiet for ${quietFor(ageMs)}`;
}

// --- Leaderboard badge presentation ----------------------------------------

/** Visual treatment for an employee's rank badge, keyed off the API-computed tier. */
export interface RankBadgeView {
  /** Leading glyph (medal / star) or null for the plain numeric tiers. */
  emoji: string | null;
  /** Short chip text, e.g. "#1" or "Top 10%". */
  label: string;
  /** Tailwind colour classes appended to the shared chip base. */
  className: string;
}

const TIER_STYLE: Record<RankingTier, { emoji: string | null; className: string }> = {
  gold: { emoji: '🏆', className: 'border-amber-300 bg-amber-50 text-amber-700' },
  silver: { emoji: '🥈', className: 'border-slate-300 bg-slate-100 text-slate-600' },
  bronze: { emoji: '🥉', className: 'border-orange-300 bg-orange-50 text-orange-700' },
  top10: { emoji: '⭐', className: 'border-indigo-200 bg-indigo-50 text-indigo-700' },
  top25: { emoji: null, className: 'border-slate-200 bg-slate-50 text-slate-600' },
  rest: { emoji: null, className: 'border-slate-200 bg-white text-slate-500' },
};

/**
 * Badge for a 1-based rank + tier. The top three carry a medal beside their rank
 * number; percentile tiers read as "Top 10%" / "Top 25%"; everyone else shows a
 * plain "#N".
 */
export function rankBadgeView(ranking: { rank: number; tier: RankingTier }): RankBadgeView {
  const style = TIER_STYLE[ranking.tier];
  const label =
    ranking.tier === 'top10' ? 'Top 10%' : ranking.tier === 'top25' ? 'Top 25%' : `#${ranking.rank}`;
  return { emoji: style.emoji, label, className: style.className };
}

// --- Board chip overflow ----------------------------------------------------

/**
 * How many board chips a row shows before collapsing the rest into a "+N" pill.
 * The chip rail shares one row with the name/meta column, so an uncapped rail on
 * a person who sits on eight boards leaves nothing for their name.
 */
export const MAX_VISIBLE_BOARD_CHIPS = 3;

export interface BoardChipSplit<T> {
  visible: T[];
  hiddenCount: number;
  /** Comma-separated names of the hidden boards, for the overflow pill's tooltip. */
  hiddenLabel: string;
}

/** Split an employee's boards into the chips to render and a hidden remainder. */
export function splitBoardChips<T extends { boardName: string }>(
  boards: readonly T[],
  max: number = MAX_VISIBLE_BOARD_CHIPS,
): BoardChipSplit<T> {
  if (boards.length <= max) {
    return { visible: [...boards], hiddenCount: 0, hiddenLabel: '' };
  }
  const hidden = boards.slice(max);
  return {
    visible: boards.slice(0, max),
    hiddenCount: hidden.length,
    hiddenLabel: hidden.map((b) => b.boardName).join(', '),
  };
}

/** Human labels for the four ranking metrics, shown in the Ranking tab breakdown. */
export const RANKING_METRIC_LABELS = {
  ticketsClosed: 'Tickets closed',
  prsMerged: 'PRs merged',
  commitsToMain: 'Commits',
  reviewComments: 'Review comments',
} as const;

/** Format a 0–1 weight as a whole-percent string, e.g. 0.35 → "35%". */
export function formatWeight(weight: number): string {
  return `${Math.round(weight * 100)}%`;
}

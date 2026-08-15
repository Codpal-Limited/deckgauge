import { durationToDays } from './duration';

export type SizeLabel = 'XXS' | 'XS' | 'S' | 'M' | 'L' | 'XL' | 'XXL';

export const SIZE_LABELS: readonly SizeLabel[] = [
  'XXS',
  'XS',
  'S',
  'M',
  'L',
  'XL',
  'XXL',
];

export type SizeDurations = Record<SizeLabel, number>;

export const DEFAULT_SIZE_DURATIONS: SizeDurations = {
  XXS: 0.5,
  XS: 1,
  S: 2,
  M: 3,
  L: 4,
  XL: 6,
  XXL: 8,
};

export const DEFAULT_SIZE_WEEKS = 2;

export function sizeWeeksFromLabel(
  label: string | null | undefined,
  durations: SizeDurations,
): number | null {
  if (!label) return null;
  const weeks = (durations as Record<string, number>)[label];
  return typeof weeks === 'number' ? weeks : null;
}

export function addCalendarDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

export interface ScheduleConfig {
  startDate: Date;
  sizeDurations: SizeDurations;
  defaultSizeWeeks: number;
}

export interface ScheduleProject {
  id: string;
  groupId: string | null;
  order: number | null;
  assigneeId: string | null;
  sizeWeeks: number | null;
  sizeLabel: string | null;
  durationCode: string | null;
  startDate: Date | null;
  endDate: Date | null;
}

export interface ScheduleGroup {
  id: string;
}

export interface ScheduledBar {
  startDate: Date;
  endDate: Date;
  isUnsized: boolean;
  isPinned: boolean;
}

const UNASSIGNED = '__unassigned__';

export function compareOrder(a: ScheduleProject, b: ScheduleProject): number {
  const ao = a.order ?? Number.POSITIVE_INFINITY;
  const bo = b.order ?? Number.POSITIVE_INFINITY;
  if (ao !== bo) return ao - bo;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function daysBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / (24 * 60 * 60 * 1000);
}

export function resolveWidthDays(
  item: ScheduleProject,
  config: ScheduleConfig,
): number {
  if (item.startDate && item.endDate) {
    return Math.max(1, daysBetween(item.startDate, item.endDate));
  }
  const durDays = durationToDays(item.durationCode);
  if (durDays != null) return durDays;
  const weeks = item.sizeWeeks ?? sizeWeeksFromLabel(item.sizeLabel, config.sizeDurations);
  if (weeks != null) return weeks * 7;
  return config.defaultSizeWeeks * 7;
}

export function computeSchedule(input: {
  groups: ScheduleGroup[];
  projects: ScheduleProject[];
  config: ScheduleConfig;
}): Map<string, ScheduledBar> {
  const { config } = input;
  const result = new Map<string, ScheduledBar>();

  // group -> assignee -> projects
  const byGroup = new Map<string, Map<string, ScheduleProject[]>>();
  for (const p of input.projects) {
    const gKey = p.groupId ?? UNASSIGNED;
    const aKey = p.assigneeId ?? UNASSIGNED;
    let chains = byGroup.get(gKey);
    if (!chains) {
      chains = new Map();
      byGroup.set(gKey, chains);
    }
    let chain = chains.get(aKey);
    if (!chain) {
      chain = [];
      chains.set(aKey, chain);
    }
    chain.push(p);
  }

  for (const chains of byGroup.values()) {
    for (const chain of chains.values()) {
      const sorted = [...chain].sort(compareOrder);
      let cursor = config.startDate;
      for (const task of sorted) {
        const widthDays = resolveWidthDays(task, config);
        let start: Date;
        let end: Date;
        if (task.startDate) {
          start = task.startDate;
          end = task.endDate ?? addCalendarDays(start, widthDays);
          if (end.getTime() > cursor.getTime()) cursor = end;
        } else {
          start = cursor;
          end = addCalendarDays(start, widthDays);
          cursor = end;
        }
        result.set(task.id, {
          startDate: start,
          endDate: end,
          isUnsized:
            task.sizeWeeks == null &&
            task.sizeLabel == null &&
            task.durationCode == null &&
            task.startDate == null,
          isPinned: task.startDate != null,
        });
      }
    }
  }

  return result;
}

import { z } from 'zod';
import type { RoadmapConfigPayload } from './roadmap-config';

export const SYSTEM_COLUMN_KEYS = ['title', 'size', 'startDate', 'endDate', 'duration'] as const;
export type SystemColumnKey = (typeof SYSTEM_COLUMN_KEYS)[number];

// Title is always visible — it may never be hidden.
const HideableColumnKey = z.enum(['size', 'startDate', 'endDate', 'duration']);

export const RoadmapAccessRoleEnum = z.enum(['OWNER', 'EDITOR', 'VIEWER']);
export type RoadmapAccessRoleValue = z.infer<typeof RoadmapAccessRoleEnum>;

export const CreateRoadmapInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).optional(),
});
export type CreateRoadmapInput = z.infer<typeof CreateRoadmapInputSchema>;

export const UpdateRoadmapInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(2000).nullish(),
    hiddenSystemColumns: z.array(HideableColumnKey).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' });
export type UpdateRoadmapInput = z.infer<typeof UpdateRoadmapInputSchema>;

export const AddGroupsInputSchema = z.object({
  groupIds: z.array(z.string().uuid()).min(1),
});
export type AddGroupsInput = z.infer<typeof AddGroupsInputSchema>;

export const AddSubscriptionInputSchema = z.object({
  boardId: z.string().uuid(),
});
export type AddSubscriptionInput = z.infer<typeof AddSubscriptionInputSchema>;

export const ReorderRoadmapGroupsInputSchema = z.object({
  orderedGroupIds: z.array(z.string().uuid()).min(1),
});
export type ReorderRoadmapGroupsInput = z.infer<typeof ReorderRoadmapGroupsInputSchema>;

// ---- Resolved payload DTOs (output of getRoadmap, Phase 6) ----
export interface RoadmapItem {
  id: string;
  name: string;
  boardId: string;
  groupId: string;
  status: string;
  statusId: string | null;
  ownerId: string | null;
  owner: string;
  order: number | null;
  sizeLabel: string | null;
  sizeWeeks: number | null;
  startDate: string | null;
  endDate: string | null;
  durationCode: string | null;
}

export interface RoadmapGroupResolved {
  groupId: string;
  name: string;
  color: string;
  position: number;
  boardId: string;
  boardName: string;
  items: RoadmapItem[];
}

export interface RoadmapSummary {
  id: string;
  name: string;
}

export interface RoadmapDetail {
  id: string;
  name: string;
  description: string | null;
  hiddenSystemColumns: SystemColumnKey[];
  role: RoadmapAccessRoleValue;
  groups: RoadmapGroupResolved[];
  ganttConfig: RoadmapConfigPayload;
}

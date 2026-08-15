// GitHub sync tiering. Moved here from the worker so the API can share it.
export type Tier = 'hot' | 'warm' | 'cold';

export function computeTier(lastPushedAt: Date | null): Tier {
  if (!lastPushedAt) return 'cold';
  const days = (Date.now() - lastPushedAt.getTime()) / 86_400_000;
  if (days <= 7) return 'hot';
  if (days <= 90) return 'warm';
  return 'cold';
}

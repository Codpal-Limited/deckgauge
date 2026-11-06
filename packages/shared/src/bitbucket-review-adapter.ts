// Bitbucket PR review rows → cockpit.bitbucket_reviews (72_bitbucket_reviews.sql;
// gitlab_reviews keyed by repo_full_name + pr_id, plus reviewer_uuid). State is
// upper-case like GitHub's (APPROVED | COMMENTED), as the table documents.
//
// Bitbucket has no "review" object. What it has, on `/pullrequests/{id}/activity`,
// is `approval` events and `comment` events — and in practice reviews here are
// approvals almost exclusively (~1 approval and ~0.03 comments per PR on the
// workspace this was grounded on). So one row per non-author reviewer:
// 'APPROVED' if they approved at any point, otherwise 'COMMENTED';
// submitted_at = their EARLIEST approval-or-comment.
import { chDateTimeRequired } from './clickhouse-datetime.js';

export type BitbucketReviewRow = {
  id: string;
  repo_full_name: string;
  instance_id: string;
  pr_id: number;
  pr_author_username: string;
  reviewer_username: string;
  reviewer_uuid: string | null;
  reviewer_name: string | null;
  state: 'APPROVED' | 'COMMENTED';
  comment_count: number;
  submitted_at: string;
};

export interface BuildBitbucketReviewsInput {
  repoFullName: string;
  instanceId: string;
  prId: number;
  prAuthorUsername: string;
  approvals: Array<{ username: string; uuid: string | null; name: string | null; date: string }>;
  comments: Array<{ username: string; uuid: string | null; name: string | null; createdAt: string }>;
}

export function buildBitbucketReviews(input: BuildBitbucketReviewsInput): BitbucketReviewRow[] {
  type Acc = {
    uuid: string | null;
    name: string | null;
    approved: boolean;
    comments: number;
    earliest: number;
  };
  const byReviewer = new Map<string, Acc>();

  const touch = (username: string, uuid: string | null, name: string | null, at: string): Acc | null => {
    if (username === input.prAuthorUsername) return null;
    const t = Date.parse(at);
    let acc = byReviewer.get(username);
    if (!acc) {
      acc = { uuid, name, approved: false, comments: 0, earliest: Number.POSITIVE_INFINITY };
      byReviewer.set(username, acc);
    }
    if (acc.name === null && name !== null) acc.name = name;
    if (acc.uuid === null && uuid !== null) acc.uuid = uuid;
    if (!Number.isNaN(t) && t < acc.earliest) acc.earliest = t;
    return acc;
  };

  for (const a of input.approvals) {
    const acc = touch(a.username, a.uuid, a.name, a.date);
    if (acc) acc.approved = true;
  }
  for (const c of input.comments) {
    const acc = touch(c.username, c.uuid, c.name, c.createdAt);
    if (acc) acc.comments += 1;
  }

  const rows: BitbucketReviewRow[] = [];
  for (const [username, acc] of byReviewer) {
    rows.push({
      id: `${input.repoFullName}#${input.prId}#${username}`,
      repo_full_name: input.repoFullName,
      instance_id: input.instanceId,
      pr_id: input.prId,
      pr_author_username: input.prAuthorUsername,
      reviewer_username: username,
      reviewer_uuid: acc.uuid,
      reviewer_name: acc.name,
      state: acc.approved ? 'APPROVED' : 'COMMENTED',
      comment_count: acc.comments,
      submitted_at: chDateTimeRequired(Number.isFinite(acc.earliest) ? new Date(acc.earliest) : null),
    });
  }
  return rows;
}

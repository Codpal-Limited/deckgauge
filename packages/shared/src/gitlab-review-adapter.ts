// EI-0xx — GitLab MR review row shape (parity with GitHubReviewRow).
import { chDateTimeRequired } from './clickhouse-datetime.js';

export type GitLabReviewRow = {
  id: string;
  project_path: string;
  instance_id: string;
  merge_request_iid: number;
  mr_author_username: string;
  reviewer_username: string;
  reviewer_name: string | null;
  state: string;
  comment_count: number;
  submitted_at: string;
};

export interface BuildGitLabReviewsNote {
  system: boolean;
  body: string;
  authorUsername: string;
  authorName?: string | null;
  createdAt: string;
}

export interface BuildGitLabReviewsInput {
  projectPath: string;
  instanceId: string;
  mrIid: number;
  mrAuthorUsername: string;
  approvedBy: Array<{ username: string; name?: string | null }>;
  notes: BuildGitLabReviewsNote[];
}

const APPROVAL_NOTE_RE = /approved this merge request/i;

// Derives one GitLabReviewRow per reviewer (excluding the MR author) from the
// approvals + notes the PR adapter already fetches per MR — no extra API
// calls. A reviewer is 'approved' if they appear in `approvedBy` or left a
// system note matching the GitLab "approved this merge request" activity
// note; otherwise 'commented'.
export function buildGitLabReviews(input: BuildGitLabReviewsInput): GitLabReviewRow[] {
  type ReviewerAcc = {
    name: string | null;
    commentCount: number;
    approved: boolean;
    earliestAt: string | null;
  };
  const byReviewer = new Map<string, ReviewerAcc>();

  const getOrCreate = (username: string, name: string | null | undefined): ReviewerAcc => {
    const existing = byReviewer.get(username);
    if (existing) return existing;
    const created: ReviewerAcc = {
      name: name ?? null,
      commentCount: 0,
      approved: false,
      earliestAt: null,
    };
    byReviewer.set(username, created);
    return created;
  };

  for (const approver of input.approvedBy) {
    if (approver.username === input.mrAuthorUsername) continue;
    const acc = getOrCreate(approver.username, approver.name);
    acc.approved = true;
  }

  for (const note of input.notes) {
    if (note.authorUsername === input.mrAuthorUsername) continue;
    const isApprovalNote = note.system && APPROVAL_NOTE_RE.test(note.body);
    if (note.system && !isApprovalNote) continue;

    const acc = getOrCreate(note.authorUsername, note.authorName);
    if (isApprovalNote) {
      acc.approved = true;
    } else {
      acc.commentCount += 1;
    }
    if (acc.earliestAt === null || Date.parse(note.createdAt) < Date.parse(acc.earliestAt)) {
      acc.earliestAt = note.createdAt;
    }
  }

  const rows: GitLabReviewRow[] = [];
  for (const [username, acc] of byReviewer) {
    if (username === input.mrAuthorUsername) continue;
    rows.push({
      id: `${input.projectPath}#${input.mrIid}#${username}`,
      project_path: input.projectPath,
      instance_id: input.instanceId,
      merge_request_iid: input.mrIid,
      mr_author_username: input.mrAuthorUsername,
      reviewer_username: username,
      reviewer_name: acc.name,
      state: acc.approved ? 'approved' : 'commented',
      comment_count: acc.commentCount,
      submitted_at: chDateTimeRequired(acc.earliestAt),
    });
  }
  return rows;
}

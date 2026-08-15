'use client';

interface Props {
  boardId: string;
  reason: string;
}

interface Copy {
  headline: string;
  body: string;
  // When false, the CTA is a muted "Check Sources tab" link instead of the
  // primary "Open Sources tab" connect prompt. Used for reasons where a source
  // IS already connected (e.g. no_sprint_data) — prompting to "connect" there
  // is exactly the misleading message this component exists to fix.
  connect: boolean;
}

const GENERIC: Copy = {
  headline: 'No source connected',
  body: 'Connect a source to populate this metric.',
  connect: true,
};

// Keyed by the `emptyReason` values returned from
// apps/api/src/widgets/widget-data.service.ts. An unrecognised reason falls
// back to GENERIC so a future API reason never renders a blank widget.
const REASON_COPY: Record<string, Copy> = {
  no_source: GENERIC,
  no_issue_source: {
    headline: 'No issue source connected',
    body: 'Connect Jira or Azure DevOps work items.',
    connect: true,
  },
  no_pr_source: {
    headline: 'No pull-request source connected',
    body: 'Connect GitHub, GitLab, or Azure DevOps.',
    connect: true,
  },
  no_commit_source: {
    headline: 'No commit source connected',
    body: 'Connect GitHub, GitLab, or Azure DevOps.',
    connect: true,
  },
  no_review_source: {
    headline: 'No code-review source connected',
    body: 'Connect GitHub, GitLab, or Azure DevOps.',
    connect: true,
  },
  no_github_source: {
    headline: 'GitHub required',
    body: 'This metric needs a GitHub source.',
    connect: true,
  },
  no_code_source: {
    headline: 'No code source connected',
    body: 'Connect GitHub, GitLab, or Azure DevOps (PRs or commits).',
    connect: true,
  },
  no_sprintable_source: {
    headline: 'No sprint source connected',
    body: 'Connect Jira to track sprints.',
    connect: true,
  },
  no_sprint_data: {
    headline: 'No sprints synced yet',
    body: 'A source is connected, but no sprints have synced yet.',
    connect: false,
  },
};

// Per-widget empty UI. Shown when useWidgetData returns an `emptyReason`.
// Explains *which kind* of source is missing (rather than a generic "connect a
// source", which misleads when other kinds are already connected) and links to
// this board's Sources tab with an absolute, board-scoped path.
export function WidgetEmptyState({ boardId, reason }: Props) {
  const copy = REASON_COPY[reason] ?? GENERIC;
  const href = `/boards/${boardId}/sources`;

  return (
    <div role="status" className="flex flex-col items-center justify-center h-full p-3 text-center">
      <svg
        className="w-6 h-6 text-slate-300 mb-1.5"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={1.5}
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244"
        />
      </svg>
      <p className="text-xs font-medium text-slate-700">{copy.headline}</p>
      <p className="text-[11px] text-slate-500 mt-0.5">{copy.body}</p>
      {copy.connect ? (
        <a
          href={href}
          className="mt-2 inline-flex items-center gap-1 rounded border border-slate-300 px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50"
        >
          Open Sources tab
          <span aria-hidden="true">→</span>
        </a>
      ) : (
        <a href={href} className="mt-1.5 text-[11px] text-slate-400 underline hover:text-slate-600">
          Check Sources tab
        </a>
      )}
    </div>
  );
}

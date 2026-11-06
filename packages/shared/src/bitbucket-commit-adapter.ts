// Bitbucket Cloud commits → cockpit.bitbucket_commits (71_bitbucket_commits.sql:
// gitlab_commits renamed for Bitbucket, plus author_username / author_uuid so
// commits can be attributed to the same login the PR rows use).
//
// `/commits/{branch}` has no `since` parameter and returns history in
// TOPOLOGICAL order, not date order: a months-old commit merged last week sits
// between this week's commits. So the watermark is applied per row (older rows
// dropped) and pagination stops only once a WHOLE page predates it — stopping
// at the first old row would lose every newer commit behind a merge.
//
// Bitbucket's list endpoint carries no line stats, and fetching a diffstat per
// commit would multiply request volume by the commit count; additions /
// deletions / changed_files stay 0 like the GitLab adapter's changed_files.
import { detectAiAssistance } from './ai-detection.js';
import { extractTicketKeys } from './ticket-link-extractor.js';
import { chDateTime } from './clickhouse-datetime.js';
import { bitbucketRepoPath, type BitbucketClient } from './bitbucket-api.js';

export interface BitbucketCommitFetchOpts {
  repoFullName: string;
  /** Branch to walk — normally the repo's main branch. */
  branch: string;
  since?: Date;
  ticketPrefixes?: string[];
  pageLen?: number;
  maxPages?: number;
}

export interface BitbucketCommitRow {
  id: string;
  sha: string;
  repo_full_name: string;
  instance_id: string;
  author_name: string;
  author_email: string;
  author_username: string | null;
  author_uuid: string | null;
  committer_name: string;
  message: string;
  message_subject: string;
  additions: number;
  deletions: number;
  changed_files: number;
  pr_id: number | null;
  is_merge_commit: 0 | 1;
  committed_at: string;
  ai_assisted: 0 | 1;
  ai_confidence: number | null;
  ai_signals: string;
  linked_ticket_keys: string[];
}

export interface BitbucketCommitPort {
  fetchCommits(opts: BitbucketCommitFetchOpts): Promise<BitbucketCommitRow[]>;
  streamCommits(opts: BitbucketCommitFetchOpts): AsyncGenerator<BitbucketCommitRow[]>;
}

export interface BitbucketCommitAdapterConfig {
  client: BitbucketClient;
  instanceId: string;
}

interface RawCommit {
  hash: string;
  date: string;
  message?: string | null;
  author?: {
    raw?: string | null;
    user?: { nickname?: string | null; uuid?: string | null; display_name?: string | null } | null;
  } | null;
  parents?: Array<{ hash: string }>;
}

/** `"Name <email>"` → `{ name, email }`; a bare string is all name. */
export function parseBitbucketAuthorRaw(raw: string): { name: string; email: string } {
  const m = /^(.*?)\s*<([^>]*)>\s*$/.exec(raw);
  if (!m) return { name: raw.trim(), email: '' };
  return { name: (m[1] ?? '').trim(), email: (m[2] ?? '').trim() };
}

export class BitbucketCommitAdapter implements BitbucketCommitPort {
  private readonly client: BitbucketClient;
  private readonly instanceId: string;

  constructor(cfg: BitbucketCommitAdapterConfig) {
    this.client = cfg.client;
    this.instanceId = cfg.instanceId;
  }

  async *streamCommits(opts: BitbucketCommitFetchOpts): AsyncGenerator<BitbucketCommitRow[]> {
    const path = `${bitbucketRepoPath(opts.repoFullName)}/commits/${encodeURIComponent(opts.branch)}`;
    const sinceMs = opts.since?.getTime();
    const prefixes = opts.ticketPrefixes ?? [];

    for await (const page of this.client.paginate<RawCommit>(
      path,
      { pagelen: String(opts.pageLen ?? 100) },
      { maxPages: opts.maxPages ?? 200 },
    )) {
      const fresh =
        sinceMs === undefined ? page : page.filter((c) => !(Date.parse(c.date) < sinceMs));
      if (fresh.length > 0) {
        yield fresh.map((c) => this.transform(opts.repoFullName, c, prefixes, opts.branch));
      }
      if (sinceMs !== undefined && page.length > 0 && fresh.length === 0) break;
    }
  }

  async fetchCommits(opts: BitbucketCommitFetchOpts): Promise<BitbucketCommitRow[]> {
    const rows: BitbucketCommitRow[] = [];
    for await (const batch of this.streamCommits(opts)) rows.push(...batch);
    return rows;
  }

  private transform(
    repoFullName: string,
    raw: RawCommit,
    prefixes: string[],
    branch: string,
  ): BitbucketCommitRow {
    const message = raw.message ?? '';
    const { name, email } = parseBitbucketAuthorRaw(raw.author?.raw ?? '');
    const authorName = name || raw.author?.user?.display_name || '';
    const ai = detectAiAssistance({ commitMessage: message, branchName: branch });
    return {
      id: `${repoFullName}@${raw.hash}`,
      sha: raw.hash,
      repo_full_name: repoFullName,
      instance_id: this.instanceId,
      author_name: authorName,
      author_email: email,
      author_username: raw.author?.user?.nickname ?? null,
      author_uuid: raw.author?.user?.uuid ?? null,
      // Bitbucket's commit object exposes no committer; the author stands in.
      committer_name: authorName,
      message,
      message_subject: message.split('\n', 1)[0] ?? '',
      additions: 0,
      deletions: 0,
      changed_files: 0,
      pr_id: null,
      is_merge_commit: (raw.parents?.length ?? 0) > 1 ? 1 : 0,
      committed_at: chDateTime(raw.date) ?? '',
      ai_assisted: ai.aiAssisted ? 1 : 0,
      ai_confidence: ai.confidence,
      ai_signals: JSON.stringify(ai.signals),
      linked_ticket_keys: extractTicketKeys({
        text: message,
        branchName: branch,
        prefixes,
        source: 'bitbucket',
      }),
    };
  }
}

export class FakeBitbucketCommitAdapter implements BitbucketCommitPort {
  constructor(private readonly seed: BitbucketCommitRow[]) {}
  async fetchCommits(_opts: BitbucketCommitFetchOpts) {
    return this.seed;
  }
  async *streamCommits(_opts: BitbucketCommitFetchOpts): AsyncGenerator<BitbucketCommitRow[]> {
    yield this.seed;
  }
}

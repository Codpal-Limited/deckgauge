import { z } from 'zod';

/**
 * A link to ONE item in a connected source — what a user pastes into the
 * board's "Source link" field to pull that item onto the board.
 *
 * Only the providers whose items become board rows are recognised: Jira
 * issues, GitHub issues and Azure DevOps work items. GitLab and Bitbucket feed
 * intelligence only, and a GitHub pull request is not a board item.
 *
 * Parsing is purely syntactic. Whether the link belongs to a source attached
 * to the board is decided by the API against the board's connections.
 */
export type ParsedSourceItemLink =
  | { provider: 'jira'; host: string; issueKey: string }
  | { provider: 'github'; host: string; repoFullName: string; number: number }
  | { provider: 'ado'; orgKey: string; workItemId: number };

const JIRA_KEY_RE = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;
const POSITIVE_INT_RE = /^[1-9]\d*$/;

export function parseSourceItemLink(raw: string): ParsedSourceItemLink | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;

  const host = url.hostname.toLowerCase();
  const segments = url.pathname
    .split('/')
    .filter(Boolean)
    .map((s) => safeDecode(s));

  return parseAdo(host, segments, url) ?? parseGitHub(host, segments) ?? parseJira(host, segments, url);
}

function parseJira(host: string, segments: string[], url: URL): ParsedSourceItemLink | null {
  const selected = url.searchParams.get('selectedIssue');
  if (selected && JIRA_KEY_RE.test(selected)) {
    return { provider: 'jira', host, issueKey: selected.toUpperCase() };
  }
  // `/browse/PROJ-1`, and the newer `/jira/.../issues/PROJ-1` issue view.
  for (let i = 0; i < segments.length - 1; i++) {
    if (segments[i] !== 'browse' && segments[i] !== 'issues') continue;
    const candidate = segments[i + 1]!;
    if (JIRA_KEY_RE.test(candidate)) {
      return { provider: 'jira', host, issueKey: candidate.toUpperCase() };
    }
  }
  return null;
}

function parseGitHub(host: string, segments: string[]): ParsedSourceItemLink | null {
  // owner / repo / issues / number — on github.com or a GitHub Enterprise host.
  if (segments.length < 4 || segments[2] !== 'issues') return null;
  const [owner, repo, , num] = segments as [string, string, string, string];
  if (!POSITIVE_INT_RE.test(num)) return null;
  return { provider: 'github', host, repoFullName: `${owner}/${repo}`, number: Number(num) };
}

function parseAdo(host: string, segments: string[], url: URL): ParsedSourceItemLink | null {
  let orgKey: string | null = null;
  let rest: string[] = segments;
  if (host === 'dev.azure.com') {
    if (segments.length === 0) return null;
    orgKey = segments[0]!.toLowerCase();
    rest = segments.slice(1);
  } else if (host.endsWith('.visualstudio.com')) {
    orgKey = host.slice(0, -'.visualstudio.com'.length);
  } else {
    return null;
  }

  const queried = url.searchParams.get('workitem') ?? url.searchParams.get('id');
  if (queried && POSITIVE_INT_RE.test(queried)) {
    return { provider: 'ado', orgKey, workItemId: Number(queried) };
  }
  const edit = rest.indexOf('_workitems');
  if (edit !== -1 && rest[edit + 1] === 'edit') {
    const id = rest[edit + 2];
    if (id && POSITIVE_INT_RE.test(id)) {
      return { provider: 'ado', orgKey, workItemId: Number(id) };
    }
  }
  return null;
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * The web host a GitHub connection's items live on. A connection stores the
 * API base: `https://api.github.com` for github.com, `https://host/api/v3` for
 * GitHub Enterprise Server.
 */
export function githubWebHost(apiBaseUrl: string): string | null {
  try {
    const host = new URL(apiBaseUrl).hostname.toLowerCase();
    return host === 'api.github.com' ? 'github.com' : host;
  } catch {
    return null;
  }
}

/**
 * One organization, whichever of its two URL spellings a connection or a link
 * uses: `https://dev.azure.com/<org>` and the legacy `https://<org>.visualstudio.com`.
 */
export function adoOrgKey(orgUrl: string): string | null {
  try {
    const url = new URL(orgUrl);
    const host = url.hostname.toLowerCase();
    if (host === 'dev.azure.com') {
      const first = url.pathname.split('/').filter(Boolean)[0];
      return first ? first.toLowerCase() : null;
    }
    if (host.endsWith('.visualstudio.com')) return host.slice(0, -'.visualstudio.com'.length);
    return null;
  } catch {
    return null;
  }
}

/**
 * Hostname of a Jira connection's site, for matching a pasted link to it.
 */
export function jiraSiteHost(atlassianUrl: string): string | null {
  try {
    return new URL(atlassianUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

// ── Request / response ──────────────────────────────────────────────────────

export const ImportSourceLinkInputSchema = z.object({
  url: z.string().trim().min(1).max(2048),
  groupId: z.string().uuid(),
});
export type ImportSourceLinkInput = z.infer<typeof ImportSourceLinkInputSchema>;

export const ImportSourceLinkResultSchema = z.object({
  projectId: z.string(),
  name: z.string(),
  provider: z.enum(['jira', 'github', 'ado']),
  /** Source identity as the Source column shows it: `PROJ-12`, `acme/api#4`, `314`. */
  sourceRef: z.string(),
});
export type ImportSourceLinkResult = z.infer<typeof ImportSourceLinkResultSchema>;

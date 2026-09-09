// Ticket-key extractor for commit messages, PR titles/bodies, and branch names.
// Pure function — no I/O. Used by worker processors to populate the
// linked_ticket_keys column on ClickHouse PR/commit/MR rows.
// Spec: planning/ENGINEERING-INTELLIGENCE.md §7.

export type TicketSource = 'github' | 'gitlab' | 'ado';

export interface TicketLinkInput {
  text: string;
  branchName?: string;
  // Configured Board.ticketKeyPrefixes (e.g. ["ORBIT", "DOS"]).
  // When empty, no LETTERS-DIGITS extraction runs — guessing produces
  // false positives (CVE-2026, ADR-0008, SHA-256) so we refuse to guess.
  prefixes: string[];
  // When 'github', also extracts GitHub-issue references of the form
  // `#NNNN` and emits them as `gh#NNNN`. No-op for other sources today.
  source?: TicketSource;
}

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildScopedPattern(prefixes: string[]): RegExp {
  const alternation = prefixes.map(escapeForRegex).join('|');
  return new RegExp(`\\b(${alternation})-(\\d+)\\b`, 'gi');
}

// Match `#NNNN` issue refs preceded by start-of-string or a non-alphanumeric,
// non-`#` character — rejects `C#5`, `##5390`, `1#2`. The trailing `\b` rejects
// `#5390foo` because the next char would still be a word character.
const GITHUB_ISSUE_REF = /(?<![A-Za-z0-9#])#(\d+)\b/g;

function collectScoped(text: string, pattern: RegExp): string[] {
  const out: string[] = [];
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const rawPrefix = match[1];
    const num = match[2];
    if (!rawPrefix || !num) continue;
    out.push(`${rawPrefix.toUpperCase()}-${num}`);
  }
  return out;
}

function collectGithubIssueRefs(text: string): string[] {
  const out: string[] = [];
  GITHUB_ISSUE_REF.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = GITHUB_ISSUE_REF.exec(text)) !== null) {
    const num = match[1];
    if (!num) continue;
    out.push(`gh#${num}`);
  }
  return out;
}

export function extractTicketKeys(input: TicketLinkInput): string[] {
  const haystacks = [input.text, input.branchName].filter(
    (s): s is string => typeof s === 'string' && s.length > 0,
  );
  const found = new Set<string>();

  if (input.prefixes.length > 0) {
    const scoped = buildScopedPattern(input.prefixes);
    for (const h of haystacks) {
      for (const key of collectScoped(h, scoped)) found.add(key);
    }
  }

  if (input.source === 'github') {
    for (const h of haystacks) {
      for (const key of collectGithubIssueRefs(h)) found.add(key);
    }
  }

  return Array.from(found).sort();
}

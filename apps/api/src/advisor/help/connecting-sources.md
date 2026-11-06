# Connecting Jira, GitHub, GitLab, Azure DevOps, and Bitbucket

Connecting a source is a two-step process. First, on the Sources page —
shared across all boards — you add the connection's credentials and pick
which projects or repositories to sync. Second, on a specific board's own
Sources tab, you attach one of those synced projects/repos to that board,
optionally into a particular group, and choose how it behaves for that
board.

**Jira is read-only.** Deckgauge only ever reads from Jira — it never
creates, updates, or transitions a Jira issue. To connect, you need your
Atlassian site URL, an account email, and an API token. The URL must be
the real Atlassian site address (the `*.atlassian.net` host), not an
internal "vanity" display domain some organizations put in front of it —
a vanity domain will still show you the Jira UI, but it silently drops the
credentials on API calls, which shows up as an authentication failure even
though the token is valid.

**GitHub** needs a base URL (defaulting to the public GitHub API) and an
access token; you then pick which repositories to sync.

**GitLab** needs a base URL and an access token; you then pick which
projects to sync. The connection needs the API root, not the plain
instance URL, but Deckgauge normalizes whatever you paste onto the
`/api/v4` root automatically, so entering your instance's web address (for
example `https://gitlab.example.com`) still works.

**Bitbucket** (Bitbucket Cloud) needs your Atlassian account email and an
API token **with Bitbucket scopes**. Create it at
`https://id.atlassian.com/manage-profile/security/api-tokens` using
**Create API token with scopes**, choose **Bitbucket**, and tick the read
scopes: `read:user:bitbucket`, `read:workspace:bitbucket`,
`read:project:bitbucket`, `read:repository:bitbucket`,
`read:pullrequest:bitbucket` and `read:pipeline:bitbucket`. A plain
Atlassian API token — the kind you would use for Jira — is rejected with
"API Token provided has no Bitbucket scopes"; that is the most common
setup mistake, and the fix is a new token made with scopes, not a retry.
App passwords are retired and workspace access tokens are not supported.
The workspace is detected when you press **Create & test**, and repositories
are listed grouped by Bitbucket project, so you can attach a whole project's
repositories at once.

**Azure DevOps** needs your organization URL, an authentication method
(personal access token or basic auth), and the corresponding credential.
Per project you sync, you choose which repositories are included —
specific repos, or all of them — and whether PRs and commits are synced.

Once a project or repo is synced, attaching it to a board (from that
board's Sources tab) is where you control board-specific behavior. The
controls are not the same for every provider:

- **GitHub** — whether it feeds issues onto the board, whether it counts
  towards the engineering-intelligence analytics, which labels or issue
  types are let through, and whether closed issues are included.
- **Azure DevOps** — whether it feeds work items onto the board, whether it
  counts towards the engineering-intelligence analytics, which work-item
  types are let through, and an optional WIQL filter.
- **GitLab** — issue-sync and merge-request-sync onto the board are
  separate toggles, and both default off. There is no per-board
  engineering-intelligence toggle for GitLab.
- **Bitbucket** — no toggles: a Bitbucket repository feeds code activity
  (pull requests, reviews, commits and deployments) into the
  engineering-intelligence analytics only, never rows onto the board — Jira
  owns the tasks for a Bitbucket team. Release pull requests (for example
  `stage` → `prod`) are stored but not counted, so a feature is not counted
  twice, and a deploy counts once per pipeline that reached a Production
  environment, however many production environments it fanned out to.
- **Jira** — no on/off toggles here: an attached Jira project always feeds
  the board. What you control is which issue types are let through, an
  optional JQL filter, and how Jira statuses map onto the board's own.

Each connection on the Sources page shows a health badge — Valid or
Expired, or Unknown until the check comes back — tested live each time the
page loads. It is the fastest way to notice a credential has gone stale
before chasing a sync problem elsewhere.

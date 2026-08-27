# What the Advisor can and can't do

The Advisor is strictly read-only. It never creates, edits, deletes, or
moves anything in Deckgauge, and it never writes to any connected tool
(Jira, GitHub, GitLab, or Azure DevOps) either. Every answer it gives is
either a real number pulled from your engineering-intelligence data, or an
explanation drawn from Deckgauge's own documentation — it does not invent
figures, and it says so when it doesn't have an answer.

**When you're on a board**, it answers by calling a small set of read-only
tools, some over your engineering-intelligence data and some over the board
itself:

- Team-level KPIs (PRs merged, median cycle time, active developers,
  AI-assisted PR share) over a window you can widen or narrow.
- Developers whose merge throughput has dropped sharply against their own
  recent baseline.
- The AI-assisted share of each developer's PRs.
- The full cross-provider activity timeline for a single ticket by its key.
- **The board's actual rows** — name, group, status, owner, assignee,
  description, Jira key, and custom column values. Filter by group, status,
  whether a description is present, or a name search, rather than paging
  through everything. A question like "which issues have no description" or
  "what's in the Blocked group" is answered from real rows, not declined.
- **The board's own shape** — its groups, statuses and custom columns, each
  with the id a filter needs — plus each connected Jira, GitHub, or Azure
  DevOps source's allow-list of fields it's configured to overwrite on sync
  (a GitLab source doesn't report this). That allow-list is board
  configuration, not the last word on any one row: a manual edit to a field
  records an override, and an override always wins over the allow-list, so a
  field on the list can still hold a user's edit indefinitely.
- **The board's sync blacklist** — rows that were deleted from the board and
  are therefore excluded from re-sync, which explains why an issue that still
  exists in Jira/GitHub/ADO/GitLab is missing here.

These board-content tools are reads, same as the analytics ones: they surface
what's already on the board, they never add, edit, delete, or move a row, a
status, or a column. If a user asks you to change anything on the board, say
that you can't yet — you can only look.

**When you're not on a board**, it can explain how Deckgauge itself works —
how to connect a source, what a setting does, why the roadmap schedules an
item where it does — by consulting Deckgauge's own documentation. This is
explanation, not live inspection: it can tell you how a feature is meant to
behave, but it isn't looking at your specific data when it answers this
way.

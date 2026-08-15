# What the Advisor can and can't do

The Advisor is strictly read-only. It never creates, edits, deletes, or
moves anything in Deckgauge, and it never writes to any connected tool
(Jira, GitHub, GitLab, or Azure DevOps) either. Every answer it gives is
either a real number pulled from your engineering-intelligence data, or an
explanation drawn from Deckgauge's own documentation — it does not invent
figures, and it says so when it doesn't have an answer.

**When you're on a board**, it answers by calling a small set of read-only
analytics tools over your engineering-intelligence data:

- Team-level KPIs (PRs merged, median cycle time, active developers,
  AI-assisted PR share) over a window you can widen or narrow.
- Developers whose merge throughput has dropped sharply against their own
  recent baseline.
- The AI-assisted share of each developer's PRs.
- The full cross-provider activity timeline for a single ticket by its key.

**When you're not on a board**, it can explain how Deckgauge itself works —
how to connect a source, what a setting does, why the roadmap schedules an
item where it does — by consulting Deckgauge's own documentation. This is
explanation, not live inspection: it can tell you how a feature is meant to
behave, but it isn't looking at your specific data when it answers this
way.

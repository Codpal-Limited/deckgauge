# What "in progress" means on the timesheet

By default, the timesheet prefers a status's **category** (To Do / In
Progress / Done) when one is present and says "In Progress" — that alone is
enough for the time to count. In practice the category is usually not
available at all: Azure DevOps and GitHub activity carries no category
whatsoever, and Jira's changelog does not carry a category per historical
transition, so changelog-derived Jira transitions land as "Unknown"
regardless of how recent they are. When the category doesn't resolve the
question, the timesheet falls back to matching the status by **name**
instead — which is the path most work actually takes. Names are compared
after lower-casing and collapsing whitespace, underscores, and hyphens, so
"Refining - Product" and "refining product" are treated as the same
status — but a difference in other punctuation (a colon, slash, or period)
is not collapsed, so "Ready/QA" and "Ready QA" are treated as different
statuses.

That name-based fallback treats every status as in-progress work
**except** a known set of backlog and terminal names — things like To Do,
Backlog, Ready for Development, Done, Closed, Resolved, and Cancelled.
This is why a status such as "In Review" or "Blocked" still accrues hours:
it isn't in the excluded set, so it's treated as ongoing work. If a status
is genuinely new or unrecognized, it defaults to counting as in-progress
rather than being silently dropped.

There are two ways this category-then-name default gets overridden, and
they apply in a strict order:

1. **An org tree's active-status list wins outright.** Under Settings →
   Timesheet Statuses, you can pick the exact statuses that count as active
   work for a given org tree. When a list is set, it replaces the default
   entirely: only the statuses you picked count, and everything else —
   including things that would otherwise count as in-progress — is excluded.
2. **Otherwise, a per-employee or per-role override applies if one exists**,
   with the employee-level override taking precedence over the role-level
   one.
3. **If neither applies, the category-then-name default described above is
   used.**

If hours look wrong for a project nobody is working on any more, the
likely cause is a retired project rather than a status rule — see the
retired-projects doc.

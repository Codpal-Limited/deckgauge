# How people are matched to their commits, PRs, and tickets — and the leaderboard

Every activity item Deckgauge pulls in from GitHub, GitLab, Azure DevOps, or
Jira carries whatever identity the source system recorded for it — a login,
an email, a display name. To show that activity against a person in the
org tree, Deckgauge has to match that identity to one of your employees.
Matching is tried in order of confidence:

1. **An exact login match** against a known alias for that provider — the
   strongest signal.
2. **An exact email match** — either against a recorded email alias, or
   against the employee's own profile email. This is why an org tree
   populated from a directory sync (which fills in name and email but no
   aliases) still matches activity correctly: the profile email alone is
   enough, as long as it's unique to that person.
3. **A name match**, built from the person's first and last name (from a
   display name, or from the two parts of an email address before the
   `@`). This only resolves if exactly one employee shares that first/last
   combination — if two people in the tree share a name, neither is
   matched by name alone, rather than risking a wrong guess.

If none of these resolve, the activity simply isn't attributed to anyone.
The most common cause of a person showing zero activity despite clearly
doing the work is an identity mismatch: a nickname or maiden name that
doesn't match what the connected tool records, an email on a different
domain than their profile email, or a shared first/last name with a
colleague.

**The leaderboard** ranks employees within the same org tree by a weighted
composite of four metrics measured over a rolling 90-day window: tickets
closed (35% of the score), PRs merged (30%), commits authored (20%,
counting non-merge commits on any branch — including work pushed to a
still-open, unmerged pull request, not just what's landed on the default
branch), and review comments left (15%). Each metric is normalized to a 0–100
scale relative to everyone else in the tree before the weights are applied,
so the score reflects relative standing, not raw volume. The top three
ranked people get gold/silver/bronze; everyone else is bucketed into the
top 10%, top 25%, or the rest.

An employee who isn't matched to any activity (see above) isn't just
ranked last — they're left out of the leaderboard calculation entirely,
along with vacancies and people marked as departed.

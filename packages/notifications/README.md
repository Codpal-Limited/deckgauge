# @deckgauge/notifications

The notification **write path**, in a package rather than inside `apps/api`
because two processes need the same copy of it:

- `apps/api` — every request-driven trigger (assignment, comments, sharing,
  invites, automations).
- `apps/worker` — the hourly job that releases digests and evaluates
  due-soon/overdue.

The dispatcher owns dedupe, the actor-drop rule, the reverse access check and
preference resolution (design D4). Duplicating any of that in the worker is the
failure this package exists to prevent: a second copy of the access check is a
second place for a private board to leak.

The READ path (`notification.service.ts`, the routes, the subject resolvers)
stays in `apps/api` — it is HTTP-shaped and nothing else needs it.

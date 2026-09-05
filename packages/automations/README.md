# @deckgauge/automations

The board automation **rule engine**, in a package rather than inside `apps/api`
because two processes evaluate the same rules:

- `apps/api` — hand-edits (`POST /projects`, `PATCH /projects/:id`).
- `apps/worker` — every row a sync writes (Jira, GitHub, Azure DevOps promote).

## Why it moved here

Until this package existed, `evaluateTriggers` had exactly one caller —
`PATCH /projects/:id`. A rule reading *"when status changes to Cancelled → move to
group Cancelled"* therefore did nothing when the status arrived through a re-sync,
which is how most statuses actually arrive. The row went Cancelled and stayed in
its old group, and the automation looked broken because from the user's side it
was.

A sync writes statuses on exactly the rows a person does, so the rule engine has
to be reachable from both. `apps/worker` has no dependency on `apps/api` — the
same constraint that put the notification dispatcher in
`@deckgauge/notifications`.

## What the sync adds on top

`apps/worker/src/sync-automations.ts` wraps this engine with the parts that are
specific to running it over a whole sync: rules loaded once per board per run
rather than once per row, and a hard guarantee that a broken rule can never fail
the sync that wrote the rows. `actorId` is null there — nobody pressed anything,
so the dispatcher's actor-drop rule excludes nobody.

## Trigger semantics

`status_change` matches on two paths, because a board status change can land in
either column: the legacy `status` enum, or `statusId` for custom board statuses.
A trigger with no `value` matches **any** status change — the AutomationPanel
renders that case as "When status changes to any".

`item_created` fires for a row created by hand and for a row created by a sync
alike: a synced row is a new row on the board.

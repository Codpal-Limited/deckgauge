# How the roadmap schedules items

The roadmap doesn't use dependencies or "blocked by" links — Deckgauge has
no concept of one item blocking another. Instead, each item's position is
worked out from the group it sits in and its **Owner**.

Items that share the same group and the same Owner form a single sequential
chain, ordered the same way they're ordered on the board. Within a chain, an
item that has no explicit dates starts right where the previous item in the
chain ended — so a chain reads left-to-right as one continuous run of work
for that person. Items in a different group, or with a different Owner, run
on their own independent timeline and don't affect each other's scheduling.

The field that decides this is the board's **Owner** column, and only that
column — the roadmap never reads any separate assignee field, so changing
an assignee will not move a bar.

Items with **no Owner** are not each given their own timeline: within a
group they all share one chain, so they queue up behind one another in board
order. Give them Owners if you want them to run in parallel.

An item that has an explicit start date is **pinned**: it always starts on
that date regardless of where the chain's cursor currently is, and if it
runs past the point the chain had otherwise reached, everything scheduled
after it in the chain picks up from where the pinned item ends.

How wide an item is drawn — how many days it spans — is decided by the
first of these that applies:

1. An explicit start and end date, if both are set.
2. A duration code (a short value like "2w" or "3d"), if one is set.
3. A size label (XXS through XXL), converted to a number of weeks using the
   board's configured size-to-duration mapping.
4. A default number of weeks, whenever none of the above resolve. That
   includes an item with a start date but no end date, no duration code and
   no size label: the start date still pins where the bar begins, but its
   width comes from this default.

You configure the size-to-duration mapping, the roadmap's start date, and
which groups are visible, from the Settings button on the Roadmap view
itself. The fallback number of weeks used in step 4 isn't something that
panel lets you change.

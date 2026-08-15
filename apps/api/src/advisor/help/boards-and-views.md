# Boards, groups, columns, and views

A board is made up of groups (the colored row-sections you see in the
grid, sometimes called swimlanes) and columns (the fields shown for every
item — text, status, date, number, checkbox, dropdown, person, and link
columns are all supported). Items belong to a group and carry a value per
column.

A board can also have more than one view beyond its main grid: a dashboard
view for engineering-intelligence analytics and a roadmap view for
scheduling. Putting several boards side by side to compare them is **not** a
board view — a comparison is its own entity, created from the sidebar's
"New" menu alongside boards, roadmaps, and org trees.

When you create a board, you choose a template, and the template decides
what the board starts with:

- **Blank** — an empty board with rows, a status column, and the Size
  column the roadmap reads. No groups, no other columns, no dashboard, no
  roadmap view. Start from nothing and shape it yourself.
- **Development** — the delivery-board template: the
  engineering-intelligence dashboard and a roadmap view, ready for you to
  connect Jira, GitHub, Azure DevOps, or GitLab. It carries the same Size
  column a Blank board gets. This is what a board becomes by default if you
  create one without picking a template.
- **Recruitment** — a candidate pipeline: preset groups for each interview
  stage (New / Sourced, Interviewing, Offer, Hired, Not moving forward),
  plus Role, Interview date, Salary expectation, Target start, and Decision
  columns. No Size column, no dashboard, no roadmap view.

The org/employee tree (org chart, headcount, and the per-person leaderboard)
is a separate part of the product from project boards. It isn't one of
these three templates — the sidebar's "New" menu has a separate entry for it
that creates an org tree instead of a project board.

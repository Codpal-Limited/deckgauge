# Retired projects

If a Jira project has stopped being worked on but its tickets are still
sitting in an open-ended status, the timesheet will keep counting hours
against it forever — nobody is closing those tickets, so nothing tells the
system the work has stopped. Retiring the project fixes this.

You retire a project by its Jira project key and a cutoff date, with an
optional note for why. From that cutoff date onward, all in-progress hours
for that project stop being counted:

- Any span of time that started and ended before the cutoff is unaffected.
- A span that was still open when the cutoff hit is cut off exactly at that
  date, so only the hours before the cutoff still count.
- Any span that starts on or after the cutoff is dropped entirely.

This only affects Jira-sourced work — GitHub, GitLab, and Azure DevOps
activity is untouched by a retirement.

You manage the list of retired projects from the Sources page, in the
"Retired projects" panel. Un-retiring a project (removing it from the list)
makes its hours count again from the next timesheet refresh.

If timesheet hours look wrong for a project that's clearly inactive, check
here first before assuming a status-rule problem.

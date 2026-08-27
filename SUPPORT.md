# Getting help with Deckgauge

Deckgauge is self-hosted, so most problems are answerable from the docs or a
container log. Here is where to look, in the order that usually resolves things
fastest.

## Start with the documentation

- **[Quickstart](https://deckgauge.com/docs/quickstart/)** — install, first board, first source.
- **[Connecting sources](https://deckgauge.com/docs/connecting-sources/)** — Jira, GitHub, GitLab and Azure DevOps setup, including the token scopes each provider needs.
- **[Widget reference](https://deckgauge.com/docs/widgets/)** — every intelligence widget, what its number is built from, which providers feed it, and how it can mislead you.

If a metric looks wrong, the widget's own reference page is usually the fastest
answer — most surprises come from a provider that isn't connected, or a status
mapping that doesn't match how your team actually works.

## Questions and ideas

Use **[GitHub Discussions](https://github.com/Codpal-Limited/deckgauge/discussions)** for
anything open-ended: "how do I…", "is this possible", "here's how we set ours
up", or feedback on where the project should go. Questions asked there help the
next person who searches for the same thing, which issues do not.

## Bugs and feature requests

Open a **[GitHub issue](https://github.com/Codpal-Limited/deckgauge/issues)**.

For a bug, the things that let us actually reproduce it:

- what you expected, and what happened instead
- the version or commit you are running
- which provider the data came from (Jira, GitHub, GitLab, Azure DevOps)
- relevant output from `docker compose logs <service>` — usually `api` or `worker`

For a feature, describe the problem before the solution. We can often point at an
existing way to get there, and where we cannot, the problem statement is what
makes the feature worth building.

See [CONTRIBUTING.md](CONTRIBUTING.md) if you would like to send the fix yourself.

## Security issues

**Do not open a public issue.** Report privately — see
[SECURITY.md](SECURITY.md).

## What to expect

Deckgauge is maintained by [CodPal](https://codpal.com) alongside client work.
Community support is best-effort: we read everything, and we prioritise
reproducible bugs and anything affecting data correctness.

## Commercial support

If you need guaranteed response times, help interpreting what your metrics are
telling you, or hands-on work on your delivery process, CodPal — the team that
builds Deckgauge — offers that directly. See the
[Engineering Health Check](https://deckgauge.com/engineering-health-check/) or
email **support@codpal.com**.

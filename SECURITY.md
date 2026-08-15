# Security Policy

We take the security of Deckgauge and its users seriously. Thank you for helping keep it safe.

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately through either channel:

- **GitHub private vulnerability reporting** — use the **"Report a vulnerability"** button on the repository's **Security** tab (preferred).
- **Email** — **support@codpal.com**.

Please include:

- A description of the issue and its potential impact.
- Steps to reproduce (a proof-of-concept helps).
- The affected version or commit.

## What to expect

- We'll acknowledge your report within **3 business days**.
- We'll investigate, keep you updated, and coordinate a fix and disclosure timeline with you.
- We're happy to credit you for the report if you'd like.
- Please give us reasonable time to release a fix before any public disclosure.

## Scope

Deckgauge is **self-hosted** — it runs entirely in your own environment. In scope: the application code, default configuration, and dependencies. Out of scope: the security of *your* deployment's infrastructure (your Keycloak instance, database, network, and secrets), which is your responsibility to configure and protect.

## Supported versions

Security fixes land on the latest release and on `main`. We recommend running the latest version.

#!/usr/bin/env python3
"""Report .env.example values that a container cannot reach.

Derives the variable set from docker-compose.yml rather than hardcoding it: any
`KEY: "${VAR:-default}"` in an environment block whose DEFAULT addresses a
compose SERVICE NAME is, by construction, consumed inside a container. If
.env.example then gives that VAR a loopback value, the two disagree about where
the container should connect and the container loses — silently, because a
client that cannot reach its server usually retries rather than crashes.

Prints one `VAR<TAB>value` line per offender; prints nothing when clean.
"""
import re
import sys

COMPOSE = "docker-compose.yml"
EXAMPLE = ".env.example"

compose = open(COMPOSE, encoding="utf-8").read()
example = open(EXAMPLE, encoding="utf-8").read()

# Top-level service names — the only hosts a sibling container can resolve.
block = re.search(r"^services:\n(.*?)(?=^\S|\Z)", compose, re.S | re.M)
services = re.findall(r"^  ([a-z][a-z0-9-]*):", block.group(1), re.M) if block else []
if not services:
    print("could not parse service names from %s" % COMPOSE, file=sys.stderr)
    sys.exit(2)

# Environment values of the form  KEY: "${VAR:-default}"  or  "${VAR-default}".
#
# The default may itself contain ONE level of `${...}` — REDIS_URL's is
# `redis://:${REDIS_PASSWORD:-}@redis:6379`, so its server and clients cannot
# disagree about the password. A plain `[^}]*` stops at that inner `}` and the
# variable silently drops out of the guard; the alternation below steps over it.
pairs = re.findall(
    r'^\s+[A-Z_][A-Z0-9_]*: "\$\{([A-Z_][A-Z0-9_]*)(?::-|-)((?:[^}$]|\$\{[^}]*\})*)\}"',
    compose,
    re.M,
)

# A default that addresses a service name (redis://redis:6379, http://api:3001,
# postgres://user:pw@postgres:5432/db) marks the variable as container-consumed.
container_consumed = {
    var
    for var, default in pairs
    if any(re.search(r"(//|@)" + re.escape(name) + r"[:/]", default) for name in services)
}

for var in sorted(container_consumed):
    m = re.search(r"^%s=(.*)$" % re.escape(var), example, re.M)
    if not m:
        continue  # unset in .env.example: the compose default applies, which is correct
    value = m.group(1).strip().strip('"').strip("'")
    if re.search(r"(localhost|127\.0\.0\.1)", value):
        print("%s\t%s" % (var, value))

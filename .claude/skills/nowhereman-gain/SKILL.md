---
name: nowhereman-gain
description: Report how much the nowhereman MCP cache is saving right now - entry/edge counts, hit rate, and estimated tokens saved. Invoke when the user asks how much the cache is helping, wants savings/efficiency numbers, or asks for something like "rtk gain" but for nowhereman.
---

# nowhereman-gain

Call the `cache_stats` tool and present the result as a short report:

- **Entries / edges** — how much the cache has accumulated (`entries`, `edges`).
- **Hit rate** — `hits / (hits + misses)`, as a percentage.
- **Estimated tokens saved** — `estimatedTokensSaved`, the running total across every
  `cache_get` hit (accumulated from each entry's response length at ~4 chars/token).
- **Top entries** — `topEntries`, the highest-`hitCount` cached results; call out if any of them
  look like they shouldn't be cached (state checks, anything with side effects) per the
  `nowhereman-cache` skill's guardrails — a frequently-hit entry that shouldn't exist is a bug to
  flag, not a win to report.

Keep the report to a few lines — numbers plus one sentence of interpretation, not a dump of raw
JSON. If `entries` is 0 or hit rate is 0%, say so plainly rather than padding the report; an idle
or freshly-started cache has nothing to show yet.

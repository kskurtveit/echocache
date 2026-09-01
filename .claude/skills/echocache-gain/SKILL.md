---
name: echocache-gain
description: Report what the echocache MCP cache is doing right now - entry/edge counts, hit rate, and tokens served. Invoke when the user asks how much the cache is helping, wants savings/efficiency numbers, or asks for something like "rtk gain" but for echocache.
---

# echocache-gain

Call the `cache_stats` tool and present the result as a short report:

- **Entries / edges** — how much the cache has accumulated (`entries`, `edges`).
- **Stored bytes** — `bytesStored`, the total size of retained responses. Note this is the size
  *on disk*: with at-rest encryption enabled it runs roughly a third above the plaintext size.
- **Hit rate** — `hits / (hits + misses)`, as a percentage. This covers the **exact-match** path
  only (`cache_get`).
- **Semantic recall** — `queryHits` / `queryMisses`, how often `cache_query` found something.
  Report this alongside the hit rate rather than folding it in: for derivations recalled by
  meaning — the case this cache is for — `cache_query` is the primary path, and a cache can show
  a poor exact-match hit rate while working exactly as intended.
- **Tokens served** — `tokensServed`, the running total handed back across every `cache_get` hit
  and every `cache_query` recall (from each entry's response length at ~4 chars/token).
- **Evictions** — `evictions`, entries dropped to stay under the configured ceilings. A large
  number relative to `sets` means the cache is thrashing: it's evicting things about as fast as
  it stores them, so raising `ECHOCACHE_MAX_ENTRIES` / `ECHOCACHE_MAX_BYTES` would likely lift
  the hit rate.
- **Top entries** — `topEntries`, the highest-`hitCount` cached results; call out if any of them
  look like they shouldn't be cached (state checks, anything with side effects) per the
  `echocache-cache` skill's guardrails — a frequently-hit entry that shouldn't exist is a bug to
  flag, not a win to report.

Keep the report to a few lines — numbers plus one sentence of interpretation, not a dump of raw
JSON. If `entries` is 0 or hit rate is 0%, say so plainly rather than padding the report; an idle
or freshly-started cache has nothing to show yet.

Report `tokensServed` as the estimate it is — a ~4-chars-per-token heuristic over response
length, not a real tokenizer. Don't convert it to a cost figure or present it as measured.

**Do not report `tokensServed` as tokens saved.** It is what the cache handed back, which equals a
saving only for entries that stand in for work that would otherwise be regenerated — a long
generation, a derived analysis. An entry that merely caches a file read hands back exactly the
tokens re-reading the file would have cost, so it saves nothing while still inflating this number.
If `topEntries` is dominated by file paths, say that the figure overstates the benefit and point
at the `echocache-cache` skill's "what NOT to route through this cache".

If `cache_stats` itself returns `isError: true`, report that the cache is unreachable and quote
the message — do not substitute zeros, which would read as "the cache is working but empty."

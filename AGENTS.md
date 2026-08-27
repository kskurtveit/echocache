# nowhereman — MCP caching tool

This project ships the `nowhereman` MCP server: a response cache with HTTP-style freshness
semantics, plus a similarity graph for semantic recall of related past results. If you are an
agent with `nowhereman`'s tools available (registered under this or another project), follow the
protocol below. If you're a human or agent working *on* this repo's code, see `CLAUDE.md` too.

## When to use it

Before doing any expensive, repeatable piece of work — a long generation, a multi-step reasoning
chain, a call to something you might end up redoing — check the cache first, then write the
result back:

1. Call `cache_get` with the exact `(model, prompt, params)` you're about to run.
   - `hit: true`, `entry.fresh: true` → use `entry.response` directly, skip the real work.
   - `hit: true`, `entry.stale: true` → usable but past its TTL; use it if adequate, or redo the
     work and call `cache_set` again to refresh it.
   - `hit: false` → no match, or the entry fully expired. Proceed with the real work.
2. After doing the real work, call `cache_set` with the prompt/response pair so future callers —
   you later, or another agent — can reuse it. Set `ttl_seconds` to how long the result stays
   valid (`null` for things that never go stale, a short TTL for anything time-sensitive).
3. Before assuming something has never been computed, try `cache_query` — semantic search that
   finds related prior results even when the wording doesn't match exactly.
4. Use `cache_related` to pull in entries linked to a known one (auto-linked by content
   similarity, or explicitly via `derived_from` at `cache_set` time) — useful for gathering
   everything already known about a topic before starting new work.
5. If you know a cached entry's source changed, call `cache_invalidate`. Pass `cascade: true` to
   also remove entries that declared it as a `derived_from` parent.
6. `cache_stats` reports hit rate and estimated tokens saved — check it if asked how much the
   cache is actually helping.

## What's safe to cache

Not every repeated call is safe to serve from cache. Judge by whether the *tool* is idempotent —
does it just read something, or does it check or change live state?

- **Cache freely**: read-only lookups over content that only changes when someone edits it — file
  reads, greps/searches, web fetches, doc/API lookups. The default 1-day TTL is a reasonable
  starting point; shorten it for anything volatile.
- **Don't cache**: commands whose entire purpose is telling you *current* state — `git status`,
  test runs, health checks, `git push`, anything with side effects. A hit there isn't a shortcut,
  it's a stale-state bug. If a call's value is "what does the world look like right now," skip
  `cache_get`/`cache_set` for it entirely — don't route generic shell/Bash execution through this
  cache by default.
- When unsure, prefer under-caching: a missed opportunity costs some tokens; a wrongly-served
  stale result costs correctness.

This was validated by replaying real Claude Code session logs through this cache: read-only file
lookups landed a genuine ~13% hit rate on re-reads of unchanged files, while naively caching every
literal-repeat shell command mostly meant re-serving stale `git status` / `git push` output —
redundant to run again, but actively wrong to cache.

## Tools

| Tool               | Purpose                                                                |
|---------------------|--------------------------------------------------------------------------|
| `cache_get`         | Exact-match lookup with fresh / stale / expired freshness (Cache-Control style) |
| `cache_set`         | Store a result; auto-links it into the similarity graph                  |
| `cache_query`       | Semantic search across all cached entries                                |
| `cache_related`     | Graph traversal from one entry to entries linked to it                   |
| `cache_invalidate`  | Delete an entry, optionally cascading to its dependents                  |
| `cache_stats`       | Hit rate and estimated token savings                                     |

## Secrets

Cached entries are written to a local database file. Permissions are locked to the owner, and
`NOWHEREMAN_ENCRYPTION_KEY` can encrypt entry contents at rest — but neither makes it safe to
deliberately cache credentials. Don't route API keys, tokens, or private key material through
`cache_set`; re-reading the source is cheaper than leaking it.

## Non-goals

This is a cache, not a source of truth. A cache hit is never more authoritative than the real
computation it stands in for — if freshness matters and you're unsure, prefer redoing the work
over trusting a `stale` entry.

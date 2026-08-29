# nowhereman — MCP caching tool

This project ships the `nowhereman` MCP server: a response cache with HTTP-style freshness
semantics, plus a similarity graph for semantic recall of related past results. If you are an
agent with `nowhereman`'s tools available (registered under this or another project), follow the
protocol below. If you're a human or agent working *on* this repo's code, see `CLAUDE.md` too.

## When to use it

Before doing any piece of work that is **expensive to produce** and safe to reuse — a long
generation, a multi-step reasoning chain, an analysis you derived, an expensive API call — check
the cache first, then write the result back. Note the emphasis: this cache pays off on work that
would cost real generation to redo, not on work that is merely repeated. See "What's worth
caching" below before routing anything through it.

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
6. `cache_stats` reports hit rate and `tokensServed` — check it if asked how much the cache is
   actually helping. See the note under that tool below on what `tokensServed` does and does not
   claim.

## What's worth caching

Two questions, and an entry has to pass **both**. The first is about correctness, the second about
whether the cache pays for itself at all.

**1. Is it safe to reuse?** Would serving this from cache still be right minutes or hours later?

- **Yes**: results over content that only changes when someone edits it.
- **No**: anything whose entire purpose is reporting *current* state — `git status`, test runs,
  health checks, `git push`, anything with side effects. A hit there isn't a shortcut, it's a
  stale-state bug. Skip `cache_get`/`cache_set` for these entirely, and don't route generic
  shell/Bash execution through this cache by default.

**2. Would reproducing it cost real generation?** This is the question that decides whether
caching is worth doing, and it is easy to get backwards.

Writing an entry means emitting its full content as a `cache_set` argument — tokens you generate,
at output rates. Reading it back on a hit costs the same tokens as any other tool result. So:

- **Worth caching**: results that were *expensive to produce* — a long generation, a multi-step
  reasoning chain, an analysis or summary you derived, an expensive API result. Regenerating these
  would cost output tokens plus the reasoning behind them, so a single hit already pays for the
  write.
- **Not worth caching**: results that are merely *re-read*. A cached file read hands back exactly
  the tokens that reading the file would have, so it saves nothing and the write cost is pure
  overhead. The same goes for greps and globs. Cache what you *concluded* from a file, not the
  file.
- **In between**: web fetches and doc lookups. Cheap enough to redo that the raw page rarely earns
  its write — but a distilled answer drawn from several of them usually does.

When unsure, prefer under-caching: a missed opportunity costs little, while a wrongly-served stale
result costs correctness.

Replaying real Claude Code session logs through this cache showed both halves of this. Literal
repeat shell commands were mostly `git status` / `git push` — redundant to run again but actively
wrong to cache. Read-only file lookups were safe to reuse and landed a ~13% hit rate on unchanged
files, but that figure measures *hit rate only*: at 13%, re-emitting every file read to buy hits
that save no tokens is a straight loss. Safe to cache and worth caching are different tests.

## Tools

| Tool               | Purpose                                                                |
|---------------------|--------------------------------------------------------------------------|
| `cache_get`         | Exact-match lookup with fresh / stale / expired freshness (Cache-Control style) |
| `cache_set`         | Store a result; auto-links it into the similarity graph                  |
| `cache_query`       | Semantic search across all cached entries                                |
| `cache_related`     | Graph traversal from one entry to entries linked to it                   |
| `cache_invalidate`  | Delete an entry, optionally cascading to its dependents                  |
| `cache_stats`       | Hit rate and `tokensServed` (see caveat under "What's worth caching")     |

## Secrets

Cached entries are written to a local database file. Permissions are locked to the owner, and
`NOWHEREMAN_ENCRYPTION_KEY` can encrypt entry contents at rest — but neither makes it safe to
deliberately cache credentials. Don't route API keys, tokens, or private key material through
`cache_set`; re-reading the source is cheaper than leaking it.

## Non-goals

This is a cache, not a source of truth. A cache hit is never more authoritative than the real
computation it stands in for — if freshness matters and you're unsure, prefer redoing the work
over trusting a `stale` entry.

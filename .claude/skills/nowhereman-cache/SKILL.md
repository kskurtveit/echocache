---
name: nowhereman-cache
description: Use the nowhereman MCP cache (cache_get/cache_set/cache_query/cache_related/cache_invalidate) before and after any expensive, repeatable read — file reads, greps, web fetches/searches, doc lookups — so the result can be reused later instead of redone. Trigger before re-reading a file or re-running a search that may already be cached, and after producing a result worth keeping. Do NOT trigger for stateful or live-state checks (git status, test runs, health checks, git push) or anything with side effects.
---

# nowhereman cache protocol

nowhereman is an MCP server exposing a response cache: exact-match lookup with HTTP-style
freshness (`cache_get`/`cache_set`), plus a similarity graph for semantic recall
(`cache_query`/`cache_related`) and dependency-aware invalidation (`cache_invalidate`).
Full tool reference: `AGENTS.md` in this repo.

## Before doing read-only, repeatable work

Call `cache_get(model, prompt, params)` first, where `model` is the tool/operation name
(`"Read"`, `"Grep"`, `"WebFetch"`, ...) and `prompt` is the normalized target (file path, query,
URL).

- `hit: true, entry.fresh: true` → use `entry.response`, skip the real read.
- `hit: true, entry.stale: true` → usable but past TTL; use it if adequate or refresh it.
- `hit: false` → do the real work, then store it (next section).

If nothing matches exactly, try `cache_query(text)` — semantic search across cached entries by
meaning, useful when the exact wording or path differs from a prior lookup.

## After doing the work

Call `cache_set` with the prompt/result and a TTL appropriate to how often the source changes
(`null` for effectively-static content, a short TTL for anything that drifts). Pass
`derived_from` with parent entry ids if this result was built on top of other cached entries.

`cache_set` returns `{ id, linkedTo, evicted }`. `evicted` is how many entries the write pushed
out to stay under the cache's ceilings — a consistently non-zero value means the cache is
thrashing and its limits (`NOWHEREMAN_MAX_ENTRIES` / `NOWHEREMAN_MAX_BYTES`) are too small for
what's being stored. Worth mentioning to the user; not worth reacting to on a single write.

## What NOT to route through this cache

Skip `cache_get`/`cache_set` entirely for:

- Anything whose purpose is telling you *current* state: `git status`, `git push`, test runs,
  health checks, deploy/build output.
- Anything with side effects.
- Generic shell/Bash execution by default — only cache a specific Bash invocation if you've
  confirmed it's a pure, idempotent read (e.g. `cat` of a file that won't change).
- **Secrets.** Never `cache_set` API keys, tokens, credentials, or private key material, and
  don't cache a file read whose content is a secrets file. Entries are written to a local
  database; permissions are owner-only and contents can be encrypted at rest, but neither makes
  deliberately caching a credential safe. Re-reading the source is cheaper than leaking it.

Measured on real session replay: read-only lookups (Read/Grep/Glob/WebFetch) landed a genuine
~13% hit rate on unchanged content; blindly caching literal-repeat shell commands mostly just
re-served stale `git status`/`git push` output. When unsure, skip caching — a missed opportunity
costs tokens, a stale cache hit costs correctness.

## When a cache tool returns an error

A cache tool can fail (`isError: true`) — for example if the database is unreadable or the
configured encryption key doesn't match it. Treat that as a plain cache miss: **do the real work
and continue**. Never retry the same cache call in a loop, and never present the error text as if
it were the cached result. If every cache call in a session is failing, say so once rather than
silently working around it — the fix is usually a configuration problem the user needs to know
about.

## Checking whether it's helping

Use the `nowhereman-gain` skill, or call `cache_stats` directly, to see hit rate and estimated
tokens saved.

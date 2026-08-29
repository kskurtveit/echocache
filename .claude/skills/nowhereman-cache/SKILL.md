---
name: nowhereman-cache
description: Use the nowhereman MCP cache (cache_get/cache_set/cache_query/cache_related/cache_invalidate) around work that is expensive to PRODUCE and safe to reuse — long generations, multi-step reasoning chains, derived analyses and summaries, expensive API results — so it need not be regenerated later. Trigger before starting such work, and after producing a result worth keeping. Do NOT trigger for plain file reads, greps or globs: serving those from cache costs the same tokens as redoing them, so the write is pure overhead. Do NOT trigger for stateful or live-state checks (git status, test runs, health checks, git push) or anything with side effects.
---

# nowhereman cache protocol

nowhereman is an MCP server exposing a response cache: exact-match lookup with HTTP-style
freshness (`cache_get`/`cache_set`), plus a similarity graph for semantic recall
(`cache_query`/`cache_related`) and dependency-aware invalidation (`cache_invalidate`).
Full tool reference: `AGENTS.md` in this repo.

## Before doing expensive, reusable work

Call `cache_get(model, prompt, params)` first, where `model` names the operation that produced the
result (`"summarize"`, `"analyze-schema"`, `"claude-opus-5"`, ...) and `prompt` is the normalized
description of what was asked.

- `hit: true, entry.fresh: true` → use `entry.response`, skip the real work.
- `hit: true, entry.stale: true` → usable but past TTL; use it if adequate or refresh it.
- `hit: false` → do the real work, then store it (next section).

If nothing matches exactly, try `cache_query(text)` — semantic search across cached entries by
meaning, useful when the exact wording or path differs from a prior lookup.

## The case this is for: re-orientation across sessions

You read a codebase to understand it; the session ends; a later session needs that understanding
again. Caching the files saves nothing — a hit returns the same tokens the read did. Caching your
*conclusion* replaces the entire re-read: measured at 15,504 tokens to re-read `express/lib`
against 549 to serve the derived orientation, ~28x fewer, repaid on the first reuse.

So when you finish expensive orientation or analysis, write the conclusion back — and start a
session with `cache_query`, not `cache_get`, since you will rarely phrase the question exactly as
last time.

To keep a derivation honest, store a **fingerprint** entry per source file (`model:
"source-fingerprint"`, response = the file's hash, never its contents) and pass those ids as
`derived_from`. Re-hash on a later session; if a file moved,
`cache_invalidate(<fingerprint id>, cascade: true)` drops everything derived from it and spares
the rest. A TTL cannot detect a source change; this can.

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

- **Plain re-reads: file reads, greps, globs.** Writing an entry means emitting its whole content
  as a `cache_set` argument, and reading it back costs the same tokens the original read did. A
  cached file read therefore saves nothing and the write is pure overhead. Cache what you
  *concluded* from a file — the analysis, the summary, the answer — never the file itself.
- Anything whose purpose is telling you *current* state: `git status`, `git push`, test runs,
  health checks, deploy/build output.
- Anything with side effects.
- Generic shell/Bash execution by default.
- **Secrets.** Never `cache_set` API keys, tokens, credentials, or private key material, and
  don't cache content drawn from a secrets file. Entries are written to a local database;
  permissions are owner-only and contents can be encrypted at rest, but neither makes
  deliberately caching a credential safe. Re-reading the source is cheaper than leaking it.

Two separate tests, and an entry must pass both: **safe to reuse** (it won't be stale) and **worth
caching** (reproducing it would cost real generation). Session-log replay showed why both are
needed — literal-repeat shell commands were mostly `git status`/`git push`, unsafe to reuse, while
file reads were perfectly safe to reuse and still not worth caching, because a hit hands back
exactly the tokens the read would have. When unsure, skip: a missed opportunity costs little, a
stale hit costs correctness.

## When a cache tool returns an error

A cache tool can fail (`isError: true`) — for example if the database is unreadable or the
configured encryption key doesn't match it. Treat that as a plain cache miss: **do the real work
and continue**. Never retry the same cache call in a loop, and never present the error text as if
it were the cached result. If every cache call in a session is failing, say so once rather than
silently working around it — the fix is usually a configuration problem the user needs to know
about.

## Checking whether it's helping

Use the `nowhereman-gain` skill, or call `cache_stats` directly, to see hit rate and
`tokensServed` — the tokens handed back from cache. Read it carefully: `tokensServed` equals
tokens *saved* only for entries that stand in for work which would otherwise be regenerated. A
cache full of file reads reports a large `tokensServed` while saving nothing.

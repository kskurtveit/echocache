---
name: nowhereman-cache
description: Use the nowhereman MCP cache (cache_get/cache_set/cache_query/cache_related/cache_invalidate) around work that is expensive to PRODUCE and safe to reuse — a cached LLM response for a long generation, a multi-step research or reasoning chain, a derived analysis or judgment call, an expensive API result — so it need not be regenerated later. Trigger before starting such work, and after producing a result worth keeping. Do NOT trigger for plain file reads, greps or globs, or for locating code: those cost the same or more from cache than from doing the work directly. Do NOT trigger for stateful or live-state checks (git status, test runs, health checks, git push) or anything with side effects.
---

# nowhereman cache protocol

nowhereman is an MCP server exposing a **response cache**: exact-match lookup with HTTP-style
freshness (`cache_get`/`cache_set`), plus a similarity graph for semantic recall
(`cache_query`/`cache_related`) and dependency-aware invalidation (`cache_invalidate`). Think of
it the way an HTTP cache thinks of a request: `cache_get` checks `(model, prompt, params)` against
a cache key the way a browser checks a URL, before you pay to regenerate the response yourself.
Full tool reference: `AGENTS.md` in this repo.

## The case this is for: a cached LLM response for expensive work

Cache a **response** — the output of a long generation, a multi-step research chain, a derived
analysis, a computed judgment call, an expensive API result. Never a **read** — a file, a grep
result, a directory listing. The difference is not stylistic, it is the whole economics: a cache
hit costs the same input tokens the underlying content would cost to read anyway, so caching a
read saves nothing and the write (re-emitting it as a `cache_set` argument, at output rates) is
pure loss. Caching a *response* is different: the hit replaces regenerating it, which is where the
tokens actually were.

Measured, not assumed: a real 22-tool-call research chain in this project's own history — board
throughput specs, drive benchmarks — cost 37,119 output tokens to reach a 255-token engineering
recommendation. Reproducing it again costs ~185,679 weighted tokens (output priced at 5x input);
serving the cached answer back costs ~255 — a **728x** gap. A single reuse pays for the write
(~1,275 weighted tokens to re-emit the conclusion) by roughly 145x. That is the polar opposite of
caching a file read, which loses at every hit rate regardless of size — here, one hit anywhere in
the future already wins big, so low expected reuse does not disqualify it.

**Cache what grep — or a plain re-read — cannot reconstruct.** A conclusion. A judgment. The
reason something is the way it is. A synthesis across several sources that took real reasoning to
produce. The fact that something is *absent*, once you've checked. Never a location: if a search
tool can find it, the cache costs more to consult than the search does, and loses.

## Before doing expensive, reusable work

Call `cache_get(model, prompt, params)` first, where `model` names the operation that produced the
result (`"summarize"`, `"analyze-schema"`, `"claude-opus-5"`, ...) and `prompt` is the normalized
description of what was asked.

- `hit: true, entry.fresh: true` → use `entry.response`, skip the real work.
- `hit: true, entry.stale: true` → usable but past TTL; use it if adequate or refresh it.
- `hit: false` → do the real work, then store it (next section).

If nothing matches exactly, try `cache_query(text)` — semantic search across cached entries by
meaning, useful when the exact wording differs from a prior lookup. Prefer `cache_query` over
`cache_get` whenever you're not sure the exact phrasing matches: a later session, or a different
agent, will rarely ask it the way it was first written.

## After doing the work

Call `cache_set` with the prompt/result and a TTL appropriate to how often the source changes
(`null` for effectively-static content, a short TTL for anything that drifts). Pass
`derived_from` with parent entry ids if this result was built on top of other cached entries —
that lets `cache_invalidate(cascade: true)` clean up dependents when a source changes.

To keep a derivation honest against a source that might change later, store a **fingerprint**
entry per source (`model: "source-fingerprint"`, response = its hash, never its contents — this
costs nothing to store) and pass those ids as `derived_from`. Re-hash on a later check; if it
moved, `cache_invalidate(<fingerprint id>, cascade: true)` drops what was derived from it and
spares the rest. A TTL cannot detect a source change; this can.

`cache_set` returns `{ id, linkedTo, evicted }`. `evicted` is how many entries the write pushed
out to stay under the cache's ceilings — a consistently non-zero value means the cache is
thrashing and its limits (`NOWHEREMAN_MAX_ENTRIES` / `NOWHEREMAN_MAX_BYTES`) are too small for
what's being stored. Worth mentioning to the user; not worth reacting to on a single write.

## Re-orientation across sessions (a narrower, conditional case)

An agent reads a codebase to understand it broadly; the session ends; a later session needs that
same broad understanding again. Caching the files saves nothing, for the same reason as any file
read. Caching the conclusion can help — measured at 15,504 tokens to re-read `express/lib` against
549 to serve a derived orientation, ~28x fewer — but **only when the later need is broad
understanding**. A session that just needs one specific answer will grep for it in a few hundred
tokens, and the cache is not competitive with that. Do not dispatch a shared orientation expecting
it to replace reading; it replaces re-*understanding*, which is a narrower thing.

Measured directly: agents dispatched with no cache hint spent 903–947 tool-result tokens locating
and reading a slice of a file with grep; agents told to consult a cached orientation first spent
1,911–1,937 for the same answer — about twice as much, because they still had to grep for the
precise detail the orientation didn't carry. A cached map competes with grep on grep's own ground
and loses. See `.claude/agents/codebase-orienter.md` for the corrected protocol if you are
dispatching agents over a shared codebase.

## What NOT to route through this cache

Skip `cache_get`/`cache_set` entirely for:

- **Plain re-reads and locations: file reads, greps, globs, "where is X."** Writing an entry means
  emitting its whole content as a `cache_set` argument, and reading it back costs the same tokens
  the original read or search would. Grep is already a cheap, precise pointer; a cache cannot beat
  it at finding things, only at not having to re-derive a conclusion.
- Anything whose purpose is telling you *current* state: `git status`, `git push`, test runs,
  health checks, deploy/build output.
- Anything with side effects.
- Generic shell/Bash execution by default.
- **Secrets.** Never `cache_set` API keys, tokens, credentials, or private key material, and
  don't cache content drawn from a secrets file. Entries are written to a local database;
  permissions are owner-only and contents can be encrypted at rest, but neither makes
  deliberately caching a credential safe. Re-reading the source is cheaper than leaking it.

Two separate tests, and an entry must pass both: **safe to reuse** (it won't be stale) and **worth
caching** (reproducing it would cost real generation, not just a read or a search). Session-log
replay showed why both are needed — literal-repeat shell commands were mostly `git status`/`git
push`, unsafe to reuse, while file reads were perfectly safe to reuse and still not worth caching,
because a hit hands back exactly the tokens the read would have. When unsure, skip: a missed
opportunity costs little, a stale hit costs correctness.

## When a cache tool returns an error

A cache tool can fail (`isError: true`) — for example if the database is unreadable or the
configured encryption key doesn't match it. Treat that as a plain cache miss: **do the real work
and continue**. Never retry the same cache call in a loop, and never present the error text as if
it were the cached result. If every cache call in a session is failing, say so once rather than
silently working around it — the fix is usually a configuration problem the user needs to know
about.

## Checking whether it's helping

Use the `nowhereman-gain` skill, or call `cache_stats` directly, to see hit rate, semantic recall
(`queryHits`/`queryMisses`), and `tokensServed` — the tokens handed back from cache. Read it
carefully: `tokensServed` equals tokens *saved* only for entries that stand in for work which
would otherwise be regenerated. A cache full of file reads or locations reports a large
`tokensServed` while saving nothing; if `topEntries` looks like file paths or "where is X"
questions, say so rather than reporting the number at face value.

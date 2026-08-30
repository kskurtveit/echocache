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

### The case this cache exists for

Re-orientation across sessions. You read a codebase to understand it, the session ends, and a
later session needs that understanding again. Caching the *files* saves nothing. Caching what you
*concluded* replaces the whole re-read.

Measured on `express/lib` — six files, 62KB:

| | tokens |
|---|---|
| re-reading the source in a later session | 15,504 |
| serving the cached orientation instead | 549 |
| | **~28x fewer** |

The write cost 549 output tokens, paid once. At output-to-input rates that is repaid by the first
reuse and free thereafter — the opposite of a cached file read, which never repays anything.

So when you finish expensive orientation or analysis work, write the *conclusion* back:

```
cache_set(model: "orient",
          prompt: "<the question you answered>",
          response: "<what you concluded>",
          derived_from: [<fingerprint ids, see below>])
```

Ask with `cache_query` rather than `cache_get` when starting: a later session rarely phrases the
question the same way, and semantic recall is what makes the entry findable at all.

### Fan-out: dispatching parallel agents over the same material

The measured case, and the one where most of the waste actually is. Eight subagents reviewing one
Go repository each read `pkg/fuse/fuse.go` cold; across the dispatch **60% of all reads were of a
file another subagent had already read**, about 243,000 redundant tokens.

Caching the *files* recovers none of that. The bytes still have to enter each agent's context, so
a hit costs what the read cost — and if an agent re-emits the file to write it, the dispatch ends
up **more** expensive than doing nothing. Sharing a *derivation* does recover it. On that file:

| approach | weighted tokens | vs. doing nothing |
|---|---|---|
| each agent reads the file | 125,864 | — |
| cache the file, agent re-emits it to write | 204,529 | **+63% worse** |
| cache the file, server reads it from disk | 125,864 | 0% — saves nothing |
| share a derivation, read source only where needed | 21,601 | **−83%** |
| …and each agent still reads one function after | 26,851 | **−79%** |

(Weighted as `input + 5 × output`, since output costs 5× input.)

So when dispatching parallel agents over shared material: have **one** agent read and derive,
`cache_set` the derivation, and give the rest the entry to start from. They read source only where
they need exact detail — which is why a derivation should carry line numbers and file paths rather
than trying to replace the code. Followers should use `cache_query`, since they will not phrase
the question the way the lead did.

Contexts in a dispatch are alive at the same time, and a write from one is immediately visible to
the others; `src/niche.test.ts` pins that, and separate parallel processes were verified to write
a shared cache without loss or contention.

**Put the protocol in the dispatch prompt — do not assume a subagent will find the cache.**
Measured on four dispatched agents asked one question a cached derivation fully answered: of the
two told nothing, **neither** consulted the cache; both went straight to grep and read. Of the two
told to check it first, both did, and one answered without opening a file at all. A cold context
does not know the cache exists, so whoever dispatches has to say so. One line is enough:

> An earlier agent cached an orientation for this codebase in the `nowhereman` MCP server. Check
> it with `cache_query` before reading any file.

Two practical notes from that run. `nowhereman`'s tools may be **deferred** in a subagent's
context — both compliant agents had to call `ToolSearch` before they could reach `cache_query`, so
say which tool you mean. And expect a follower to re-read source anyway when it needs precision:
the agent that answered from the derivation alone gave the right answer without line numbers,
while the one that also read the file gave line numbers. That is the trade a derivation makes, not
a failure of it.

For repeated dispatches, `.claude/agents/codebase-orienter.md` carries this protocol as an agent
definition, so it arrives with the cold context instead of depending on the dispatcher remembering.

### Keeping a derivation honest about its sources

A derivation goes wrong when its source changes underneath it, and a TTL cannot detect that. Record
a **fingerprint** entry per source file — the hash, never the contents, so it costs nothing — and
declare it as the derivation's `derived_from` parent:

```
cache_set(model: "source-fingerprint", prompt: "<path>", response: "<sha256>", ttl_seconds: null)
```

On a later session, re-hash the file and compare. If it moved,
`cache_invalidate(<fingerprint id>, cascade: true)` removes everything derived from it and leaves
derivations from untouched sources alone. `src/niche.test.ts` pins this behaviour.

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

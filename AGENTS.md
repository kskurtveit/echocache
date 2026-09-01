# echocache — MCP caching tool

This project ships the `echocache` MCP server: a **cache for LLM responses**, keyed like an HTTP
cache and read like a knowledge graph — `cache_get`/`cache_set` behave like `Cache-Control`
freshness against `(model, prompt, params)`, and `cache_query`/`cache_related` add semantic recall
of related past results. If you are an agent with `echocache`'s tools available (registered under
this or another project), follow the protocol below. If you're a human or agent working *on* this
repo's code, see `CLAUDE.md` too.

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

`cache_stats`'s `tokensServed` follows directly from this: it counts what the cache handed back,
which equals tokens *saved* only for entries that pass test 2. A cache full of file reads reports
a large, entirely fake savings figure — that is precisely why the field is named `tokensServed`
and not `tokensSaved`.

### The case with real numbers behind it: research and judgment calls

The clearest validated case, and the one `src/server.ts`'s tool descriptions described from the
start — "cached LLM response... before issuing an expensive prompt to a model." A multi-step web
search that ends in a synthesized recommendation, an expensive computed judgment, an analysis
requiring several tool calls to reach. **Not** locating code — grep already does that for less
than this cache costs to consult; see the fan-out section below for what that mistake costs.

Measured from this project's own session history, not estimated: a real 22-tool-call research
chain (board throughput specs, drive benchmarks) that ended in a 255-token engineering
recommendation cost **37,119 output tokens** to produce, by the actual usage numbers in the
transcript. Weighted at output = 5x input, that is ~185,679 weighted tokens to reproduce against
~255 to serve the cached answer back — a **728x** gap. Because the gap is this large, a single
reuse justifies the write (~1,275 weighted tokens to re-emit the conclusion) by roughly 145x. This
is the opposite of caching a file read, which loses at every hit rate regardless of size: here, one
hit anywhere in the future already pays for itself many times over.

Live-validated the same day on a different kind of content: a real web search on BM25 versus
learned sparse retrieval, synthesized into a design decision for `embed.ts`, cached, then recalled
by different wording (`cache_query` ranked it 0.69). The cache also surfaced a real precision risk
worth naming — an unrelated code-description entry sharing surface vocabulary ("sparse", "vector")
scored 0.54, close enough to be a plausible false positive in a sparser corpus. `niche.test.ts`
pins the correct ranking for this case.

**What this niche has not shown**: that it actually recurs. Mining this project's own history for
cross-session re-derivation of research or judgment calls found none — the same absence found for
codebase orientation. The economics above are real; whether anyone asks the same expensive question
twice is unproven and, in this one corpus, has not yet happened. Cache the conclusion anyway when
you reach one: the payoff on the first hit is large enough that low frequency is not disqualifying,
the way it was for file reads.

### A second, narrower case: re-orientation across sessions

You read a codebase to understand it, the session ends, and a later session needs that
understanding again. Caching the *files* saves nothing. Caching what you *concluded* can replace
the whole re-read — but only when the later session needs broad understanding rather than one
answer; a session that just needs one thing will grep for it more cheaply than the cache costs to
consult, the same lesson as the fan-out section below.

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

Parallel agents over one repository do duplicate a lot of reading. Measured across 30 subagents in
a real code-review dispatch, counting the bytes tool results actually returned: **374,000 tokens of
content that a sibling agent had already pulled into its own context**.

That number is real, and mostly *not* recoverable by this cache. Two measurements say so.

**Agents already read narrowly.** Of 166 `Read` calls in that dispatch, **127 used `offset`/`limit`** —
they grep first and pull a slice. Eight agents touched `pkg/fuse/fuse.go`, a 62KB file, and took
60,313 bytes between them, not 8 × 62,932. Any estimate built on "each agent reads the whole file"
is wrong by roughly 8x.

**Against that real behaviour, sharing a derivation loses.** For the same file: the lead reads it
whole to derive (62,932 B), seven followers take a ~2,000 B derivation → 76,624 B, against the
60,313 B the agents actually spent. **27% worse.**

The reason is worth internalising: **grep is already a cheap, precise pointer.** An agent that can
grep does not need a cached map to find where something lives — it needs about 900 tokens to locate
and read the relevant slice. A cached orientation competes with grep on grep's own ground and
loses, because it costs ~850 tokens to load and still leaves the read to do.

Measured directly on that comparison: agents given no cache spent **903 and 947 tokens** on tool
results; agents that consulted a cached orientation first spent **1,911 and 1,937** — twice as
much, for the same answer.

So do not dispatch a shared orientation expecting it to replace reading. What survives is narrower
and more specific:

- **Cache what grep cannot reconstruct.** A conclusion, a judgement, the reason something is the
  way it is, a cross-file synthesis no single search reveals, the fact that something is *absent*.
  Locations are not worth caching; grep finds them for less than the cache costs to consult.
- **The bigger the reasoning-to-text ratio, the better it pays.** An entry that took a long chain
  of reasoning to produce and is short to state is the ideal case. An entry that merely restates
  where code lives is the worst.

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
`ECHOCACHE_ENCRYPTION_KEY` can encrypt entry contents at rest — but neither makes it safe to
deliberately cache credentials. Don't route API keys, tokens, or private key material through
`cache_set`; re-reading the source is cheaper than leaking it.

## Non-goals

This is a cache, not a source of truth. A cache hit is never more authoritative than the real
computation it stands in for — if freshness matters and you're unsure, prefer redoing the work
over trusting a `stale` entry.

# echocache

An MCP server for a **cached LLM response** — the way an HTTP cache caches an expensive server
response, not the way a browser caches a static asset. For the agent who doesn't know where it's
going to, but doesn't need to redo the last mile of work to get there. ("He's a real nowhere
man... doesn't have a point of view" — but he does have a cache.)

Two lookup paths, inspired by two different kinds of caching:

- **Exact-match, HTTP-style** — `cache_get` / `cache_set` key on `(model, prompt, params)`, with
  `ttl_seconds` and `stale_while_revalidate_seconds` behaving like `Cache-Control`: fresh, stale,
  or expired.
- **Knowledge-graph recall** — every stored entry is a node in a small similarity graph.
  `cache_query` finds related entries by meaning, not just exact key; `cache_related` walks
  graph edges (auto-linked "similar" entries, or explicit "derived-from" parents) to surface
  everything already known before an agent redoes work from scratch. `cache_invalidate` can
  cascade through those `derived-from` edges when a source changes.

Runs as a standard stdio MCP server, so it works with Claude Code, Claude Desktop, Cursor, VS
Code + Copilot, or any other MCP-capable host — see [`CLAUDE.md`](./CLAUDE.md) for registration
commands and [`AGENTS.md`](./AGENTS.md) for the tool-use protocol any connected agent should
follow.

## What it's for — and what it isn't

Cache what an agent **concluded**, never what it **read**. This is the whole design, and it is
worth stating plainly because the intuitive use is the wrong one: serving a cached file read costs
the reader exactly the tokens that reading the file cost, since the content still has to enter the
context. So caching file reads saves nothing at any hit rate, and if the agent re-emits the file to
store it, that's output-rate tokens paid for zero benefit. A cache only pays when a hit stands in
for *regenerating* something.

Where it pays, and where measurement said it does not:

- **Pays best: an expensive research or judgment call.** A real 22-tool-call research chain in
  this project's own history cost 37,119 output tokens to reach a 255-token conclusion — a 728x
  gap against serving that conclusion back, weighted for output pricing. A single reuse pays for
  the write ~145x over. Live-validated the same way with a fresh web-search-derived design
  decision, correctly recalled by different wording and correctly outranking an unrelated entry
  sharing surface vocabulary. Not proven to recur yet in this project's own history — but the
  payoff on one hit is large enough that low frequency isn't disqualifying, unlike a file read.
- **Pays conditionally: re-orientation across sessions.** An agent reads a codebase to understand
  it, the session ends, and a later session needs that understanding again. On `express/lib` — six
  files, 62KB — re-reading the source costs 15,504 tokens against 549 to serve the cached
  orientation, about **28× fewer**. That holds when the later session genuinely needs broad
  understanding; if it only needs one specific answer, it will grep and read a slice for ~900
  tokens, and the cache isn't competitive.
- **Does not pay: replacing reads in a parallel dispatch.** Thirty subagents in one code-review
  dispatch pulled ~374,000 tokens of content a sibling had already read — but 127 of their 166
  reads used `offset`/`limit`, so they were already taking slices rather than whole files.
  Substituting a shared derivation for those slices measured **27% worse** than what they actually
  did: grep is already a cheap, precise pointer, and a cached map competes with it on its own
  ground and loses.

The rule all three point at: **cache what grep cannot reconstruct.** A conclusion, a judgement,
the reason something is the way it is, a cross-file synthesis no single search reveals, a
research finding, the fact that something is *absent*. Never a location — grep finds those for
less than the cache costs to consult — and never a file.

When a cached entry does carry file paths or line numbers, that is to point a reader at exact
detail, not to replace reading it. And reach for `cache_query` rather than `cache_get` when
looking for a match: a later session, or another agent, will not phrase the question the way the
writer did.

What this is not: a way to avoid reading files, a source of truth, or a substitute for
[prompt caching](https://docs.claude.com/en/docs/build-with-claude/prompt-caching) *within* one
conversation, which is cheaper and needs no server. echocache is for results that must outlive
the context that produced them.

### What Claude Code already does for free

If your only host is Claude Code, its own [persistent memory](https://docs.claude.com/en/docs/claude-code)
already does the core of this: write a conclusion to a memory file instead of the files it came
from, and a later session reads it back before redoing the work. That's the same rule this project
converged on, running for free, with no server to register. This project's own findings and
measurements from building it are stored there, not in echocache itself — worth noticing, since
it means the tool wasn't used to cache the very research that produced it.

What's actually different, in order of how much it matters:

- **Cross-project sharing.** Claude Code's memory is scoped to one project directory. echocache is
  one SQLite file any project on the machine can register against, so a conclusion reached in one
  repo is queryable from another. Real, but unproven: this project's own history shows zero
  instances of a conclusion actually getting reused across sessions, and cross-project reuse is a
  narrower bar than that.
- **Semantic recall.** `cache_query` finds a match by meaning, independent of how it was phrased or
  which file it's filed under. Memory is retrieved by an always-loaded index plus the agent's own
  judgment about what to open — no vector search.
- **Host-agnostic.** Works from Cursor, VS Code, Claude Desktop, or any other MCP client — memory
  is native to Claude Code specifically.
- **Explicit freshness.** TTL/stale-while-revalidate freshness and hash-based `derived_from`
  invalidation catch a source going stale automatically. Memory has neither; staleness is caught
  only if an agent happens to notice.

For a single user on a single host in one project, memory already captures most of the value here
for free. What's left as echocache's actual case is narrower than "a cache for LLM responses":
it's specifically sharing a derivation across projects or hosts that don't already share a memory
store — and that narrower case is unproven, not just untested, until it's been measured the way
everything else in this document has.

## Quickstart

```sh
npm install
npm start
```

Then register it with an MCP host — for Claude Code:

```sh
claude mcp add echocache -- npx tsx /path/to/echocache/src/index.ts
```

## Tools

| Tool               | Purpose                                                                |
|---------------------|--------------------------------------------------------------------------|
| `cache_get`         | Exact-match lookup with fresh / stale / expired freshness                |
| `cache_set`         | Store a result; auto-links it into the similarity graph                  |
| `cache_query`       | Semantic search across all cached entries                                |
| `cache_related`     | Graph traversal from one entry to entries linked to it                   |
| `cache_invalidate`  | Delete an entry, optionally cascading to its dependents                  |
| `cache_stats`       | Exact-match hit rate, `queryHits`/`queryMisses`, and tokens served       |

Data persists to SQLite at `$ECHOCACHE_DB_PATH` (default `~/.echocache/cache.db`), shared
across every project that registers the server.

# nowhereman

An MCP caching server — for the agent who doesn't know where it's going to, but doesn't need to
redo the last mile of work to get there. ("He's a real nowhere man... doesn't have a point of
view" — but he does have a cache.)

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

Cache what an agent **concluded**, never what it **read**.

This is the whole design, and it is worth stating plainly because the intuitive use is the wrong
one. Serving a cached file read costs the reader exactly the tokens that reading the file cost —
the content still has to enter the context. So caching file reads saves nothing at any hit rate,
and if the agent re-emits the file to store it, you have paid output-rate tokens for zero benefit.
A cache only pays when a hit stands in for *regenerating* something.

Two cases where it does pay, both measured:

- **Re-orientation across sessions.** An agent reads a codebase to understand it; the session
  ends; a later session needs that understanding again. On `express/lib` — six files, 62KB —
  re-reading the source costs 15,504 tokens against 549 to serve the cached orientation, about
  **28× fewer**, repaid on the first reuse.
- **Fan-out across parallel agents.** In a real dispatch of 30 subagents over one repository, 60%
  of all file reads were of a file another subagent had already read — roughly 243,000 redundant
  tokens. Having one agent read and derive, then sharing that derivation, came out **79% cheaper**
  across eight agents even when each still read one function for exact detail.

So a derivation should carry file paths and line numbers rather than trying to replace the code,
and consumers should reach for `cache_query` rather than `cache_get` — a later session, or a
sibling agent, will not phrase the question the way the writer did.

What this is not: a way to avoid reading files, a source of truth, or a substitute for
[prompt caching](https://docs.claude.com/en/docs/build-with-claude/prompt-caching) *within* one
conversation, which is cheaper and needs no server. nowhereman is for results that must outlive
the context that produced them.

## Quickstart

```sh
npm install
npm start
```

```sh
claude mcp add nowhereman -- npx tsx /path/to/nowhereman/src/index.ts
```

## Tools

| Tool               | Purpose                                                                |
|---------------------|--------------------------------------------------------------------------|
| `cache_get`         | Exact-match lookup with fresh / stale / expired freshness                |
| `cache_set`         | Store a result; auto-links it into the similarity graph                  |
| `cache_query`       | Semantic search across all cached entries                                |
| `cache_related`     | Graph traversal from one entry to entries linked to it                   |
| `cache_invalidate`  | Delete an entry, optionally cascading to its dependents                  |
| `cache_stats`       | Hit rate and tokens served from cache                                    |

Data persists to SQLite at `$NOWHEREMAN_DB_PATH` (default `~/.nowhereman/cache.db`), shared
across every project that registers the server.

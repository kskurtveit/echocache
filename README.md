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

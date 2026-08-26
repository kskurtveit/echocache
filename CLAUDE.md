@AGENTS.md

# Developing nowhereman

nowhereman is a Model Context Protocol server exposing a cache with two lookup paths:

- **Exact match** (`cache_get` / `cache_set`): sha256 of `(model, normalized prompt, params)` →
  response, with HTTP-style `ttl_seconds` / `stale_while_revalidate_seconds` freshness, mirroring
  `Cache-Control` semantics.
- **Similarity graph** (`cache_query` / `cache_related`): every entry is a node; nodes whose
  content embeddings are above a cosine-similarity threshold are auto-linked with a `similar`
  edge (feature-hashed bag-of-words vectors — see `src/embed.ts` — deliberately not a neural
  embedding model, since pulling one in would cost more than the work the cache is trying to
  save). `derived_from` at write time adds explicit `derived-from` edges, which
  `cache_invalidate(cascade: true)` walks to clean up dependents.

## Layout

- `src/embed.ts` — local text embedding (feature hashing) + cosine similarity, no external deps or network.
- `src/db.ts` — SQLite schema (`nodes`, `edges`, `stats`) via better-sqlite3.
- `src/store.ts` — cache/graph logic: key hashing, freshness computation, similarity linking, BFS traversal.
- `src/server.ts` — MCP tool registration (`@modelcontextprotocol/server`), wires tools to `CacheStore`.
- `src/index.ts` — stdio entrypoint.

## Running

```
npm install
npm start            # or: npm run dev (watch mode)
npm run inspect       # MCP Inspector, for calling tools by hand
npm run typecheck
```

Cache data lives at `$NOWHEREMAN_DB_PATH` (default `~/.nowhereman/cache.db`) — shared across
every project that registers this server, since a cached response is reusable regardless of
which project asked for it.

## Registering with a host

**Claude Code**
```
claude mcp add nowhereman -- npx tsx /path/to/nowhereman/src/index.ts
```

**Cursor / VS Code** — add a stdio entry to `.cursor/mcp.json` / `.vscode/mcp.json`:
```json
{ "command": "npx", "args": ["tsx", "/path/to/nowhereman/src/index.ts"] }
```

Any other MCP-capable host takes the same launch command; only the config file differs.

## Conventions

- No comments beyond a rare one-liner for non-obvious *why*.
- `stdout` is the JSON-RPC channel — never `console.log`; use `console.error` for anything diagnostic.
- Keep `src/embed.ts` dependency-free; if real semantic embeddings are ever needed, add them as a
  swappable second implementation behind the same `embed()` / `cosineSimilarity()` interface
  rather than replacing it.

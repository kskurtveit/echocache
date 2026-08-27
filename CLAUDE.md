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
- `src/config.ts` — env-var configuration with validation; `loadConfig()` throws on bad input.
- `src/db.ts` — SQLite schema (`nodes`, `edges`, `stats`) via better-sqlite3.
- `src/store.ts` — cache/graph logic: key hashing, freshness computation, similarity linking, BFS traversal, eviction.
- `src/server.ts` — MCP tool registration (`@modelcontextprotocol/server`), wires tools to `CacheStore`.
- `src/index.ts` — stdio entrypoint.
- `src/*.test.ts` — `node:test` suites, run via `tsx --test`.

## Running

```
npm install
npm start            # or: npm run dev (watch mode)
npm run inspect      # MCP Inspector, for calling tools by hand
npm run check        # typecheck + tests — run this before committing
```

## Configuration

All settings are environment variables, read once at startup by `loadConfig()`:

| Variable | Default | Meaning |
|---|---|---|
| `NOWHEREMAN_DB_PATH` | `~/.nowhereman/cache.db` | SQLite file location |
| `NOWHEREMAN_MAX_ENTRIES` | `10000` | LRU ceiling on retained entries |
| `NOWHEREMAN_MAX_BYTES` | `268435456` (256MB) | LRU ceiling on retained response bytes |
| `NOWHEREMAN_DEFAULT_TTL_SECONDS` | `86400` (1 day) | Freshness lifetime when a caller omits one |
| `NOWHEREMAN_SIMILARITY_THRESHOLD` | `0.85` | Cosine floor for auto-linking a `similar` edge |
| `NOWHEREMAN_LINK_CANDIDATE_POOL` | `500` | Recent entries a new write is compared against |

The cache is shared across every project that registers this server, since a cached response is
reusable regardless of which project asked for it.

**Eviction** runs on every write (`enforceLimits()`): fully-expired entries are dropped first,
then least-recently-used entries until both ceilings are satisfied. Entries with `ttl_seconds:
null` never expire but are still subject to the LRU ceilings.

## Testing

`npm test` runs every `src/**/*.test.ts` through `tsx --test` (`node:test`, no external runner):

- `store.test.ts` — cache semantics against a real temp SQLite file, not a mock.
- `server.test.ts` — drives the actual MCP server through a real `Client` over an in-process
  transport, so tool schemas and error paths are exercised the way a host would.
- `config.test.ts` — env parsing and validation.

CI (`.github/workflows/ci.yml`) runs typecheck + tests on Node 20 and 22 for every push and PR.

When a similarity assertion fails, check the real cosine value before adjusting the test — the
threshold is 0.85 and near-miss phrasings often land just under it.

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
- A cache failure must surface as an `isError` tool result, never as a silent miss — a miss tells
  the model "go do the work," which is safe; fabricated or swallowed errors are not. `guard()` in
  `src/server.ts` enforces this.
- Never `SELECT *` from `nodes` in a hot path — `response` bodies dominate row size, so scoring
  and scanning queries select `id, embedding` and fetch full rows only for the winners.

## Not yet done (pre-release)

The package is `private: true` and has no `bin`/build step — it runs from source via `tsx`. Before
any npm publish it needs: a compiled `dist/`, a `bin` entry pointing at compiled JS with a
shebang, a `files` allowlist, and removal of `private`.

Responses are stored **unencrypted** on disk. Anything an agent caches — file contents, API
responses — is readable by any process with access to the DB file. Don't route secrets through it.

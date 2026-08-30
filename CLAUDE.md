@AGENTS.md

# Developing nowhereman

nowhereman is a Model Context Protocol server exposing a cache with two lookup paths:

- **Exact match** (`cache_get` / `cache_set`): sha256 of `(model, normalized prompt, params)` →
  response, with HTTP-style `ttl_seconds` / `stale_while_revalidate_seconds` freshness, mirroring
  `Cache-Control` semantics.
- **Similarity graph** (`cache_query` / `cache_related`): every entry is a node; nodes whose
  content embeddings are above a similarity threshold are auto-linked with a `similar`
  edge (sparse feature-hashed bag-of-words vectors, IDF-weighted at scoring time — see
  `src/embed.ts` — deliberately not a neural embedding model, since pulling one in would cost
  more than the work the cache is trying to save). `derived_from` at write time adds explicit `derived-from` edges, which
  `cache_invalidate(cascade: true)` walks to clean up dependents.

## Layout

- `src/embed.ts` — local text embedding (sparse feature hashing) + IDF-weighted scoring, no external deps or network.
- `src/config.ts` — env-var configuration with validation; `loadConfig()` throws on bad input.
- `src/crypto.ts` — optional AES-256-GCM at-rest encryption and the keyed cache-key digest.
- `src/db.ts` — SQLite schema (`nodes`, `edges`, `stats`, `meta`, `doc_freq`) via better-sqlite3.
- `src/store.ts` — cache/graph logic: key hashing, freshness computation, similarity linking, BFS traversal, eviction.
- `src/server.ts` — MCP tool registration (`@modelcontextprotocol/server`), wires tools to `CacheStore`.
- `src/index.ts` — stdio entrypoint.
- `src/*.test.ts` — `node:test` suites, run via `tsx --test`. `retrieval.test.ts` pins search
  quality at the shipped defaults and `niche.test.ts` pins the cross-session recall the product
  exists for; see Testing below.

## Module reference

### `embed.ts` — embedding and scoring

Vectors are **sparse**: `{ buckets: Int32Array, values: Float32Array }`, ascending by bucket.
Values are damped term frequency (`1 + log tf`), signed, and deliberately unnormalized — IDF is
applied at scoring time so stored vectors never go stale as the corpus grows.

| Export | Purpose |
|---|---|
| `embed(text): Embedding` | Tokenize (splitting camelCase) and feature-hash into a sparse vector |
| `idfWeights(stats: CorpusStats): Float32Array` | Dense IDF lookup over the hash space, built once per operation |
| `documentSimilarity(a, b, weights): number` | Symmetric score for auto-linking; both sides full entries |
| `prepareQuery(query, weights): PreparedQuery` | Scatter a query to dense + precompute its norm, once per search |
| `queryScore(query, doc, weights): number` | Asymmetric short-query-to-long-entry score, 0–1 |
| `toBuffer` / `fromBuffer` | Wire format: one Int32 bucket + one Float32 value per occupied bucket |
| `HASH_SPACE` | 16384 |

Types: `Embedding`, `CorpusStats` (`{ docCount, docFreq: Map<bucket, count> }`, supplied by
`CacheStore.corpusStats()` from the `doc_freq` table), `PreparedQuery`.
Internal: `fnv1a`, `tokenize`, `idf`, `weightedNorm`, `toDense`.
Tuning constants, all calibrated in `retrieval.test.ts`: `HASH_SPACE` 16384, `BREADTH_PENALTY`
0.25, `MIN_EFFECTIVE_CORPUS` 20.

### `store.ts` — cache and graph logic

`CacheStore` is the whole surface; `computeKeyHash(model, prompt, params, cipher?)` is exported
separately for tests. Types: `NodeRow`, `CacheEntry`, `RelatedEntry`, `QueryMatch`.

| Method | Purpose |
|---|---|
| `get(model, prompt, params?)` | Exact-match lookup; counts hits/misses and `tokens_served` |
| `set(opts)` | Insert or replace, link into the graph, enforce limits; returns `{ id, linkedTo, evicted }` |
| `query(text, opts?)` | Semantic search; floor defaults to `DEFAULT_QUERY_FLOOR` (0.3). Records access on every match — a recall is a use, and an entry reachable only by meaning would otherwise look untouched to LRU |
| `related(id, opts?)` | BFS over edges, optionally filtered to one relation |
| `invalidate(id, opts?)` | Delete, optionally cascading through `derived-from` dependents |
| `stats()` | Counts, exact-match hit rate, `queryHits`/`queryMisses`, `tokensServed`, evictions, bytes, top entries |
| `enforceLimits()` | Drop expired entries, then LRU down to the entry and byte ceilings |

Private: `migrateEmbeddings` (re-embeds on `EMBEDDING_VERSION` change), `addToDocFreq` /
`removeFromDocFreq` / `corpusStats` (document-frequency bookkeeping),
`assertKeyMatchesDatabase`, `seal` / `open` (encryption), `toEntry`, `deleteNode`.

### `crypto.ts` — `Cipher`

`Cipher.fromHex(hex)` (64 hex chars, rejects anything shorter rather than stretching it) and
`Cipher.generateKeyHex()`. Instance: `encrypt`, `decrypt`, `digest` (keyed cache-key HMAC),
`makeVerifier` / `matchesVerifier` (constant-time key/database match check).

### `db.ts`, `config.ts`, `server.ts`, `index.ts`

`openDb(path)` creates the schema and locks permissions to the owner; `getMeta` / `setMeta` /
`bump` / `getStat` are the small helpers over `meta` and `stats`.
`loadConfig()` reads and validates every env var, throwing on bad input; `DEFAULT_CONFIG` is the
same values as literals for tests.
`createServer(db, config?)` registers the six tools, each wrapped in `guard()` so a failure
surfaces as an `isError` result rather than a silent miss.
`main()` in `index.ts` wires config → db → server on stdio, failing loudly at startup.

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
| `NOWHEREMAN_SIMILARITY_THRESHOLD` | `0.25` | Similarity floor for auto-linking a `similar` edge |
| `NOWHEREMAN_LINK_CANDIDATE_POOL` | `500` | Recent entries a new write is compared against |
| `NOWHEREMAN_ENCRYPTION_KEY` | unset | 64 hex chars (32 bytes); enables at-rest encryption |

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

The `test` script's glob is **unquoted on purpose** (`src/*.test.ts`, not `"src/**/*.test.ts"`):
Node 20's `--test` does not expand glob patterns itself — that arrived in Node 21 — so a quoted
pattern is passed through literally and the run fails with "Could not find". Leaving it unquoted
lets the shell expand it, which works on both supported versions. This also means test files must
stay flat in `src/`; a nested one would be silently skipped.

`niche.test.ts` pins the use case the product is *for*: a derivation outliving the session that
produced it, recalled later by different wording, with fingerprint parents so a changed source can
cascade-invalidate what was derived from it. If a change breaks these, the cache no longer does
the one thing it is worth running for — measured at ~28x fewer tokens than re-reading `express/lib`
(15,504 → 549). Caching file reads is *not* in scope and saves nothing; see `AGENTS.md`.

`retrieval.test.ts` is the calibration suite: it runs at the **shipped defaults**, with no
threshold overrides, over long documents and short queries. Every threshold in `embed.ts` and
`config.ts` was chosen from measurements against it, so when a similarity assertion fails, check
the real score before adjusting a threshold — and never "fix" a retrieval test by passing it a
lower `minSimilarity` than a real caller gets. That is precisely how the original defaults came
to be unusable while 89 tests passed: the auto-link test compared near-duplicates with identical
responses, and the query test overrode the floor to 0.3 when the shipped default was 0.5.

**The registered server is a running process, not the working tree.** After changing `src/`, an
already-registered `nowhereman` keeps serving the old code until the host restarts it — the tell is
`cache_stats` still reporting a field you renamed, or `cache_query` behaving the way it did before
your fix. Verified the confusing way: a dogfooding query returned `[]` against a stale server while
the same query scored 0.69 against the same database with the current code. Restart the host (or
`claude mcp remove nowhereman && claude mcp add ...`) before trusting a live result.

Renaming a `stats` key also resets that counter, since the old row is still stored under the old
key. `tokens_saved` -> `tokens_served` cost the historical total; that was a deliberate trade for an
honest name.

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
  swappable second implementation behind the same `embed()` / `documentSimilarity()` /
  `queryScore()` interface rather than replacing it.
- Document frequency (`doc_freq`) must stay in step with `nodes`. Every path that adds or removes
  an entry — write, overwrite, eviction, invalidate — adjusts it, and `store.test.ts` asserts the
  stored counts equal a from-scratch recount. Drift there silently degrades every later score.
- A cache failure must surface as an `isError` tool result, never as a silent miss — a miss tells
  the model "go do the work," which is safe; fabricated or swallowed errors are not. `guard()` in
  `src/server.ts` enforces this.
- `cache_stats` reports `tokensServed`, not "tokens saved". The cache knows what it handed back;
  it cannot know what producing that entry cost, and the two differ sharply — serving a cached
  file read costs the caller exactly what re-reading would, so it saves nothing. The stat was
  called `estimatedTokensSaved` and vouched for a usage pattern that loses tokens. Don't
  reintroduce a savings figure unless callers declare production cost at `cache_set` time.
- Never `SELECT *` from `nodes` in a hot path — `response` bodies dominate row size, so scoring
  and scanning queries select `id, embedding` and fetch full rows only for the winners.

## Security

The cache holds whatever agents put through it — file contents, API responses. Two layers:

- **Always on**: the DB directory is created `0700` and the DB/WAL/SHM files are `0600`, so
  default umask can't leave the cache group- or world-readable on a shared machine.
- **Opt-in**: set `NOWHEREMAN_ENCRYPTION_KEY` to encrypt the `prompt` and `response` columns with
  AES-256-GCM (random IV per value). With a key set, the cache key becomes an HMAC rather than a
  plain SHA-256 — otherwise a DB reader could confirm a guessed prompt by hashing it.

```sh
export NOWHEREMAN_ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
```

A key/database mismatch is refused at startup with an actionable message rather than surfacing as
an opaque decryption failure on some later read. Turning encryption on or off requires a fresh DB
(`NOWHEREMAN_DB_PATH`) — there is no in-place migration.

**What encryption does not protect**: the key comes from the environment of the same machine, so
anyone who can read that environment or process memory can read the cache. It protects the file at
rest — backups, disk images, another user on the box — not a compromised host. `model`, `params`,
`tags`, timestamps, and the embedding vector remain unencrypted.

## Packaging

`npm run build` compiles to `dist/` via `tsconfig.build.json` (tests excluded, declarations and
sourcemaps on) and marks `dist/index.js` executable; the shebang makes it directly runnable. The
`files` allowlist keeps the tarball to `dist` plus docs — verify with `npm pack --dry-run`.

The package is still `private: true`: publishing is a deliberate future step, not something to
trip into. Removing that flag is the only remaining gate — `prepublishOnly` already runs
`check` + `build`.

@AGENTS.md

# Developing echocache

echocache is a Model Context Protocol server exposing a cache with two lookup paths:

- **Exact match** (`cache_get` / `cache_set`): sha256 of `(model, normalized prompt, params)` →
  response, with HTTP-style `ttl_seconds` / `stale_while_revalidate_seconds` freshness, mirroring
  `Cache-Control` semantics.
- **Similarity graph** (`cache_query` / `cache_related`): every entry is a node; nodes whose
  content embeddings are above a similarity threshold are auto-linked with a `similar`
  edge (sparse feature-hashed bag-of-words vectors, IDF-weighted at scoring time — see
  `src/embed.ts` — deliberately not a neural embedding model, since pulling one in would cost
  more than the work the cache is trying to save). `derived_from` at write time adds explicit `derived-from` edges, which
  `cache_invalidate(cascade: true)` walks to clean up dependents.

The product this exists to be: **a cached LLM response** for work that was expensive to *produce* —
a research chain, a derived judgment, a long generation — never a cached file read, which costs a
hit the same tokens the read would have cost anyway and so can't pay off at any hit rate. That
distinction, not a feature list, is why retrieval quality gets the amount of scrutiny it does below
(`niche.test.ts`, `retrieval.test.ts`): a response cache is only worth running if `cache_query`
actually finds the thing later, worded differently than it was written. See `AGENTS.md` for the
full case, including what's measured and what isn't yet.

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
separately for tests. A module-level `freshness(row, now)` computes `{ageSeconds, fresh, stale,
expired}` from a row's TTL fields and is shared by `toEntry()` and `query()`'s scan-time filter, so
the two can't disagree on what counts as expired. Types: `NodeRow`, `CacheEntry`, `RelatedEntry`,
`QueryMatch`.

| Method | Purpose |
|---|---|
| `get(model, prompt, params?)` | Exact-match lookup; counts hits/misses and `tokens_served` |
| `set(opts)` | Insert or replace, link into the graph, enforce limits; returns `{ id, linkedTo, evicted }` |
| `query(text, opts?)` | Semantic search; floor defaults to `DEFAULT_QUERY_FLOOR` (0.3). Records access on every match — a recall is a use, and an entry reachable only by meaning would otherwise look untouched to LRU |
| `related(id, opts?)` | BFS over edges, optionally filtered to one relation |
| `invalidate(id, opts?)` | Delete, optionally cascading through `derived-from` dependents |
| `stats()` | Counts, exact-match hit rate, `queryHits`/`queryMisses`, `tokensServed`, evictions, bytes, top entries |
| `enforceLimits()` | Drop expired entries, then LRU down to the entry and byte ceilings |

`set()`'s core (doc-freq bookkeeping + the insert/update itself) runs inside a
`this.db.transaction(fn).immediate()` block, not as separate statements — see Concurrency below.

Private: `nodeCount` (single shared `SELECT COUNT(*)`, replacing three duplicated queries),
`migrateEmbeddings` (re-embeds on `EMBEDDING_VERSION` change), `addToDocFreq` /
`removeFromDocFreq` / `corpusStats` (document-frequency bookkeeping),
`assertKeyMatchesDatabase`, `seal` / `open` (encryption), `toEntry`, `deleteNode` (atomic
`DELETE ... RETURNING`, see Concurrency below).

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
surfaces as an `isError` result rather than a silent miss. `cipherFor(config)` (shared by
`createServer` and `validateConfig`) builds the optional `Cipher` from `config.encryptionKeyHex`,
so the two can't quietly diverge on what "the configured cipher" means. `validateConfig(db,
config?)` runs the same startup checks (`CacheStore` construction: cipher parsing, key/database
match, embedding migration) without building the `McpServer` — for validating a database once at
startup before committing to the real, connection-scoped construction.
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
| `ECHOCACHE_DB_PATH` | `~/.echocache/cache.db` | SQLite file location |
| `ECHOCACHE_MAX_ENTRIES` | `10000` | LRU ceiling on retained entries |
| `ECHOCACHE_MAX_BYTES` | `268435456` (256MB) | LRU ceiling on retained response bytes |
| `ECHOCACHE_DEFAULT_TTL_SECONDS` | `86400` (1 day) | Freshness lifetime when a caller omits one |
| `ECHOCACHE_SIMILARITY_THRESHOLD` | `0.25` | Similarity floor for auto-linking a `similar` edge |
| `ECHOCACHE_LINK_CANDIDATE_POOL` | `500` | Recent entries a new write is compared against |
| `ECHOCACHE_ENCRYPTION_KEY` | unset | 64 hex chars (32 bytes); enables at-rest encryption |

The cache is shared across every project that registers this server, since a cached response is
reusable regardless of which project asked for it.

**Eviction** runs on every write (`enforceLimits()`): fully-expired entries are dropped first,
then least-recently-used entries until both ceilings are satisfied. Entries with `ttl_seconds:
null` never expire but are still subject to the LRU ceilings.

**Concurrency:** the cache is designed to be shared across every project that registers the
server, so concurrent readers and writers from separate processes are the normal case, not an edge
case. `db.ts` sets `busy_timeout = 5000` so a second connection's write colliding with an
in-progress one waits up to 5s instead of failing immediately with `SQLITE_BUSY`. `set()`'s
read-modify-write (checking the existing embedding, then inserting/updating, then updating
`doc_freq`) runs inside `this.db.transaction(fn).immediate()`, which takes the write lock before
its first read — without `.immediate()`, two concurrent writers could both read stale state before
either wrote, and go stale together. `deleteNode()` is a single `DELETE ... RETURNING embedding`
rather than a separate `SELECT` then `DELETE`, for the same reason: a read-then-write pair always
leaves a window for another writer to act in between. Both were real bugs found and fixed this way
during code review, each verified with a test that injects a concurrent write from inside the
first read to confirm it's actually rejected — a test that merely checks "does a lock eventually
cause a failure" doesn't discriminate the fix from the bug, since SQLite blocks on lock contention
either way.

**Known scaling boundary, not yet a problem:** `enforceLimits()` runs its three passes (expiry,
entry-count LRU, byte-ceiling LRU) as three separate table scans, and `corpusStats()`/`idfWeights()`
rebuild a dense IDF array from a full `doc_freq` scan on every `set()` and `query()`. Both are
O(entries) per call, capped by `ECHOCACHE_MAX_ENTRIES` at 10,000 — fine at that scale, unmeasured
above it. Folding the eviction passes into one, or maintaining IDF weights incrementally rather
than recomputing them, would both add real correctness risk (eviction ordering, keeping
incremental state from drifting from a full recount) to score against a performance problem that
hasn't been shown to exist yet. Revisit with a measurement, not preemptively.

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

`niche.test.ts` pins the cases this product actually stands on, in order of how well-validated
each is. Strongest: a cached research/judgment conclusion recalled correctly and outranking an
unrelated entry that shares surface vocabulary — the precision property behind the measured 728x
gap between reproducing a real 22-tool-call research chain (37,119 output tokens, from this
project's own history) and serving its 255-token conclusion back. Narrower: a derivation outliving
the session that produced it, recalled by different wording, with fingerprint parents so a changed
source can cascade-invalidate what was derived from it — measured at ~28x on `express/lib`, but
only pays when the later need is broad understanding rather than one answer. Also covered: fan-out
across live concurrent contexts, and that concurrent writes don't get lost. If a change breaks any
of these, the cache no longer does the thing it's worth running for. Caching file reads or
locating code is *not* in scope and does not pay at any hit rate; see `AGENTS.md` for the full
case, including the fan-out measurement that shows why a cached map loses to grep.

`retrieval.test.ts` is the calibration suite: it runs at the **shipped defaults**, with no
threshold overrides, over long documents and short queries. Every threshold in `embed.ts` and
`config.ts` was chosen from measurements against it, so when a similarity assertion fails, check
the real score before adjusting a threshold — and never "fix" a retrieval test by passing it a
lower `minSimilarity` than a real caller gets. That is precisely how the original defaults came
to be unusable while 89 tests passed: the auto-link test compared near-duplicates with identical
responses, and the query test overrode the floor to 0.3 when the shipped default was 0.5.

**The registered server is a running process, not the working tree.** After changing `src/`, an
already-registered `echocache` keeps serving the old code until the host restarts it — the tell is
`cache_stats` still reporting a field you renamed, or `cache_query` behaving the way it did before
your fix. Verified the confusing way: a dogfooding query returned `[]` against a stale server while
the same query scored 0.69 against the same database with the current code. Restart the host (or
`claude mcp remove echocache && claude mcp add ...`) before trusting a live result.

Renaming a `stats` key also resets that counter, since the old row is still stored under the old
key. `tokens_saved` -> `tokens_served` cost the historical total; that was a deliberate trade for an
honest name.

## Registering with a host

**Claude Code**
```
claude mcp add echocache -- npx tsx /path/to/echocache/src/index.ts
```

**Cursor / VS Code** — add a stdio entry to `.cursor/mcp.json` / `.vscode/mcp.json`:
```json
{ "command": "npx", "args": ["tsx", "/path/to/echocache/src/index.ts"] }
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
- `db.ts`'s `CREATE TABLE IF NOT EXISTS` has no migration path for a *column* added to an
  existing table — it only handles a whole table being new, which is why adding `doc_freq` was
  safe. A future column added to `nodes` on top of a database that predates it will fail with
  "no such column" rather than migrating, unlike the embedding format (`EMBEDDING_VERSION` /
  `migrateEmbeddings`) or encryption state (`assertKeyMatchesDatabase`), both of which fail loudly
  or migrate rather than silently misbehaving. Deliberately not built ahead of a need: there is no
  pending schema change to migrate, and the package is still unpublished. Follow the existing
  version-stamp-in-`meta` pattern when one is actually needed, rather than adding a generic
  migration framework speculatively.
- A cache failure must surface as an `isError` tool result, never as a silent miss — a miss tells
  the model "go do the work," which is safe; fabricated or swallowed errors are not. `guard()` in
  `src/server.ts` enforces this — but only around a tool handler's body. It does not reach a
  failure during server *construction*: `createServer`'s factory (passed to `serveStdio` in
  production, and to `createMcpHandler` per-request in `server.test.ts`) can be re-invoked after
  startup — a connection reconnecting, or a test harness serving one `McpServer` per request — and
  an exception thrown building that instance is outside `guard()`'s reach, surfacing as a raw
  transport failure rather than a clean `isError`. Found by removing an overly-broad catch in
  `assertKeyMatchesDatabase` and watching `server.test.ts`'s "the server still answers other
  requests after a failure" break — the fix was narrowing the check's scope so a genuine error
  there stays rare enough not to matter (see the comment on that function), not widening `guard()`
  to cover construction. If a future change makes server construction itself fail more often,
  that gap gets real and needs its own fix — a construction failure would need to become a
  synthetic `isError` result somehow, not just propagate.
- `cache_stats` reports `tokensServed`, not "tokens saved". The cache knows what it handed back;
  it cannot know what producing that entry cost, and the two differ sharply — serving a cached
  file read costs the caller exactly what re-reading would, so it saves nothing. The stat was
  called `estimatedTokensSaved` and vouched for a usage pattern that loses tokens. Don't
  reintroduce a savings figure unless callers declare production cost at `cache_set` time.
- Never `SELECT *` from `nodes` in a hot path — `response` bodies dominate row size, so scoring
  and scanning queries select `id, embedding` and fetch full rows only for the winners.
- Commits written with AI assistance carry an `Assisted-by: Claude Code (<model>)` trailer, not
  `Co-Authored-By:`. The work here is genuinely AI-assisted and the trailer says so — but a model
  cannot hold copyright, sign a CLA, or bear liability, so naming one as co-author clouds the
  chain of title this project's MIT license rests on. `Assisted-by:` is the trailer the wider
  ecosystem has converged on for exactly that reason. History was rewritten once, before the repo
  went public, to apply this uniformly; commit contents were untouched (verified by identical tree
  hashes).

## Security

The cache holds whatever agents put through it — file contents, API responses. Two layers:

- **Always on**: the DB directory is created `0700` and the DB/WAL/SHM files are `0600`, so
  default umask can't leave the cache group- or world-readable on a shared machine.
- **Opt-in**: set `ECHOCACHE_ENCRYPTION_KEY` to encrypt the `prompt` and `response` columns with
  AES-256-GCM (random IV per value). With a key set, the cache key becomes an HMAC rather than a
  plain SHA-256 — otherwise a DB reader could confirm a guessed prompt by hashing it.

```sh
export ECHOCACHE_ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
```

A key/database mismatch is refused at startup with an actionable message rather than surfacing as
an opaque decryption failure on some later read. Turning encryption on or off requires a fresh DB
(`ECHOCACHE_DB_PATH`) — there is no in-place migration.

**What encryption does not protect**: the key comes from the environment of the same machine, so
anyone who can read that environment or process memory can read the cache. It protects the file at
rest — backups, disk images, another user on the box — not a compromised host. `model`, `params`,
`tags`, timestamps, and the embedding vector remain unencrypted.

## Packaging

`npm run build` compiles to `dist/` via `tsconfig.build.json` (tests excluded, declarations and
sourcemaps on) and marks `dist/index.js` executable; the shebang makes it directly runnable. The
`files` allowlist keeps the tarball to `dist` plus docs — verify with `npm pack --dry-run`.

`server.json` at the repo root is the manifest for the official [MCP Server
Registry](https://modelcontextprotocol.io/registry/quickstart): its `name` must match
`package.json`'s `mcpName` (`io.github.kskurtveit/echocache`), and both `version` fields must be
bumped together with the npm version on every release. Publishing there is a separate step from
`npm publish` — the registry only stores metadata pointing at the npm package, via the
`mcp-publisher` CLI (`mcp-publisher login github` then `mcp-publisher publish`).

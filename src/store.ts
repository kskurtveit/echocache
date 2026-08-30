import { randomUUID, createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { bump, getStat, getMeta, setMeta } from './db.js';
import {
    embed,
    idfWeights,
    documentSimilarity,
    queryScore,
    prepareQuery,
    toBuffer,
    fromBuffer,
    type Embedding,
    type CorpusStats
} from './embed.js';
import { DEFAULT_CONFIG, type Config } from './config.js';
import type { Cipher } from './crypto.js';

export interface NodeRow {
    id: string;
    key_hash: string;
    model: string;
    prompt: string;
    response: string;
    params_json: string;
    tags_json: string;
    embedding: Buffer;
    created_at: number;
    last_accessed_at: number;
    hit_count: number;
    ttl_seconds: number | null;
    stale_while_revalidate_s: number;
    estimated_tokens: number;
}

export interface CacheEntry {
    id: string;
    model: string;
    prompt: string;
    response: string;
    params: Record<string, unknown>;
    tags: string[];
    createdAt: number;
    lastAccessedAt: number;
    hitCount: number;
    ageSeconds: number;
    ttlSeconds: number | null;
    fresh: boolean;
    stale: boolean;
    expired: boolean;
}

export interface RelatedEntry extends CacheEntry {
    relation: string;
    weight: number;
    depth: number;
}

export interface QueryMatch extends CacheEntry {
    similarity: number;
}

/** Stable stringify: object keys sorted recursively, so key order never affects the hash. */
function stableStringify(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

function normalizePrompt(prompt: string): string {
    return prompt.trim().replace(/\s+/g, ' ');
}

export function computeKeyHash(
    model: string,
    prompt: string,
    params: Record<string, unknown>,
    cipher?: Cipher
): string {
    const payload = stableStringify({ model, prompt: normalizePrompt(prompt), params });
    // With encryption on, key the digest — an unkeyed hash would let a DB reader confirm a
    // guessed prompt, defeating the point of encrypting the prompt column.
    return cipher ? cipher.digest(payload) : createHash('sha256').update(payload).digest('hex');
}

function estimateTokens(text: string): number {
    // ~4 chars/token is the standard rough heuristic for English text.
    return Math.ceil(text.length / 4);
}

/** Columns needed to score similarity — deliberately excludes `response`, which dominates row size. */
interface EmbeddingRow {
    id: string;
    embedding: Buffer;
}

const ENCRYPTION_META_KEY = 'encryption_verifier';
const EMBEDDING_META_KEY = 'embedding_version';

/** Bumped whenever a change to embed() makes previously stored vectors unreadable. */
const EMBEDDING_VERSION = '2';

/**
 * Floor for `query()`, calibrated against realistic content rather than near-duplicate pairs.
 * On the corpus in src/retrieval.test.ts the worst genuine match scores 0.52, a plausible but
 * wrong entry reaches 0.36, and a query matching nothing scores 0.00.
 */
const DEFAULT_QUERY_FLOOR = 0.3;

export class CacheStore {
    private readonly config: Config;
    private readonly cipher: Cipher | undefined;

    constructor(
        private readonly db: Database.Database,
        config: Partial<Config> = {},
        cipher?: Cipher
    ) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.cipher = cipher;
        this.assertKeyMatchesDatabase();
        this.migrateEmbeddings();
    }

    /**
     * Re-embed every entry when the vector format changes. Runs here rather than in openDb()
     * because reaching the stored text needs the cipher.
     *
     * Existing `similar` edges are dropped rather than recomputed: they were scored by the old
     * metric, so they mean nothing under the new one, and rebuilding the whole graph would make
     * startup O(n²) on a cache that exists to be fast. Later writes relink as they land.
     */
    private migrateEmbeddings(): void {
        if (getMeta(this.db, EMBEDDING_META_KEY) === EMBEDDING_VERSION) return;

        const rows = this.db
            .prepare<[], { id: string; prompt: string; response: string }>(
                'SELECT id, prompt, response FROM nodes'
            )
            .all();

        const migrate = this.db.transaction(() => {
            this.db.exec("DELETE FROM edges WHERE relation = 'similar'");
            this.db.exec('DELETE FROM doc_freq');
            const update = this.db.prepare('UPDATE nodes SET embedding = ? WHERE id = ?');
            for (const row of rows) {
                const embedding = embed(`${this.open(row.prompt)}\n${this.open(row.response)}`);
                update.run(toBuffer(embedding), row.id);
                this.addToDocFreq(embedding);
            }
            setMeta(this.db, EMBEDDING_META_KEY, EMBEDDING_VERSION);
        });
        migrate();

        if (rows.length > 0) {
            console.error(
                `[nowhereman] re-embedded ${rows.length} cache entries for embedding v${EMBEDDING_VERSION}; ` +
                    'similarity links will rebuild as entries are written'
            );
        }
    }

    private addToDocFreq(embedding: Embedding): void {
        const stmt = this.db.prepare(
            `INSERT INTO doc_freq (bucket, count) VALUES (?, 1)
             ON CONFLICT(bucket) DO UPDATE SET count = count + 1`
        );
        for (const bucket of embedding.buckets) stmt.run(bucket);
    }

    private removeFromDocFreq(embedding: Embedding): void {
        // Rows are left at zero rather than deleted; idf() treats absent and zero alike, and
        // rewriting the same buckets is cheaper than churning rows on every eviction.
        const stmt = this.db.prepare('UPDATE doc_freq SET count = MAX(0, count - 1) WHERE bucket = ?');
        for (const bucket of embedding.buckets) stmt.run(bucket);
    }

    private corpusStats(): CorpusStats {
        const docCount = (this.db.prepare('SELECT COUNT(*) AS c FROM nodes').get() as { c: number }).c;
        const docFreq = new Map<number, number>();
        for (const row of this.db
            .prepare<[], { bucket: number; count: number }>('SELECT bucket, count FROM doc_freq WHERE count > 0')
            .all()) {
            docFreq.set(row.bucket, row.count);
        }
        return { docCount, docFreq };
    }

    /**
     * Refuse to run against a database whose encryption state doesn't match the configured key.
     * Silently proceeding would either write plaintext into an encrypted cache or fail later with
     * an opaque decryption error on a random read.
     */
    private assertKeyMatchesDatabase(): void {
        const stored = getMeta(this.db, ENCRYPTION_META_KEY);

        if (this.cipher) {
            if (stored === null) {
                // First time encryption is being adopted on this database. A genuine failure
                // checking for pre-existing cleartext rows must propagate rather than be read as
                // "no rows" — silently proceeding here is exactly the "write plaintext into an
                // encrypted cache" case this function exists to prevent. Deliberately scoped to
                // just this branch: every *other* call to this function (no cipher, or a cipher
                // matched against an already-stored verifier) has no use for this count, and
                // running it unconditionally would mean any transient failure here — on any
                // reconnection, encrypted or not — surfaces during server construction instead of
                // inside a tool call, outside guard()'s protection.
                const hasRows = (this.db.prepare('SELECT COUNT(*) AS c FROM nodes').get() as { c: number }).c > 0;
                if (hasRows) {
                    throw new Error(
                        'This cache database holds unencrypted entries but NOWHEREMAN_ENCRYPTION_KEY is set. ' +
                            'Point NOWHEREMAN_DB_PATH at a new file, or clear the existing one, to start encrypted.'
                    );
                }
                setMeta(this.db, ENCRYPTION_META_KEY, this.cipher.makeVerifier());
                return;
            }
            if (!this.cipher.matchesVerifier(stored)) {
                throw new Error(
                    'NOWHEREMAN_ENCRYPTION_KEY does not match the key this cache database was created with. ' +
                        'Use the original key, or point NOWHEREMAN_DB_PATH at a new file.'
                );
            }
            return;
        }

        if (stored !== null) {
            throw new Error(
                'This cache database is encrypted but NOWHEREMAN_ENCRYPTION_KEY is not set. ' +
                    'Set the original key, or point NOWHEREMAN_DB_PATH at a new file.'
            );
        }
    }

    private seal(text: string): string {
        return this.cipher ? this.cipher.encrypt(text) : text;
    }

    private open(text: string): string {
        return this.cipher ? this.cipher.decrypt(text) : text;
    }

    private toEntry(row: NodeRow, now: number): CacheEntry {
        const age = (now - row.created_at) / 1000;
        const ttl = row.ttl_seconds;
        const swr = row.stale_while_revalidate_s;
        const fresh = ttl == null || age <= ttl;
        const stale = !fresh && (ttl == null || age <= ttl + swr);
        const expired = !fresh && !stale;
        return {
            id: row.id,
            model: row.model,
            prompt: this.open(row.prompt),
            response: this.open(row.response),
            params: JSON.parse(row.params_json),
            tags: JSON.parse(row.tags_json),
            createdAt: row.created_at,
            lastAccessedAt: row.last_accessed_at,
            hitCount: row.hit_count,
            ageSeconds: Math.round(age),
            ttlSeconds: ttl,
            fresh,
            stale,
            expired
        };
    }

    /** Exact-match lookup by (model, prompt, params) — the "web cache" fast path. */
    get(model: string, prompt: string, params: Record<string, unknown> = {}): CacheEntry | null {
        const keyHash = computeKeyHash(model, prompt, params, this.cipher);
        const row = this.db.prepare<[string], NodeRow>('SELECT * FROM nodes WHERE key_hash = ?').get(keyHash);
        const now = Date.now();
        const entry = row ? this.toEntry(row, now) : null;

        if (!entry || entry.expired) {
            bump(this.db, 'misses');
            return null;
        }

        bump(this.db, 'hits');
        // What this hit handed back — not a claim about what it saved. Serving a cached file
        // read costs the caller the same tokens as reading the file, so the two are only the
        // same number when the entry stands in for work that would otherwise be regenerated.
        bump(this.db, 'tokens_served', row!.estimated_tokens);
        this.db
            .prepare('UPDATE nodes SET hit_count = hit_count + 1, last_accessed_at = ? WHERE id = ?')
            .run(now, row!.id);
        return { ...entry, hitCount: entry.hitCount + 1 };
    }

    set(opts: {
        model: string;
        prompt: string;
        response: string;
        params?: Record<string, unknown>;
        ttlSeconds?: number | null;
        staleWhileRevalidateSeconds?: number;
        tags?: string[];
        derivedFrom?: string[];
        similarityThreshold?: number;
    }): { id: string; linkedTo: number; evicted: number } {
        const params = opts.params ?? {};
        const keyHash = computeKeyHash(opts.model, opts.prompt, params, this.cipher);
        const now = Date.now();
        const candidateId = randomUUID();
        const embedding = embed(`${opts.prompt}\n${opts.response}`);
        const estTokens = estimateTokens(opts.response);

        // Retiring the old row's document-frequency contribution has to happen before the write
        // below, but reading it here rather than inside that statement leaves a narrow window: a
        // concurrent writer landing between this SELECT and the write could see its own
        // contribution retired instead of this one's. That residual imprecision is accepted —
        // corpusStats() is already a best-effort snapshot, never a fully serialized count — in
        // exchange for closing the much worse gap below.
        const existingEmbedding = this.db
            .prepare<[string], EmbeddingRow>('SELECT embedding FROM nodes WHERE key_hash = ?')
            .get(keyHash);
        if (existingEmbedding) this.removeFromDocFreq(fromBuffer(existingEmbedding.embedding));

        // A separate SELECT-then-INSERT would leave a real gap for two processes to both see "no
        // existing row" and both try to create one — the cache is shared across every project
        // that registers this server, so that is a real scenario, not a hypothetical. One atomic
        // upsert closes it at the engine level: whichever write loses the race updates the
        // winner's row instead of hitting the key_hash UNIQUE constraint. RETURNING id reveals
        // which happened — it comes back as candidateId only when this write was the one that
        // actually inserted.
        const written = this.db
            .prepare<unknown[], { id: string }>(
                `INSERT INTO nodes (id, key_hash, model, prompt, response, params_json, tags_json, embedding,
                 created_at, last_accessed_at, hit_count, ttl_seconds, stale_while_revalidate_s, estimated_tokens)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
                 ON CONFLICT(key_hash) DO UPDATE SET
                     response = excluded.response, params_json = excluded.params_json,
                     tags_json = excluded.tags_json, embedding = excluded.embedding,
                     created_at = excluded.created_at, last_accessed_at = excluded.last_accessed_at,
                     ttl_seconds = excluded.ttl_seconds,
                     stale_while_revalidate_s = excluded.stale_while_revalidate_s,
                     estimated_tokens = excluded.estimated_tokens
                 RETURNING id`
            )
            .get(
                candidateId,
                keyHash,
                opts.model,
                this.seal(opts.prompt),
                this.seal(opts.response),
                JSON.stringify(params),
                JSON.stringify(opts.tags ?? []),
                toBuffer(embedding),
                now,
                now,
                opts.ttlSeconds === undefined ? this.config.defaultTtlSeconds : opts.ttlSeconds,
                opts.staleWhileRevalidateSeconds ?? 0,
                estTokens
            )!;
        const id = written.id;
        const wasInsert = id === candidateId;
        this.addToDocFreq(embedding);
        bump(this.db, 'sets');

        let linkedTo = 0;
        const insertEdge = this.db.prepare(
            'INSERT OR REPLACE INTO edges (from_id, to_id, relation, weight) VALUES (?, ?, ?, ?)'
        );
        if (wasInsert) {
            const weights = idfWeights(this.corpusStats());
            const threshold = opts.similarityThreshold ?? this.config.similarityThreshold;
            // Comparing against every existing node would make each write O(n) and the whole
            // cache O(n^2) to fill. Capping the candidate pool bounds write cost as the cache
            // grows, at the cost of not linking against nodes older than the cap — acceptable
            // for a local dev cache. Only id+embedding are selected: pulling `response` here
            // would load the whole cache body into memory on every write. Relinking only runs
            // for a genuinely new entry — an overwrite keeps its existing similarity edges.
            const others = this.db
                .prepare<[string, number], EmbeddingRow>(
                    'SELECT id, embedding FROM nodes WHERE id != ? ORDER BY created_at DESC LIMIT ?'
                )
                .all(id, this.config.linkCandidatePool);
            for (const other of others) {
                const sim = documentSimilarity(embedding, fromBuffer(other.embedding), weights);
                if (sim >= threshold) {
                    insertEdge.run(id, other.id, 'similar', sim);
                    insertEdge.run(other.id, id, 'similar', sim);
                    linkedTo++;
                }
            }
        }
        for (const parentId of opts.derivedFrom ?? []) {
            insertEdge.run(id, parentId, 'derived-from', 1.0);
            linkedTo++;
        }

        const evicted = this.enforceLimits();
        return { id, linkedTo, evicted };
    }

    /**
     * Bound the cache: drop TTL-expired entries first (they can never be served), then evict
     * least-recently-used entries until both the entry-count and byte ceilings are satisfied.
     */
    enforceLimits(): number {
        let evicted = 0;

        const expired = this.db
            .prepare<[number], { id: string }>(
                `SELECT id FROM nodes
                 WHERE ttl_seconds IS NOT NULL
                   AND (? - created_at) / 1000.0 > ttl_seconds + stale_while_revalidate_s`
            )
            .all(Date.now());
        for (const row of expired) {
            this.deleteNode(row.id);
            evicted++;
        }

        const overflow = this.db
            .prepare<[number], { id: string }>(
                'SELECT id FROM nodes ORDER BY last_accessed_at DESC LIMIT -1 OFFSET ?'
            )
            .all(this.config.maxEntries);
        for (const row of overflow) {
            this.deleteNode(row.id);
            evicted++;
        }

        // Byte ceiling: walk least-recently-used first until the retained total fits.
        let totalBytes = (
            this.db.prepare('SELECT COALESCE(SUM(LENGTH(response)), 0) AS b FROM nodes').get() as { b: number }
        ).b;
        if (totalBytes > this.config.maxBytes) {
            const candidates = this.db
                .prepare<[], { id: string; bytes: number }>(
                    'SELECT id, LENGTH(response) AS bytes FROM nodes ORDER BY last_accessed_at ASC'
                )
                .all();
            for (const row of candidates) {
                if (totalBytes <= this.config.maxBytes) break;
                this.deleteNode(row.id);
                totalBytes -= row.bytes;
                evicted++;
            }
        }

        if (evicted > 0) bump(this.db, 'evictions', evicted);
        return evicted;
    }

    private deleteNode(id: string): boolean {
        // Read the vector before the row goes, so its document-frequency contribution can be
        // retired — otherwise eviction quietly inflates DF and deflates every later IDF weight.
        const row = this.db
            .prepare<[string], { embedding: Buffer }>('SELECT embedding FROM nodes WHERE id = ?')
            .get(id);
        // No explicit edge cleanup here: db.ts turns foreign_keys on and edges declares
        // ON DELETE CASCADE on both ends, so this DELETE already removes every edge touching
        // the node — pinned by store.test.ts's "deleting an entry also removes its edges".
        const info = this.db.prepare('DELETE FROM nodes WHERE id = ?').run(id);
        if (info.changes === 0) return false;
        if (row) this.removeFromDocFreq(fromBuffer(row.embedding));
        return true;
    }

    /** Semantic search across all nodes, independent of exact-match key. */
    query(text: string, opts: { topK?: number; minSimilarity?: number } = {}): QueryMatch[] {
        const topK = opts.topK ?? 5;
        const minSimilarity = opts.minSimilarity ?? DEFAULT_QUERY_FLOOR;
        const now = Date.now();
        const weights = idfWeights(this.corpusStats());
        const query = prepareQuery(embed(text), weights);

        // Score against embeddings alone, then fetch full rows only for the winners — otherwise
        // every query would pull the entire cache's response bodies into memory.
        const scored = this.db
            .prepare<[], EmbeddingRow>('SELECT id, embedding FROM nodes')
            .all()
            .map(row => ({ id: row.id, sim: queryScore(query, fromBuffer(row.embedding), weights) }))
            .filter(s => s.sim >= minSimilarity)
            .sort((a, b) => b.sim - a.sim)
            .slice(0, topK);

        const nodeQuery = this.db.prepare<[string], NodeRow>('SELECT * FROM nodes WHERE id = ?');
        const touch = this.db.prepare(
            'UPDATE nodes SET hit_count = hit_count + 1, last_accessed_at = ? WHERE id = ?'
        );
        const matches: QueryMatch[] = [];
        let served = 0;
        for (const { id, sim } of scored) {
            const row = nodeQuery.get(id);
            if (!row) continue;
            const entry = this.toEntry(row, now);
            // get() refuses an expired entry outright; query() must hold to the same freshness
            // contract rather than let semantic recall be a back door around it.
            if (entry.expired) continue;
            matches.push({ ...entry, similarity: sim });
            // A recall is a use. Without recording it, an entry reachable only by meaning looks
            // untouched to enforceLimits() and is evicted first — precisely the entries this
            // cache exists to keep.
            touch.run(now, id);
            served += row.estimated_tokens;
        }

        bump(this.db, matches.length > 0 ? 'query_hits' : 'query_misses');
        if (served > 0) bump(this.db, 'tokens_served', served);
        return matches;
    }

    /** Graph traversal (BFS) from a node, following edges up to `depth` hops. */
    related(id: string, opts: { relation?: string; depth?: number; limit?: number } = {}): RelatedEntry[] {
        const depth = opts.depth ?? 1;
        const limit = opts.limit ?? 20;
        const now = Date.now();
        const visited = new Set<string>([id]);
        const results: RelatedEntry[] = [];
        let frontier = [id];

        const filteredEdgeQuery = this.db.prepare<[string, string], { to_id: string; relation: string; weight: number }>(
            'SELECT to_id, relation, weight FROM edges WHERE from_id = ? AND relation = ?'
        );
        const allEdgeQuery = this.db.prepare<[string], { to_id: string; relation: string; weight: number }>(
            'SELECT to_id, relation, weight FROM edges WHERE from_id = ?'
        );
        const nodeQuery = this.db.prepare<[string], NodeRow>('SELECT * FROM nodes WHERE id = ?');
        const relationFilter = opts.relation;

        for (let d = 1; d <= depth && results.length < limit; d++) {
            const next: string[] = [];
            for (const nodeId of frontier) {
                const edges = relationFilter ? filteredEdgeQuery.all(nodeId, relationFilter) : allEdgeQuery.all(nodeId);
                for (const edge of edges) {
                    if (visited.has(edge.to_id)) continue;
                    visited.add(edge.to_id);
                    const row = nodeQuery.get(edge.to_id);
                    if (!row) continue;
                    const entry = this.toEntry(row, now);
                    // Same freshness contract as get(): an expired node is refused, not
                    // surfaced. It is still marked visited so traversal doesn't loop back to it.
                    if (entry.expired) continue;
                    results.push({ ...entry, relation: edge.relation, weight: edge.weight, depth: d });
                    next.push(edge.to_id);
                    if (results.length >= limit) break;
                }
                if (results.length >= limit) break;
            }
            frontier = next;
        }
        return results;
    }

    /** Delete a node. With cascade, also deletes nodes that declared themselves derived-from it. */
    invalidate(id: string, opts: { cascade?: boolean } = {}): { deleted: string[] } {
        const deleted: string[] = [];
        const seen = new Set<string>();
        const toDelete = [id];
        while (toDelete.length > 0) {
            const current = toDelete.pop()!;
            if (seen.has(current)) continue;
            seen.add(current);
            if (opts.cascade) {
                const dependents = this.db
                    .prepare<[string], { from_id: string }>(
                        "SELECT from_id FROM edges WHERE to_id = ? AND relation = 'derived-from'"
                    )
                    .all(current);
                for (const dep of dependents) toDelete.push(dep.from_id);
            }
            if (this.deleteNode(current)) deleted.push(current);
        }
        return { deleted };
    }

    stats(): {
        entries: number;
        edges: number;
        hits: number;
        misses: number;
        sets: number;
        hitRate: number;
        queryHits: number;
        queryMisses: number;
        tokensServed: number;
        evictions: number;
        bytesStored: number;
        topEntries: { id: string; model: string; prompt: string; hitCount: number }[];
    } {
        const entries = (this.db.prepare('SELECT COUNT(*) AS c FROM nodes').get() as { c: number }).c;
        const edges = (this.db.prepare('SELECT COUNT(*) AS c FROM edges').get() as { c: number }).c;
        const bytesStored = (
            this.db.prepare('SELECT COALESCE(SUM(LENGTH(response)), 0) AS b FROM nodes').get() as { b: number }
        ).b;
        const hits = getStat(this.db, 'hits');
        const misses = getStat(this.db, 'misses');
        const sets = getStat(this.db, 'sets');
        const evictions = getStat(this.db, 'evictions');
        const queryHits = getStat(this.db, 'query_hits');
        const queryMisses = getStat(this.db, 'query_misses');
        const tokensServed = getStat(this.db, 'tokens_served');
        const topEntries = this.db
            .prepare<[], { id: string; model: string; prompt: string; hit_count: number }>(
                'SELECT id, model, prompt, hit_count FROM nodes ORDER BY hit_count DESC LIMIT 5'
            )
            .all()
            .map(r => ({ id: r.id, model: r.model, prompt: this.open(r.prompt).slice(0, 120), hitCount: r.hit_count }));
        return {
            entries,
            edges,
            hits,
            misses,
            sets,
            hitRate: hits + misses === 0 ? 0 : hits / (hits + misses),
            queryHits,
            queryMisses,
            tokensServed,
            evictions,
            bytesStored,
            topEntries
        };
    }
}

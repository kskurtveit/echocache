import { randomUUID, createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { bump, getStat } from './db.js';
import { embed, cosineSimilarity, toBuffer, fromBuffer } from './embed.js';

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

export function computeKeyHash(model: string, prompt: string, params: Record<string, unknown>): string {
    const payload = stableStringify({ model, prompt: normalizePrompt(prompt), params });
    return createHash('sha256').update(payload).digest('hex');
}

function estimateTokens(text: string): number {
    // ~4 chars/token is the standard rough heuristic for English text.
    return Math.ceil(text.length / 4);
}

const DEFAULT_SIMILARITY_THRESHOLD = 0.85;
const DEFAULT_TTL_SECONDS = 60 * 60 * 24; // 1 day
const LINK_CANDIDATE_POOL = 500;

export class CacheStore {
    constructor(private readonly db: Database.Database) {}

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
            prompt: row.prompt,
            response: row.response,
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
        const keyHash = computeKeyHash(model, prompt, params);
        const row = this.db.prepare<[string], NodeRow>('SELECT * FROM nodes WHERE key_hash = ?').get(keyHash);
        const now = Date.now();
        const entry = row ? this.toEntry(row, now) : null;

        if (!entry || entry.expired) {
            bump(this.db, 'misses');
            return null;
        }

        bump(this.db, 'hits');
        bump(this.db, 'tokens_saved', row!.estimated_tokens);
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
    }): { id: string; linkedTo: number } {
        const params = opts.params ?? {};
        const keyHash = computeKeyHash(opts.model, opts.prompt, params);
        const now = Date.now();
        const id = randomUUID();
        const vec = embed(`${opts.prompt}\n${opts.response}`);
        const estTokens = estimateTokens(opts.response);

        const existing = this.db
            .prepare<[string], { id: string }>('SELECT id FROM nodes WHERE key_hash = ?')
            .get(keyHash);
        if (existing) {
            this.db
                .prepare(
                    `UPDATE nodes SET response = ?, params_json = ?, tags_json = ?, embedding = ?,
                     created_at = ?, last_accessed_at = ?, ttl_seconds = ?, stale_while_revalidate_s = ?,
                     estimated_tokens = ? WHERE id = ?`
                )
                .run(
                    opts.response,
                    JSON.stringify(params),
                    JSON.stringify(opts.tags ?? []),
                    toBuffer(vec),
                    now,
                    now,
                    opts.ttlSeconds === undefined ? DEFAULT_TTL_SECONDS : opts.ttlSeconds,
                    opts.staleWhileRevalidateSeconds ?? 0,
                    estTokens,
                    existing.id
                );
            bump(this.db, 'sets');
            return { id: existing.id, linkedTo: 0 };
        }

        this.db
            .prepare(
                `INSERT INTO nodes (id, key_hash, model, prompt, response, params_json, tags_json, embedding,
                 created_at, last_accessed_at, hit_count, ttl_seconds, stale_while_revalidate_s, estimated_tokens)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
            )
            .run(
                id,
                keyHash,
                opts.model,
                opts.prompt,
                opts.response,
                JSON.stringify(params),
                JSON.stringify(opts.tags ?? []),
                toBuffer(vec),
                now,
                now,
                opts.ttlSeconds === undefined ? DEFAULT_TTL_SECONDS : opts.ttlSeconds,
                opts.staleWhileRevalidateSeconds ?? 0,
                estTokens
            );
        bump(this.db, 'sets');

        let linkedTo = 0;
        const threshold = opts.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
        // Comparing against every existing node would make each write O(n) and the whole cache
        // O(n^2) to fill. Capping the candidate pool bounds write cost as the cache grows, at the
        // cost of not linking against nodes older than the cap — acceptable for a local dev cache.
        const others = this.db
            .prepare<[string, number], NodeRow>('SELECT * FROM nodes WHERE id != ? ORDER BY created_at DESC LIMIT ?')
            .all(id, LINK_CANDIDATE_POOL);
        const insertEdge = this.db.prepare(
            'INSERT OR REPLACE INTO edges (from_id, to_id, relation, weight) VALUES (?, ?, ?, ?)'
        );
        for (const other of others) {
            const sim = cosineSimilarity(vec, fromBuffer(other.embedding));
            if (sim >= threshold) {
                insertEdge.run(id, other.id, 'similar', sim);
                insertEdge.run(other.id, id, 'similar', sim);
                linkedTo++;
            }
        }
        for (const parentId of opts.derivedFrom ?? []) {
            insertEdge.run(id, parentId, 'derived-from', 1.0);
            linkedTo++;
        }

        return { id, linkedTo };
    }

    /** Semantic search across all nodes, independent of exact-match key. */
    query(text: string, opts: { topK?: number; minSimilarity?: number } = {}): QueryMatch[] {
        const topK = opts.topK ?? 5;
        const minSimilarity = opts.minSimilarity ?? 0.5;
        const vec = embed(text);
        const now = Date.now();
        const rows = this.db.prepare<[], NodeRow>('SELECT * FROM nodes').all();
        const scored = rows
            .map(row => ({ row, sim: cosineSimilarity(vec, fromBuffer(row.embedding)) }))
            .filter(s => s.sim >= minSimilarity)
            .sort((a, b) => b.sim - a.sim)
            .slice(0, topK);
        return scored.map(({ row, sim }) => ({ ...this.toEntry(row, now), similarity: sim }));
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
                    results.push({ ...this.toEntry(row, now), relation: edge.relation, weight: edge.weight, depth: d });
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
        const toDelete = [id];
        while (toDelete.length > 0) {
            const current = toDelete.pop()!;
            if (deleted.includes(current)) continue;
            if (opts.cascade) {
                const dependents = this.db
                    .prepare<[string], { from_id: string }>(
                        "SELECT from_id FROM edges WHERE to_id = ? AND relation = 'derived-from'"
                    )
                    .all(current);
                for (const dep of dependents) toDelete.push(dep.from_id);
            }
            const info = this.db.prepare('DELETE FROM nodes WHERE id = ?').run(current);
            if (info.changes > 0) {
                deleted.push(current);
                this.db.prepare('DELETE FROM edges WHERE from_id = ? OR to_id = ?').run(current, current);
            }
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
        estimatedTokensSaved: number;
        topEntries: { id: string; model: string; prompt: string; hitCount: number }[];
    } {
        const entries = (this.db.prepare('SELECT COUNT(*) AS c FROM nodes').get() as { c: number }).c;
        const edges = (this.db.prepare('SELECT COUNT(*) AS c FROM edges').get() as { c: number }).c;
        const hits = getStat(this.db, 'hits');
        const misses = getStat(this.db, 'misses');
        const sets = getStat(this.db, 'sets');
        const estimatedTokensSaved = getStat(this.db, 'tokens_saved');
        const topEntries = this.db
            .prepare<[], { id: string; model: string; prompt: string; hit_count: number }>(
                'SELECT id, model, prompt, hit_count FROM nodes ORDER BY hit_count DESC LIMIT 5'
            )
            .all()
            .map(r => ({ id: r.id, model: r.model, prompt: r.prompt.slice(0, 120), hitCount: r.hit_count }));
        return {
            entries,
            edges,
            hits,
            misses,
            sets,
            hitRate: hits + misses === 0 ? 0 : hits / (hits + misses),
            estimatedTokensSaved,
            topEntries
        };
    }
}

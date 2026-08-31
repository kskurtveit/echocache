import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openDb } from './db.js';
import { CacheStore, computeKeyHash } from './store.js';
import { embed } from './embed.js';


let dir: string;
let db: Database.Database;

function newStore() {
    return new CacheStore(db);
}

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nowhereman-test-'));
    db = openDb(join(dir, 'cache.db'));
});

afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
});

describe('key hashing', () => {
    test('is stable across object key order in params', () => {
        const a = computeKeyHash('m', 'p', { b: 2, a: 1 });
        const b = computeKeyHash('m', 'p', { a: 1, b: 2 });
        assert.equal(a, b);
    });

    test('normalizes surrounding and repeated whitespace in the prompt', () => {
        assert.equal(computeKeyHash('m', '  hello   world ', {}), computeKeyHash('m', 'hello world', {}));
    });

    test('distinguishes model, prompt, and params', () => {
        const base = computeKeyHash('m', 'p', {});
        assert.notEqual(base, computeKeyHash('m2', 'p', {}));
        assert.notEqual(base, computeKeyHash('m', 'p2', {}));
        assert.notEqual(base, computeKeyHash('m', 'p', { x: 1 }));
    });

    test('does not collide when params differ only by nesting', () => {
        assert.notEqual(computeKeyHash('m', 'p', { a: { b: 1 } }), computeKeyHash('m', 'p', { 'a.b': 1 }));
    });
});

describe('get/set round trip', () => {
    test('returns null on a miss and counts it', () => {
        const store = newStore();
        assert.equal(store.get('m', 'nothing here'), null);
        assert.equal(store.stats().misses, 1);
        assert.equal(store.stats().hits, 0);
    });

    test('returns a stored entry and counts the hit', () => {
        const store = newStore();
        store.set({ model: 'm', prompt: 'p', response: 'the answer' });
        const hit = store.get('m', 'p');
        assert.ok(hit);
        assert.equal(hit.response, 'the answer');
        assert.equal(hit.fresh, true);
        assert.equal(hit.expired, false);
        assert.equal(store.stats().hits, 1);
    });

    test('params participate in the cache key', () => {
        const store = newStore();
        store.set({ model: 'm', prompt: 'p', response: 'hot', params: { temp: 1 } });
        assert.equal(store.get('m', 'p', { temp: 2 }), null);
        assert.ok(store.get('m', 'p', { temp: 1 }));
    });

    test('re-setting the same key overwrites in place rather than duplicating', () => {
        const store = newStore();
        const first = store.set({ model: 'm', prompt: 'p', response: 'v1' });
        const second = store.set({ model: 'm', prompt: 'p', response: 'v2' });
        assert.equal(first.id, second.id);
        assert.equal(store.stats().entries, 1);
        assert.equal(store.get('m', 'p')?.response, 'v2');
    });

    test('re-setting an existing key still records newly declared derived_from parents', () => {
        const store = newStore();
        const parent = store.set({ model: 'm', prompt: 'source', response: 'x' });
        store.set({ model: 'm', prompt: 'p', response: 'v1' });

        const refreshed = store.set({ model: 'm', prompt: 'p', response: 'v2', derivedFrom: [parent.id] });

        assert.ok(refreshed.linkedTo > 0, 'derived_from parent was not linked on refresh');
        const related = store.related(refreshed.id, { relation: 'derived-from' });
        assert.ok(
            related.some(r => r.id === parent.id),
            'expected the refreshed entry to declare a derived-from edge to its parent'
        );
    });

    test('a new key that collides with a row created moments earlier updates it rather than erroring', () => {
        // The realistic case this pins: process A's existence check finds nothing, then process
        // B creates the row, then A's write lands — a genuine possibility once the cache is
        // shared across processes (CLAUDE.md). Two sequential set() calls with an identical new
        // key exercise the exact SQL path that write collision takes (an atomic upsert, not a
        // separate check-then-insert with a gap in between) without needing real OS concurrency.
        const store = newStore();
        const first = store.set({ model: 'm', prompt: 'brand new key', response: 'from A' });
        const second = store.set({ model: 'm', prompt: 'brand new key', response: 'from B' });

        assert.equal(second.id, first.id, 'the second write should land on the same row, not error or duplicate');
        assert.equal(store.stats().entries, 1);
        assert.equal(store.get('m', 'brand new key')?.response, 'from B');
    });

    test('hit count increments across repeated reads', () => {
        const store = newStore();
        store.set({ model: 'm', prompt: 'p', response: 'x' });
        assert.equal(store.get('m', 'p')?.hitCount, 1);
        assert.equal(store.get('m', 'p')?.hitCount, 2);
    });

    test('a semantic recall reports hitCount the same way get() does — including this hit', () => {
        const store = newStore();
        store.set({ model: 'm', prompt: 'quarterly earnings summary', response: 'Revenue grew 12%.' });
        const [match] = store.query('quarterly earnings summary', { minSimilarity: 0 });
        assert.equal(match?.hitCount, 1, 'the recall that just happened should already be counted');
    });

    test('round-trips an empty response and unicode without corruption', () => {
        const store = newStore();
        store.set({ model: 'm', prompt: 'empty', response: '' });
        assert.equal(store.get('m', 'empty')?.response, '');
        store.set({ model: 'm', prompt: 'u', response: 'héllo → 世界 🎸' });
        assert.equal(store.get('m', 'u')?.response, 'héllo → 世界 🎸');
    });
});

describe('freshness (TTL / stale-while-revalidate)', () => {
    test('ttl_seconds null means never expires', () => {
        const store = newStore();
        const { id } = store.set({ model: 'm', prompt: 'p', response: 'x', ttlSeconds: null });
        db.prepare('UPDATE nodes SET created_at = ? WHERE id = ?').run(Date.now() - 10_000_000, id);
        const hit = store.get('m', 'p');
        assert.ok(hit);
        assert.equal(hit.fresh, true);
    });

    test('past TTL but inside the SWR window is a stale hit, not a miss', () => {
        const store = newStore();
        const { id } = store.set({
            model: 'm',
            prompt: 'p',
            response: 'x',
            ttlSeconds: 10,
            staleWhileRevalidateSeconds: 600
        });
        db.prepare('UPDATE nodes SET created_at = ? WHERE id = ?').run(Date.now() - 60_000, id);
        const hit = store.get('m', 'p');
        assert.ok(hit, 'expected a stale hit, got a miss');
        assert.equal(hit.fresh, false);
        assert.equal(hit.stale, true);
        assert.equal(hit.expired, false);
    });

    test('past TTL and past the SWR window is a miss', () => {
        const store = newStore();
        const { id } = store.set({
            model: 'm',
            prompt: 'p',
            response: 'x',
            ttlSeconds: 10,
            staleWhileRevalidateSeconds: 5
        });
        db.prepare('UPDATE nodes SET created_at = ? WHERE id = ?').run(Date.now() - 60_000, id);
        assert.equal(store.get('m', 'p'), null);
        assert.equal(store.stats().misses, 1);
    });

    test('an expired entry does not count as a hit', () => {
        const store = newStore();
        const { id } = store.set({ model: 'm', prompt: 'p', response: 'x', ttlSeconds: 1 });
        db.prepare('UPDATE nodes SET created_at = ? WHERE id = ?').run(Date.now() - 60_000, id);
        store.get('m', 'p');
        assert.equal(store.stats().hits, 0);
        assert.equal(store.stats().misses, 1);
    });

    test('cache_query does not surface an expired entry', () => {
        const store = newStore();
        const { id } = store.set({
            model: 'm',
            prompt: 'quarterly earnings summary',
            response: 'Revenue grew 12%.',
            ttlSeconds: 1
        });
        db.prepare('UPDATE nodes SET created_at = ? WHERE id = ?').run(Date.now() - 60_000, id);

        const matches = store.query('quarterly earnings summary', { minSimilarity: 0 });

        assert.equal(matches.length, 0, 'get() would refuse this entry as expired; query() must too');
    });

    test('expired entries do not consume topK slots and hide a fresh match', () => {
        const store = newStore();
        const q = 'quarterly earnings summary';
        // Everything is written first, so enforceLimits() can't sweep anything — nothing has
        // expired yet at write time. This is the read-mostly cache where expired entries linger.
        const stale = Array.from({ length: 5 }, (_, n) =>
            store.set({ model: 'm', prompt: q, response: q, ttlSeconds: 10, params: { n } }).id
        );
        store.set({ model: 'm', prompt: 'quarterly earnings', response: 'Revenue grew.', ttlSeconds: null });
        for (const id of stale) {
            db.prepare('UPDATE nodes SET created_at = ? WHERE id = ?').run(Date.now() - 60_000, id);
        }

        // The five expired entries outrank the fresh one, filling every slot of the default
        // topK before the freshness filter ever runs.
        const matches = store.query(q, { minSimilarity: 0 });

        assert.equal(matches.length, 1, 'a fresh match was hidden behind expired entries');
        assert.equal(matches[0]!.prompt, 'quarterly earnings');
        assert.equal(store.stats().queryMisses, 0, 'a findable fresh entry must not record a miss');
    });

    test('cache_related does not surface an expired entry', () => {
        const store = newStore();
        // derived-from edges point child -> parent, so traversal has to start at the child to
        // reach the (here, expired) parent.
        const parent = store.set({ model: 'm', prompt: 'source', response: 'x', ttlSeconds: 1 });
        const child = store.set({
            model: 'm',
            prompt: 'derived',
            response: 'y',
            ttlSeconds: null,
            derivedFrom: [parent.id]
        });
        db.prepare('UPDATE nodes SET created_at = ? WHERE id = ?').run(Date.now() - 60_000, parent.id);

        const related = store.related(child.id, { relation: 'derived-from' });

        assert.equal(related.length, 0, 'get() would refuse the expired parent; related() must too');
    });

    test('traversal continues through an expired node to reach fresh ones behind it', () => {
        const store = newStore();
        // The chain AGENTS.md describes: a never-expiring source fingerprint, a derivation on
        // it, and a further derivation on that. Refusing to *surface* the expired middle link is
        // correct; refusing to traverse past it strands the fingerprint the cascade depends on.
        const grandparent = store.set({
            model: 'source-fingerprint',
            prompt: 'src/a.ts',
            response: 'sha',
            ttlSeconds: null
        });
        const mid = store.set({
            model: 'orient',
            prompt: 'mid derivation',
            response: 'y',
            ttlSeconds: 10,
            derivedFrom: [grandparent.id]
        });
        const leaf = store.set({
            model: 'orient',
            prompt: 'leaf derivation',
            response: 'z',
            ttlSeconds: null,
            derivedFrom: [mid.id]
        });
        db.prepare('UPDATE nodes SET created_at = ? WHERE id = ?').run(Date.now() - 60_000, mid.id);

        const chain = store.related(leaf.id, { relation: 'derived-from', depth: 3 });

        assert.ok(
            chain.some(r => r.id === grandparent.id),
            'a never-expiring fingerprint became unreachable behind an expired derivation'
        );
        assert.ok(!chain.some(r => r.id === mid.id), 'the expired middle link must not be surfaced');
    });
});

describe('similarity graph', () => {
    test('links near-duplicate entries automatically', () => {
        const store = newStore();
        store.set({ model: 'm', prompt: 'summarize the quarterly earnings report', response: 'Revenue grew 12%.' });
        const second = store.set({
            model: 'm',
            prompt: 'summarize the quarterly earnings reports',
            response: 'Revenue grew 12%.'
        });
        assert.ok(second.linkedTo > 0, 'expected the near-duplicate to be auto-linked');
    });

    test('does not link unrelated entries', () => {
        const store = newStore();
        store.set({ model: 'm', prompt: 'how do I bake sourdough bread', response: 'Feed the starter.' });
        const second = store.set({ model: 'm', prompt: 'kubernetes ingress TLS config', response: 'Use cert-manager.' });
        assert.equal(second.linkedTo, 0);
    });

    test('similar edges are bidirectional, so either end can traverse to the other', () => {
        const store = newStore();
        const a = store.set({ model: 'm', prompt: 'summarize the quarterly earnings report', response: 'Revenue grew.' });
        const b = store.set({
            model: 'm',
            prompt: 'summarize the quarterly earnings reports',
            response: 'Revenue grew.'
        });
        for (const [from, to] of [
            [a.id, b.id],
            [b.id, a.id]
        ]) {
            const related = store.related(from!);
            assert.equal(related.length, 1);
            assert.equal(related[0]!.id, to);
            assert.equal(related[0]!.relation, 'similar');
            assert.equal(related[0]!.depth, 1);
        }
    });

    test('derived-from edges point from the child to its parent', () => {
        const store = newStore();
        const parent = store.set({ model: 'm', prompt: 'base analysis of the logs', response: 'ok' });
        const child = store.set({ model: 'm', prompt: 'derived work', response: 'ok2', derivedFrom: [parent.id] });

        const fromChild = store.related(child.id, { relation: 'derived-from' });
        assert.equal(fromChild.length, 1);
        assert.equal(fromChild[0]!.id, parent.id);

        assert.equal(store.related(parent.id, { relation: 'derived-from' }).length, 0);
    });

    test('the relation filter excludes other edge types', () => {
        const store = newStore();
        const a = store.set({ model: 'm', prompt: 'summarize the quarterly earnings report', response: 'Revenue grew.' });
        store.set({ model: 'm', prompt: 'summarize the quarterly earnings reports', response: 'Revenue grew.' });
        assert.equal(store.related(a.id, { relation: 'similar' }).length, 1);
        assert.equal(store.related(a.id, { relation: 'derived-from' }).length, 0);
    });

    test('limit caps the number of traversed results', () => {
        const store = newStore();
        const ids: string[] = [];
        for (let i = 0; i < 5; i++) {
            ids.push(store.set({ model: 'm', prompt: `shared prefix token bundle ${i}`, response: 'r' }).id);
        }
        const related = store.related(ids[0]!, { limit: 2 });
        assert.ok(related.length <= 2);
    });

    test('semantic query finds a related entry without an exact key match', () => {
        const store = newStore();
        store.set({ model: 'm', prompt: 'what is the capital of France', response: 'Paris.' });
        const matches = store.query('France capital city', { topK: 3, minSimilarity: 0.3 });
        assert.ok(matches.length > 0);
        assert.ok(matches[0]!.similarity > 0.3);
    });

    test('query respects topK and the similarity floor', () => {
        const store = newStore();
        for (let i = 0; i < 10; i++) {
            store.set({ model: 'm', prompt: `alpha beta gamma item ${i}`, response: `r${i}` });
        }
        assert.equal(store.query('alpha beta gamma', { topK: 3, minSimilarity: 0 }).length, 3);
        assert.equal(store.query('completely unrelated xyzzy', { minSimilarity: 0.99 }).length, 0);
    });
});

describe('invalidation', () => {
    test('deletes a single entry without cascade', () => {
        const store = newStore();
        const parent = store.set({ model: 'm', prompt: 'parent thing', response: 'p' });
        const child = store.set({ model: 'm', prompt: 'child thing', response: 'c', derivedFrom: [parent.id] });
        const result = store.invalidate(parent.id);
        assert.deepEqual(result.deleted, [parent.id]);
        assert.ok(store.get('m', 'child thing'), 'child should survive a non-cascading invalidate');
        assert.ok(child.id);
    });

    test('cascade removes entries derived from the invalidated one', () => {
        const store = newStore();
        const parent = store.set({ model: 'm', prompt: 'parent thing', response: 'p' });
        const child = store.set({ model: 'm', prompt: 'child thing', response: 'c', derivedFrom: [parent.id] });
        const result = store.invalidate(parent.id, { cascade: true });
        assert.equal(result.deleted.length, 2);
        assert.ok(result.deleted.includes(parent.id));
        assert.ok(result.deleted.includes(child.id));
        assert.equal(store.stats().entries, 0);
    });

    test('cascade terminates on a dependency cycle', () => {
        const store = newStore();
        const a = store.set({ model: 'm', prompt: 'node a', response: 'a' });
        const b = store.set({ model: 'm', prompt: 'node b', response: 'b', derivedFrom: [a.id] });
        // Close the loop: a derived-from b, so a<->b are mutually dependent.
        db.prepare('INSERT OR REPLACE INTO edges (from_id, to_id, relation, weight) VALUES (?, ?, ?, ?)').run(
            a.id,
            b.id,
            'derived-from',
            1.0
        );
        const result = store.invalidate(a.id, { cascade: true });
        assert.equal(result.deleted.length, 2);
    });

    test('invalidating a nonexistent id is a no-op, not an error', () => {
        const store = newStore();
        assert.deepEqual(store.invalidate('does-not-exist').deleted, []);
    });

    test('deleting an entry also removes its edges', () => {
        const store = newStore();
        const a = store.set({ model: 'm', prompt: 'summarize the quarterly earnings report', response: 'Revenue grew.' });
        store.set({ model: 'm', prompt: 'summarize the quarterly earnings reports', response: 'Revenue grew.' });
        assert.ok(store.stats().edges > 0, 'expected the pair to be auto-linked');

        store.invalidate(a.id);

        const dangling = db
            .prepare<[string, string], { c: number }>('SELECT COUNT(*) AS c FROM edges WHERE from_id = ? OR to_id = ?')
            .get(a.id, a.id);
        assert.equal(dangling?.c, 0);
    });
});

describe('eviction', () => {
    test('enforces the entry ceiling, dropping least-recently-used first', () => {
        const store = new CacheStore(db, { maxEntries: 5 });
        for (let i = 0; i < 12; i++) {
            store.set({ model: 'm', prompt: `entry number ${i}`, response: `r${i}`, ttlSeconds: null });
        }
        assert.equal(store.stats().entries, 5);
        // The most recent writes are the ones that should have survived.
        assert.ok(store.get('m', 'entry number 11'), 'newest entry should survive eviction');
        assert.equal(store.get('m', 'entry number 0'), null, 'oldest entry should have been evicted');
    });

    test('enforces the byte ceiling', () => {
        const store = new CacheStore(db, { maxEntries: 1000, maxBytes: 5000 });
        for (let i = 0; i < 20; i++) {
            store.set({ model: 'm', prompt: `big entry ${i}`, response: 'x'.repeat(1000), ttlSeconds: null });
        }
        assert.ok(store.stats().bytesStored <= 5000, `bytesStored=${store.stats().bytesStored} exceeds cap`);
        assert.ok(store.stats().entries > 0, 'should not have evicted everything');
    });

    test('sweeps fully-expired entries regardless of the ceilings', () => {
        const store = new CacheStore(db, { maxEntries: 1000 });
        const { id } = store.set({ model: 'm', prompt: 'perishable', response: 'x', ttlSeconds: 1 });
        db.prepare('UPDATE nodes SET created_at = ? WHERE id = ?').run(Date.now() - 60_000, id);
        const evicted = store.enforceLimits();
        assert.equal(evicted, 1);
        assert.equal(store.stats().entries, 0);
    });

    test('never evicts entries that are still fresh when under the ceilings', () => {
        const store = new CacheStore(db, { maxEntries: 100 });
        store.set({ model: 'm', prompt: 'keep me', response: 'x', ttlSeconds: 3600 });
        assert.equal(store.enforceLimits(), 0);
        assert.ok(store.get('m', 'keep me'));
    });

    test('counts evictions in stats', () => {
        const store = new CacheStore(db, { maxEntries: 2 });
        for (let i = 0; i < 6; i++) {
            store.set({ model: 'm', prompt: `x ${i}`, response: 'r', ttlSeconds: null });
        }
        assert.ok(store.stats().evictions > 0);
    });
});

describe('stats', () => {
    test('reports a zeroed hit rate on an empty cache rather than NaN', () => {
        const stats = newStore().stats();
        assert.equal(stats.hitRate, 0);
        assert.equal(stats.entries, 0);
        assert.equal(Number.isNaN(stats.hitRate), false);
    });

    test('computes hit rate over hits and misses', () => {
        const store = newStore();
        store.set({ model: 'm', prompt: 'p', response: 'x' });
        store.get('m', 'p');
        store.get('m', 'absent');
        assert.equal(store.stats().hitRate, 0.5);
    });

    test('accumulates tokens served only on hits', () => {
        const store = newStore();
        store.set({ model: 'm', prompt: 'p', response: 'x'.repeat(400) });
        assert.equal(store.stats().tokensServed, 0, 'a set alone serves nothing');
        store.get('m', 'p');
        assert.equal(store.stats().tokensServed, 100, '400 chars ≈ 100 tokens');
    });

    test('counts semantic recalls, not only exact-key hits', () => {
        const store = newStore();
        store.set({ model: 'm', prompt: 'connection pooling for postgres', response: 'x'.repeat(400) });

        store.query('postgres pooling');
        assert.equal(store.stats().queryHits, 1, 'a recall that returned an entry must be counted');
        assert.equal(store.stats().tokensServed, 100, 'a recall serves tokens like any other hit');

        store.query('entirely unrelated parliamentary procedure');
        assert.equal(store.stats().queryMisses, 1, 'a recall that found nothing must be counted');
    });

    test('a semantic recall marks the entry as used, so LRU stops treating it as untouched', () => {
        const store = newStore();
        const entry = store.set({ model: 'm', prompt: 'connection pooling for postgres', response: 'pool notes' });
        const before = db
            .prepare<[string], { t: number }>('SELECT last_accessed_at AS t FROM nodes WHERE id = ?')
            .get(entry.id)!.t;

        // Date.now() has millisecond resolution, so force a distinct tick rather than let the
        // assertion depend on how fast the machine is.
        const until = Date.now() + 2;
        while (Date.now() < until) { /* spin */ }

        assert.equal(store.query('postgres pooling').length, 1);

        const after = db
            .prepare<[string], { t: number }>('SELECT last_accessed_at AS t FROM nodes WHERE id = ?')
            .get(entry.id)!.t;
        assert.ok(after > before, `recall did not record access (${before} -> ${after}); LRU will evict it as stale`);
    });

    test('counts what was served, not what an entry might have cost to produce', () => {
        const store = newStore();
        store.set({ model: 'm', prompt: 'p', response: 'x'.repeat(400) });
        store.get('m', 'p');
        store.get('m', 'p');
        // Two hits, each handing back the same 100 tokens. The cache cannot know what
        // producing this entry cost, so it reports only the quantity it can observe.
        assert.equal(store.stats().tokensServed, 200);
        assert.equal('estimatedTokensSaved' in store.stats(), false, 'must not claim savings it cannot know');
    });
});


describe('persistence', () => {
    test('entries survive closing and reopening the database', () => {
        const path = join(dir, 'persist.db');
        const first = openDb(path);
        new CacheStore(first).set({ model: 'm', prompt: 'durable', response: 'still here', ttlSeconds: null });
        first.close();

        const second = openDb(path);
        const hit = new CacheStore(second).get('m', 'durable');
        assert.equal(hit?.response, 'still here');
        second.close();
    });
});

describe('document-frequency bookkeeping', () => {
    /** Recompute doc_freq from scratch, the way corpusStats would if nothing had drifted. */
    function expectedDocFreq(): Map<number, number> {
        const expected = new Map<number, number>();
        for (const row of db
            .prepare<[], { prompt: string; response: string }>('SELECT prompt, response FROM nodes')
            .all()) {
            for (const bucket of embed(`${row.prompt}\n${row.response}`).buckets) {
                expected.set(bucket, (expected.get(bucket) ?? 0) + 1);
            }
        }
        return expected;
    }

    function storedDocFreq(): Map<number, number> {
        const stored = new Map<number, number>();
        for (const row of db
            .prepare<[], { bucket: number; count: number }>('SELECT bucket, count FROM doc_freq WHERE count > 0')
            .all()) {
            stored.set(row.bucket, row.count);
        }
        return stored;
    }

    test('counts match the surviving entries after an invalidate', () => {
        const store = newStore();
        const first = store.set({ model: 'm', prompt: 'alpha beta', response: 'gamma delta' });
        store.set({ model: 'm', prompt: 'beta epsilon', response: 'zeta' });

        store.invalidate(first.id);

        assert.deepEqual(storedDocFreq(), expectedDocFreq());
    });

    test('counts match the surviving entries after LRU eviction', () => {
        const store = new CacheStore(db, { maxEntries: 3 });
        for (let i = 0; i < 8; i++) {
            store.set({ model: 'm', prompt: `entry ${i} subject`, response: `body ${i} content` });
        }

        const remaining = db.prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM nodes').get()!;
        assert.equal(remaining.c, 3);
        assert.deepEqual(storedDocFreq(), expectedDocFreq());
    });

    test('counts match after an entry is overwritten with different content', () => {
        const store = newStore();
        store.set({ model: 'm', prompt: 'stable key', response: 'original wording here' });
        store.set({ model: 'm', prompt: 'stable key', response: 'entirely replaced vocabulary' });

        assert.deepEqual(storedDocFreq(), expectedDocFreq());
    });

    test('deleteNode issues one atomic statement, never a separate read then delete', () => {
        // This is the property that actually closes the race, and the only thing left worth
        // testing at this level: since read-and-delete is one indivisible SQL statement, there is
        // no window between two separate statements for a concurrent connection's write to land
        // in — not something a JS-level test can force anymore, because there's no "during" a
        // single statement to inject into. A prior version of this test tried to inject a
        // concurrent write by intercepting the *old* two-statement SQL text; once the fix landed,
        // that text was never issued again, so the intercept silently stopped firing and the test
        // passed without exercising anything. This version asserts the structural fact that makes
        // the old approach obsolete, and fails loudly if the vulnerable two-statement form ever
        // comes back.
        const store = newStore();
        const target = store.set({ model: 'm', prompt: 'p', response: 'r' });

        const issued: string[] = [];
        const originalPrepare = db.prepare.bind(db);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (db as any).prepare = (sql: string) => {
            if (sql.includes('FROM nodes') && sql.includes('embedding')) issued.push(sql);
            return originalPrepare(sql);
        };

        store.invalidate(target.id);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (db as any).prepare = originalPrepare;

        assert.deepEqual(issued, ['DELETE FROM nodes WHERE id = ? RETURNING embedding']);
    });

    test('deleting a row retires whatever embedding is actually stored, not a stale read', () => {
        // No interception needed: a real second connection overwrites the row before the delete
        // runs at all, then the delete's own atomicity (pinned by the test above) guarantees it
        // sees that same current state — there is nothing else in between for it to race against.
        const path = join(dir, 'race.db');
        const storeA = new CacheStore(openDb(path));
        const target = storeA.set({ model: 'm', prompt: 'stable key', response: 'original wording here' });
        storeA.set({ model: 'm', prompt: 'unrelated', response: 'filler content entirely' });
        const storeB = new CacheStore(openDb(path));
        storeB.set({ model: 'm', prompt: 'stable key', response: 'entirely replaced vocabulary instead' });

        storeA.invalidate(target.id);

        const fresh = openDb(path);
        const remaining = fresh.prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM nodes').get()!;
        assert.equal(remaining.c, 1);
        const expected = new Map<number, number>();
        for (const row of fresh
            .prepare<[], { prompt: string; response: string }>('SELECT prompt, response FROM nodes')
            .all()) {
            for (const bucket of embed(`${row.prompt}\n${row.response}`).buckets) {
                expected.set(bucket, (expected.get(bucket) ?? 0) + 1);
            }
        }
        const actual = new Map<number, number>();
        for (const row of fresh
            .prepare<[], { bucket: number; count: number }>('SELECT bucket, count FROM doc_freq WHERE count > 0')
            .all()) {
            actual.set(row.bucket, row.count);
        }
        assert.deepEqual(actual, expected, 'doc_freq drifted from a stale read racing a concurrent overwrite');
        fresh.close();
    });

    test('set() reads under the write lock, so a concurrent writer cannot interleave and go stale', () => {
        // The same class of race deleteNode() and query() were fixed for above: set() reads a
        // row's embedding to retire its doc_freq contribution before writing the new one. A plain
        // write statement blocks on lock contention regardless of this fix — SQLite serializes any
        // write either way — so that alone doesn't prove anything; what actually matters is
        // whether the *read* happens before or after the lock is acquired. If it happens before
        // (the bug), a second connection can complete an entire set() — read, write, commit — in
        // the gap, and the first connection's write then proceeds on a stale read, permanently
        // losing that second write's doc_freq contribution. .immediate() acquires the lock at
        // BEGIN, before the read runs, so the second connection's set() cannot get in at all —
        // proven here by actually injecting it into that exact gap and confirming it's rejected.
        const path = join(dir, 'race2.db');
        const dbA = openDb(path);
        const storeA = new CacheStore(dbA);
        // Short busy_timeout so this test resolves in milliseconds: storeB's injected call runs
        // synchronously inside storeA's own transaction, so if storeB had to wait out db.ts's
        // real 5-second default, this test would too.
        const dbB = new Database(path);
        dbB.pragma('busy_timeout = 50');
        const storeB = new CacheStore(dbB);

        let injectedThrew: string | null = null;
        const originalPrepare = dbA.prepare.bind(dbA);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (dbA as any).prepare = (sql: string) => {
            const stmt = originalPrepare(sql);
            if (sql === 'SELECT embedding FROM nodes WHERE key_hash = ?') {
                const originalGet = stmt.get.bind(stmt);
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (stmt as any).get = (...args: unknown[]) => {
                    try {
                        storeB.set({ model: 'm', prompt: 'contended', response: 'from B, injected mid-read' });
                    } catch (err) {
                        injectedThrew = (err as Error).message;
                    }
                    return originalGet(...(args as [string]));
                };
            }
            return stmt;
        };

        storeA.set({ model: 'm', prompt: 'contended', response: 'from A' });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (dbA as any).prepare = originalPrepare;

        assert.match(
            injectedThrew ?? '',
            /database is locked/i,
            `expected the concurrent set() to be rejected outright, not silently interleave (got: ${injectedThrew})`
        );

        const fresh = openDb(path);
        const expected = new Map<number, number>();
        for (const row of fresh
            .prepare<[], { prompt: string; response: string }>('SELECT prompt, response FROM nodes')
            .all()) {
            for (const bucket of embed(`${row.prompt}\n${row.response}`).buckets) {
                expected.set(bucket, (expected.get(bucket) ?? 0) + 1);
            }
        }
        const actual = new Map<number, number>();
        for (const row of fresh
            .prepare<[], { bucket: number; count: number }>('SELECT bucket, count FROM doc_freq WHERE count > 0')
            .all()) {
            actual.set(row.bucket, row.count);
        }
        assert.deepEqual(actual, expected);
        fresh.close();
    });
});

describe('embedding migration', () => {
    test('re-embeds entries written under an older vector format', () => {
        const path = join(dir, 'migrate.db');
        const first = openDb(path);
        new CacheStore(first).set({
            model: 'm',
            prompt: 'kubernetes ingress tls certificates',
            response: 'Terminate TLS at the ingress controller and let the issuer renew it.',
            ttlSeconds: null
        });
        // Simulate a database written by an older build: stale version marker, and vectors in a
        // format this build cannot interpret.
        first.prepare("UPDATE meta SET value = '1' WHERE key = 'embedding_version'").run();
        first.prepare('UPDATE nodes SET embedding = ?').run(Buffer.from([1, 2, 3, 4]));
        first.close();

        const second = openDb(path);
        const store = new CacheStore(second);
        const matches = store.query('how do I terminate TLS at the ingress');

        assert.ok(matches.length > 0, 'expected the re-embedded entry to be findable');
        assert.equal(store.get('m', 'kubernetes ingress tls certificates')?.response.startsWith('Terminate'), true);
        second.close();
    });
});

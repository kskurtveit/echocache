import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
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

    test('hit count increments across repeated reads', () => {
        const store = newStore();
        store.set({ model: 'm', prompt: 'p', response: 'x' });
        assert.equal(store.get('m', 'p')?.hitCount, 1);
        assert.equal(store.get('m', 'p')?.hitCount, 2);
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

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { openDb } from './db.js';
import { CacheStore, EMBEDDING_META_KEY, EMBEDDING_VERSION } from './store.js';
import { Cipher } from './crypto.js';

let dir: string;
let db: Database.Database;
const KEY = Cipher.generateKeyHex();
const OTHER_KEY = Cipher.generateKeyHex();

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nowhereman-crypto-'));
    db = openDb(join(dir, 'cache.db'));
});

afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
});

describe('Cipher', () => {
    test('round-trips text', () => {
        const cipher = Cipher.fromHex(KEY);
        assert.equal(cipher.decrypt(cipher.encrypt('hello world')), 'hello world');
    });

    test('round-trips empty text and unicode', () => {
        const cipher = Cipher.fromHex(KEY);
        assert.equal(cipher.decrypt(cipher.encrypt('')), '');
        assert.equal(cipher.decrypt(cipher.encrypt('héllo → 世界 🎸')), 'héllo → 世界 🎸');
    });

    test('produces a different ciphertext each time for the same input', () => {
        const cipher = Cipher.fromHex(KEY);
        assert.notEqual(cipher.encrypt('same'), cipher.encrypt('same'), 'IV must be random per value');
    });

    test('rejects a ciphertext tampered with in transit', () => {
        const cipher = Cipher.fromHex(KEY);
        const raw = Buffer.from(cipher.encrypt('sensitive'), 'base64');
        raw[raw.length - 1] = raw[raw.length - 1]! ^ 0xff;
        assert.throws(() => cipher.decrypt(raw.toString('base64')));
    });

    test('rejects a truncated record instead of returning garbage', () => {
        assert.throws(() => Cipher.fromHex(KEY).decrypt('YWJj'), /too short/);
    });

    test('cannot decrypt with a different key', () => {
        const sealed = Cipher.fromHex(KEY).encrypt('secret');
        assert.throws(() => Cipher.fromHex(OTHER_KEY).decrypt(sealed));
    });

    test('rejects keys that are not 64 hex characters', () => {
        for (const bad of ['', 'abc', 'z'.repeat(64), '0'.repeat(63), '0'.repeat(65)]) {
            assert.throws(() => Cipher.fromHex(bad), /64 hex characters/);
        }
    });

    test('accepts a generated key and tolerates surrounding whitespace', () => {
        assert.doesNotThrow(() => Cipher.fromHex(`  ${KEY}\n`));
    });

    test('keyed digest differs per key and is stable per key', () => {
        const a = Cipher.fromHex(KEY);
        const b = Cipher.fromHex(OTHER_KEY);
        assert.equal(a.digest('payload'), a.digest('payload'));
        assert.notEqual(a.digest('payload'), b.digest('payload'));
    });

    test('verifier matches its own key and rejects others', () => {
        const a = Cipher.fromHex(KEY);
        assert.equal(a.matchesVerifier(a.makeVerifier()), true);
        assert.equal(Cipher.fromHex(OTHER_KEY).matchesVerifier(a.makeVerifier()), false);
        assert.equal(a.matchesVerifier('not-hex'), false);
        assert.equal(a.matchesVerifier(''), false);
    });
});

describe('encrypted store', () => {
    test('round-trips an entry through the cache', () => {
        const store = new CacheStore(db, {}, Cipher.fromHex(KEY));
        store.set({ model: 'm', prompt: 'secret prompt', response: 'secret response' });
        const hit = store.get('m', 'secret prompt');
        assert.equal(hit?.response, 'secret response');
        assert.equal(hit?.prompt, 'secret prompt');
    });

    test('does not leave prompt or response in cleartext on disk', () => {
        const store = new CacheStore(db, {}, Cipher.fromHex(KEY));
        store.set({ model: 'm', prompt: 'PROMPT-NEEDLE', response: 'RESPONSE-NEEDLE' });

        const row = db.prepare('SELECT prompt, response FROM nodes').get() as {
            prompt: string;
            response: string;
        };
        assert.equal(row.prompt.includes('PROMPT-NEEDLE'), false, 'prompt stored in cleartext');
        assert.equal(row.response.includes('RESPONSE-NEEDLE'), false, 'response stored in cleartext');
    });

    test('the cache key is not a plain hash of the prompt when encrypting', async () => {
        const { createHash } = await import('node:crypto');
        const store = new CacheStore(db, {}, Cipher.fromHex(KEY));
        store.set({ model: 'm', prompt: 'guessable', response: 'x' });

        const { key_hash } = db.prepare('SELECT key_hash FROM nodes').get() as { key_hash: string };
        const unkeyed = createHash('sha256')
            .update(JSON.stringify({ model: 'm', params: {}, prompt: 'guessable' }))
            .digest('hex');
        assert.notEqual(key_hash, unkeyed, 'an unkeyed digest would let a reader confirm guesses');
    });

    test('stats decrypt prompts for the top-entries report', () => {
        const store = new CacheStore(db, {}, Cipher.fromHex(KEY));
        store.set({ model: 'm', prompt: 'readable again', response: 'x' });
        store.get('m', 'readable again');
        assert.equal(store.stats().topEntries[0]?.prompt, 'readable again');
    });

    test('similarity search still works over encrypted entries', () => {
        const store = new CacheStore(db, {}, Cipher.fromHex(KEY));
        store.set({ model: 'm', prompt: 'what is the capital of France', response: 'Paris.' });
        const matches = store.query('France capital city', { minSimilarity: 0.3 });
        assert.ok(matches.length > 0);
        assert.equal(matches[0]!.response, 'Paris.');
    });

    test('eviction still bounds an encrypted cache', () => {
        const store = new CacheStore(db, { maxEntries: 3 }, Cipher.fromHex(KEY));
        for (let i = 0; i < 10; i++) {
            store.set({ model: 'm', prompt: `entry ${i}`, response: 'x', ttlSeconds: null });
        }
        assert.equal(store.stats().entries, 3);
    });
});

describe('key / database mismatch', () => {
    test('refuses to open an encrypted database without the key', () => {
        new CacheStore(db, {}, Cipher.fromHex(KEY)).set({ model: 'm', prompt: 'p', response: 'r' });
        assert.throws(() => new CacheStore(db), /encrypted but NOWHEREMAN_ENCRYPTION_KEY is not set/);
    });

    test('refuses to open an encrypted database with the wrong key', () => {
        new CacheStore(db, {}, Cipher.fromHex(KEY)).set({ model: 'm', prompt: 'p', response: 'r' });
        assert.throws(() => new CacheStore(db, {}, Cipher.fromHex(OTHER_KEY)), /does not match/);
    });

    test('refuses to encrypt into a database that already holds cleartext entries', () => {
        new CacheStore(db).set({ model: 'm', prompt: 'p', response: 'r' });
        assert.throws(() => new CacheStore(db, {}, Cipher.fromHex(KEY)), /holds unencrypted entries/);
    });

    test('adopts encryption on an empty database', () => {
        assert.doesNotThrow(() => new CacheStore(db, {}, Cipher.fromHex(KEY)));
    });

    test('a broken database fails loudly at construction rather than being read as "empty"', () => {
        // migrateEmbeddings() also unconditionally queries `nodes` and would throw for the same
        // reason regardless of what assertKeyMatchesDatabase does, masking whether this specific
        // check is the one behaving correctly — so pre-stamp the embedding version to make that
        // migration a no-op, isolating the failure to the row-count check this test targets.
        // Stamp with the real constants rather than literals: hardcoding them would stop
        // matching on the next EMBEDDING_VERSION bump, letting migrateEmbeddings() run and throw
        // for the unrelated reason this pre-stamp exists to exclude — the assertion would still
        // pass while testing nothing.
        db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(EMBEDDING_META_KEY, EMBEDDING_VERSION);
        db.exec('DROP TABLE nodes');
        assert.throws(() => new CacheStore(db, {}, Cipher.fromHex(KEY)), /no such table/);
    });

    test('reopens cleanly with the correct key', () => {
        const path = join(dir, 'reopen.db');
        const first = openDb(path);
        new CacheStore(first, {}, Cipher.fromHex(KEY)).set({
            model: 'm',
            prompt: 'durable secret',
            response: 'still here',
            ttlSeconds: null
        });
        first.close();

        const second = openDb(path);
        const hit = new CacheStore(second, {}, Cipher.fromHex(KEY)).get('m', 'durable secret');
        assert.equal(hit?.response, 'still here');
        second.close();
    });
});

describe('file permissions', () => {
    test('the database file is not readable by group or others', () => {
        const mode = statSync(join(dir, 'cache.db')).mode & 0o777;
        assert.equal(mode & 0o077, 0, `expected owner-only permissions, got ${mode.toString(8)}`);
    });

    test('the containing directory is owner-only', () => {
        const nested = join(dir, 'nested', 'cache.db');
        const inner = openDb(nested);
        const mode = statSync(join(dir, 'nested')).mode & 0o777;
        inner.close();
        assert.equal(mode & 0o077, 0, `expected owner-only directory, got ${mode.toString(8)}`);
    });

    test('a pre-existing directory with looser permissions is still locked down', () => {
        // mkdirSync's mode option only applies to a directory it actually creates — a directory
        // that already exists (e.g. left behind by a default umask, or an older nowhereman
        // version) keeps whatever permissions it already had unless something chmods it.
        const preExisting = join(dir, 'already-here');
        mkdirSync(preExisting, { mode: 0o755 });
        const inner = openDb(join(preExisting, 'cache.db'));
        const mode = statSync(preExisting).mode & 0o777;
        inner.close();
        assert.equal(mode & 0o077, 0, `expected owner-only directory, got ${mode.toString(8)}`);
    });
});

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './db.js';
import { CacheStore } from './store.js';

/**
 * The niche this cache actually serves: a result that was **expensive to produce** outliving the
 * session that produced it.
 *
 * The motivating scenario is re-orientation. An agent reads a cloned repository to understand it,
 * the session ends, and a later session needs the same understanding. Caching the *files* saves
 * nothing — a hit hands back the same tokens the read would have. Caching what the first session
 * *concluded* replaces a re-read of the whole source with one small entry. Measured on
 * express/lib: 15,504 tokens to re-read six files versus 549 to serve the derived orientation,
 * about 28x fewer, and the write pays for itself on the first reuse.
 *
 * These tests pin the two properties that scenario depends on: recall across sessions when the
 * wording differs, and a way to notice the source moved underneath a derivation.
 */

let dir: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nowhereman-niche-'));
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

/** Run a callback against its own CacheStore, closing the database afterwards — one "session". */
function session<T>(dbPath: string, fn: (store: CacheStore) => T): T {
    const db = openDb(dbPath);
    try {
        return fn(new CacheStore(db));
    } finally {
        db.close();
    }
}

const ORIENTATION = `
    Express is a thin composition layer: routing lives in the external router package and body
    parsing in body-parser, so neither is in this repository. What it owns is app assembly, the
    request and response prototype extensions, and the settings system. createApplication returns
    a function delegating to app.handle, with the application prototype and EventEmitter mixed in.
    Settings are central because app.set runs compile hooks for etag, query parser and trust proxy,
    transforming those values on write rather than on read.
`;

const CACHING_NOTES = `
    Freshness follows Cache-Control semantics: an entry past its TTL but inside the
    stale-while-revalidate window is still returned and marked stale, and callers decide whether
    that is good enough or whether to redo the work and refresh it.
`;

/** A tiny provenance node standing for a source file — its fingerprint, never its contents. */
function recordSource(store: CacheStore, path: string, contents: string): string {
    return store.set({
        model: 'source-fingerprint',
        prompt: path,
        response: createHash('sha256').update(contents).digest('hex'),
        ttlSeconds: null,
        tags: ['provenance']
    }).id;
}

describe('a derivation outliving the session that produced it', () => {
    test('is recalled in a later session even when the question is worded differently', () => {
        const dbPath = join(dir, 'cache.db');

        session(dbPath, store => {
            store.set({
                model: 'orient',
                prompt: 'express/lib architecture: how the app is assembled and where routing lives',
                response: ORIENTATION,
                ttlSeconds: null
            });
        });

        // A separate session: no shared memory, and an agent that phrases it its own way.
        const matches = session(dbPath, store =>
            store.query('where is request routing handled in express and how is the app built')
        );

        assert.ok(matches.length > 0, 'expected the earlier derivation to be recalled');
        assert.match(matches[0]!.response, /thin composition layer/);
    });

    test('survives as an exact-key hit too, for a caller that repeats the question verbatim', () => {
        const dbPath = join(dir, 'cache.db');
        const question = 'express/lib architecture: how the app is assembled and where routing lives';

        session(dbPath, store => {
            store.set({ model: 'orient', prompt: question, response: ORIENTATION, ttlSeconds: null });
        });

        const hit = session(dbPath, store => store.get('orient', question));

        assert.equal(hit?.fresh, true);
        assert.match(hit!.response, /thin composition layer/);
    });
});

describe('fan-out: many cold contexts sharing one derivation', () => {
    /**
     * The measured case. Eight subagents dispatched over one repository each read
     * `pkg/fuse/fuse.go` cold — 60% of all their reads were of a file another had already read,
     * ~243k redundant tokens across the dispatch.
     *
     * Caching the *file* cannot recover any of it: the bytes still have to enter each agent's
     * context, so a hit costs what the read did. Sharing a *derivation* does: 15,733 tokens of
     * source against a 489-token orientation, ~79% cheaper across eight agents even when each
     * still reads one function afterwards.
     *
     * Unlike the cross-session case, these contexts are alive at the same time, so what matters
     * is that a write from one is immediately visible to the others.
     */
    test('a derivation written by one live context is visible to others already open', () => {
        const dbPath = join(dir, 'cache.db');
        const lead = openDb(dbPath);
        const followers = [openDb(dbPath), openDb(dbPath), openDb(dbPath)];

        try {
            // Every follower is already open *before* the lead writes, as a real dispatch is.
            const leadStore = new CacheStore(lead);
            const followerStores = followers.map(db => new CacheStore(db));

            leadStore.set({
                model: 'orient',
                prompt: 'pkg/fuse/fuse.go: locking and concurrency surface',
                response: ORIENTATION,
                ttlSeconds: null
            });

            for (const store of followerStores) {
                const found = store.query('what guards concurrent access in the fuse layer');
                assert.ok(found.length > 0, 'a follower could not see the lead context write');
            }
        } finally {
            lead.close();
            for (const db of followers) db.close();
        }
    });

    test('concurrent writes from several open contexts all land', () => {
        const dbPath = join(dir, 'cache.db');
        const dbs = Array.from({ length: 6 }, () => openDb(dbPath));

        try {
            const stores = dbs.map(db => new CacheStore(db));
            // Interleaved across connections, the way parallel agents reporting findings would be.
            for (let round = 0; round < 4; round++) {
                stores.forEach((store, i) =>
                    store.set({ model: 'agent', prompt: `angle ${i} round ${round}`, response: 'finding body' })
                );
            }
            assert.equal(stores[0]!.stats().entries, 24, 'writes were lost under concurrent connections');
        } finally {
            for (const db of dbs) db.close();
        }
    });
});

describe('noticing the source moved under a derivation', () => {
    test('a changed source file invalidates what was derived from it, and nothing else', () => {
        const dbPath = join(dir, 'cache.db');

        const ids = session(dbPath, store => {
            // Provenance entries are fingerprints, not contents: caching the file itself would
            // cost a full re-emission and save nothing on the way back out.
            const application = recordSource(store, 'lib/application.js', 'original application source');
            const unrelated = recordSource(store, 'docs/caching.md', 'original caching notes');

            const orientation = store.set({
                model: 'orient',
                prompt: 'express/lib architecture',
                response: ORIENTATION,
                ttlSeconds: null,
                derivedFrom: [application]
            });
            const notes = store.set({
                model: 'summarize',
                prompt: 'how freshness works',
                response: CACHING_NOTES,
                ttlSeconds: null,
                derivedFrom: [unrelated]
            });
            return { application, orientation: orientation.id, notes: notes.id };
        });

        // lib/application.js changed on disk, so the fingerprint no longer matches.
        const deleted = session(dbPath, store => store.invalidate(ids.application, { cascade: true }).deleted);

        assert.ok(deleted.includes(ids.orientation), 'the derivation should have gone with its source');

        session(dbPath, store => {
            assert.equal(store.get('orient', 'express/lib architecture'), null, 'stale derivation still served');
            assert.ok(
                store.get('summarize', 'how freshness works') !== null,
                'a derivation from an untouched source must survive'
            );
        });
    });

    test('a fingerprint entry is a rounding error next to the content it stands for', () => {
        const dbPath = join(dir, 'cache.db');
        const contents = 'x'.repeat(60_000);

        const bytes = session(dbPath, store => {
            recordSource(store, 'lib/response.js', contents);
            return store.stats().bytesStored;
        });

        assert.ok(
            bytes < contents.length / 100,
            `provenance cost ${bytes} bytes against ${contents.length} of source — it must stay negligible`
        );
    });
});

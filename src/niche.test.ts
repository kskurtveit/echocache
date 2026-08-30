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

describe('the case grep cannot answer: cached research and judgment calls', () => {
    /**
     * Live-validated 2026-08-30: a real BM25-vs-SPLADE web search, synthesized into a design
     * judgment for this project, cached, then recalled by different wording. `cache_query`
     * ranked it first (0.69) ahead of a module-reference entry that shares surface vocabulary
     * ("sparse", "vectors") but is about something else entirely (0.54) — that false-positive
     * risk is real and worth guarding against structurally, not just noting.
     *
     * Real production cost for one such conclusion, pulled from this project's own session
     * history rather than estimated: 22 tool calls, 37,119 output tokens + 84 input, to reach a
     * 255-token synthesized answer. Weighted at output = 5x input (Opus 5 / Sonnet 5 pricing),
     * reproducing it costs ~185,679; serving it back costs ~255. Because that gap is so large,
     * a single reuse justifies the write (~1,275 to re-emit) by a ~145x margin — unlike a cached
     * file read, which loses at every hit rate regardless of size.
     */
    const CODE_DESCRIPTION = `
        Vectors are sparse: parallel arrays of buckets and values, ascending by bucket. A query is
        scattered into a dense lookup once per search so scoring each candidate stays proportional
        to its own term count rather than the whole hash space. Weights come from a document
        frequency table rebuilt from the corpus, never baked into the stored vector.
    `;
    const RESEARCH_CONCLUSION = `
        Stick with BM25-style lexical scoring; a learned sparse retrieval model is not a clear
        enough win to justify the dependency. Published benchmarks show BM25 beating dense
        retrieval on precise-terminology text, and a learned sparse model beating BM25 by only
        0.002 to 0.105 nDCG@10 with no systematic winner across corpus types, while requiring a
        trained checkpoint and sparsity regularization this project has no infrastructure for.
        Revisit only if a future need requires cross-lingual or synonym-level matching.
    `;

    test('a cached research judgment outranks an unrelated entry that shares surface vocabulary', () => {
        const dbPath = join(dir, 'cache.db');
        session(dbPath, store => {
            store.set({ model: 'orient', prompt: 'vector storage format', response: CODE_DESCRIPTION });
            store.set({
                model: 'research',
                prompt: 'is BM25 competitive with a learned sparse retrieval model for this corpus',
                response: RESEARCH_CONCLUSION
            });
        });

        const matches = session(dbPath, store =>
            store.query('should we swap the retrieval scoring for a trained model instead')
        );

        assert.ok(matches.length > 0, 'expected the research conclusion to be recalled');
        assert.equal(matches[0]!.model, 'research', 'a surface-vocabulary collision outranked the real answer');
    });
});

describe('fan-out: many cold contexts sharing one derivation', () => {
    /**
     * Fan-out over shared source turned out narrower than first measured: agents already grep
     * and read slices rather than whole files, so a cached *map of where things live* competes
     * with grep and loses (measured 27% worse in a real dispatch; see AGENTS.md). What still pays
     * in a fan-out is the same flagship case as everywhere else — a cached *research or judgment*
     * conclusion (728x cheaper to serve than to reproduce, measured from real usage) — just
     * shared with several live agents instead of a later session.
     *
     * That shared-live-agents shape needs something the cross-session case never did: several
     * contexts open on the cache *at the same time*. This pins the two properties that depend on
     * — a write from one live context is visible to others already open, and concurrent writes
     * don't race-lose.
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

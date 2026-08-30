import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, DEFAULT_CONFIG } from './config.js';

const ENV_KEYS = [
    'NOWHEREMAN_DB_PATH',
    'NOWHEREMAN_MAX_ENTRIES',
    'NOWHEREMAN_MAX_BYTES',
    'NOWHEREMAN_DEFAULT_TTL_SECONDS',
    'NOWHEREMAN_SIMILARITY_THRESHOLD',
    'NOWHEREMAN_LINK_CANDIDATE_POOL'
] as const;

afterEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
});

describe('config', () => {
    test('falls back to defaults when nothing is set', () => {
        const config = loadConfig();
        assert.equal(config.maxEntries, DEFAULT_CONFIG.maxEntries);
        assert.equal(config.maxBytes, DEFAULT_CONFIG.maxBytes);
        assert.equal(config.similarityThreshold, DEFAULT_CONFIG.similarityThreshold);
        assert.ok(config.dbPath.endsWith('cache.db'));
    });

    test('reads overrides from the environment', () => {
        process.env.NOWHEREMAN_MAX_ENTRIES = '42';
        process.env.NOWHEREMAN_SIMILARITY_THRESHOLD = '0.5';
        process.env.NOWHEREMAN_DB_PATH = '/tmp/custom.db';
        const config = loadConfig();
        assert.equal(config.maxEntries, 42);
        assert.equal(config.similarityThreshold, 0.5);
        assert.equal(config.dbPath, '/tmp/custom.db');
    });

    test('treats an empty string as unset rather than as zero', () => {
        process.env.NOWHEREMAN_MAX_ENTRIES = '';
        assert.equal(loadConfig().maxEntries, DEFAULT_CONFIG.maxEntries);
    });

    test('truncates a fractional integer setting', () => {
        process.env.NOWHEREMAN_MAX_ENTRIES = '10.9';
        assert.equal(loadConfig().maxEntries, 10);
    });

    test('rejects a non-numeric integer setting', () => {
        process.env.NOWHEREMAN_MAX_ENTRIES = 'lots';
        assert.throws(() => loadConfig(), /must be a non-negative number/);
    });

    test('rejects a negative integer setting', () => {
        process.env.NOWHEREMAN_MAX_BYTES = '-1';
        assert.throws(() => loadConfig(), /must be a non-negative number/);
    });

    test('rejects a similarity threshold outside 0..1', () => {
        process.env.NOWHEREMAN_SIMILARITY_THRESHOLD = '1.5';
        assert.throws(() => loadConfig(), /between 0 and 1/);
    });

    test('accepts the boundary values of the similarity threshold', () => {
        process.env.NOWHEREMAN_SIMILARITY_THRESHOLD = '0';
        assert.equal(loadConfig().similarityThreshold, 0);
        process.env.NOWHEREMAN_SIMILARITY_THRESHOLD = '1';
        assert.equal(loadConfig().similarityThreshold, 1);
    });

    test('rejects a link candidate pool of zero rather than silently disabling auto-linking', () => {
        // Unlike maxEntries/maxBytes, 0 here isn't a plausible deliberate choice — it's a LIMIT
        // in the linking query, so it turns off the whole similarity graph with no error, one
        // typo away from similarityThreshold's loud validation for the same kind of mistake.
        process.env.NOWHEREMAN_LINK_CANDIDATE_POOL = '0';
        assert.throws(() => loadConfig(), /must be a positive number/);
    });
});

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';
import type Database from 'better-sqlite3';
import { openDb } from './db.js';
import { createServer } from './server.js';

let dir: string;
let db: Database.Database;
let client: Client;

/** Tool results come back as a JSON text block; parse it the way a caller would. */
function payload(result: { content?: unknown }): Record<string, unknown> {
    const content = result.content as { type: string; text: string }[] | undefined;
    assert.ok(content?.[0], 'expected a content block');
    return JSON.parse(content[0]!.text);
}

async function call(name: string, args: Record<string, unknown> = {}) {
    return client.callTool({ name, arguments: args });
}

beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'nowhereman-srv-'));
    db = openDb(join(dir, 'cache.db'));
    const handler = createMcpHandler(() => createServer(db));
    const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
        fetch: (url, init) => handler.fetch(new Request(url, init))
    });
    client = new Client({ name: 'nowhereman-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
    await client.connect(transport);
});

afterEach(async () => {
    await client.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
});

describe('MCP surface', () => {
    test('registers exactly the six documented cache tools', async () => {
        const { tools } = await client.listTools();
        const names = tools.map(t => t.name).sort();
        assert.deepEqual(names, [
            'cache_get',
            'cache_invalidate',
            'cache_query',
            'cache_related',
            'cache_set',
            'cache_stats'
        ]);
    });

    test('every tool carries a description the model can route on', async () => {
        const { tools } = await client.listTools();
        for (const tool of tools) {
            assert.ok(tool.description && tool.description.length > 40, `${tool.name} needs a real description`);
        }
    });

    test('rejects arguments that violate the input schema', async () => {
        const result = await call('cache_related', { id: 'abc', depth: 99 });
        assert.equal(result.isError, true, 'depth is capped at 5, so 99 must be rejected');
    });

    test('rejects a call missing a required argument', async () => {
        const result = await call('cache_get', { model: 'm' });
        assert.equal(result.isError, true);
    });
});

describe('cache_get / cache_set over MCP', () => {
    test('reports a miss before anything is stored', async () => {
        assert.deepEqual(payload(await call('cache_get', { model: 'm', prompt: 'p' })), { hit: false });
    });

    test('stores then serves a response end to end', async () => {
        const set = payload(await call('cache_set', { model: 'm', prompt: 'p', response: 'cached answer' }));
        assert.ok(typeof set.id === 'string');

        const got = payload(await call('cache_get', { model: 'm', prompt: 'p' }));
        assert.equal(got.hit, true);
        const entry = got.entry as Record<string, unknown>;
        assert.equal(entry.response, 'cached answer');
        assert.equal(entry.fresh, true);
    });

    test('a differing params object is a different cache key', async () => {
        await call('cache_set', { model: 'm', prompt: 'p', response: 'a', params: { temp: 0 } });
        assert.equal(payload(await call('cache_get', { model: 'm', prompt: 'p', params: { temp: 1 } })).hit, false);
        assert.equal(payload(await call('cache_get', { model: 'm', prompt: 'p', params: { temp: 0 } })).hit, true);
    });

    test('ttl_seconds null stores an entry that never expires', async () => {
        await call('cache_set', { model: 'm', prompt: 'forever', response: 'x', ttl_seconds: null });
        const got = payload(await call('cache_get', { model: 'm', prompt: 'forever' }));
        assert.equal((got.entry as Record<string, unknown>).ttlSeconds, null);
    });
});

describe('cache_query / cache_related over MCP', () => {
    test('finds a semantically related entry without an exact key', async () => {
        await call('cache_set', { model: 'm', prompt: 'what is the capital of France', response: 'Paris.' });
        const out = payload(await call('cache_query', { text: 'France capital city', min_similarity: 0.3 }));
        assert.ok((out.matches as unknown[]).length > 0);
    });

    test('returns an empty match list rather than erroring on no results', async () => {
        const out = payload(await call('cache_query', { text: 'nothing is stored yet' }));
        assert.deepEqual(out.matches, []);
    });

    test('traverses to an auto-linked neighbour', async () => {
        const a = payload(
            await call('cache_set', {
                model: 'm',
                prompt: 'summarize the quarterly earnings report',
                response: 'Revenue grew.'
            })
        );
        await call('cache_set', {
            model: 'm',
            prompt: 'summarize the quarterly earnings reports',
            response: 'Revenue grew.'
        });
        const out = payload(await call('cache_related', { id: a.id as string }));
        assert.equal((out.related as unknown[]).length, 1);
    });

    test('an unknown id yields no relations rather than an error', async () => {
        const out = payload(await call('cache_related', { id: 'no-such-id' }));
        assert.deepEqual(out.related, []);
    });
});

describe('cache_invalidate over MCP', () => {
    test('cascades to entries derived from the invalidated one', async () => {
        const parent = payload(await call('cache_set', { model: 'm', prompt: 'parent', response: 'p' }));
        await call('cache_set', {
            model: 'm',
            prompt: 'child',
            response: 'c',
            derived_from: [parent.id as string]
        });
        const out = payload(await call('cache_invalidate', { id: parent.id as string, cascade: true }));
        assert.equal((out.deleted as unknown[]).length, 2);
        assert.equal(payload(await call('cache_stats')).entries, 0);
    });
});

describe('cache_stats over MCP', () => {
    test('reports zeroed counters on a cold cache', async () => {
        const stats = payload(await call('cache_stats'));
        assert.equal(stats.entries, 0);
        assert.equal(stats.hitRate, 0);
        assert.equal(stats.tokensServed, 0);
    });

    test('tracks hits, misses and tokens served through the tool surface', async () => {
        await call('cache_set', { model: 'm', prompt: 'p', response: 'x'.repeat(400) });
        await call('cache_get', { model: 'm', prompt: 'p' });
        await call('cache_get', { model: 'm', prompt: 'absent' });

        const stats = payload(await call('cache_stats'));
        assert.equal(stats.hits, 1);
        assert.equal(stats.misses, 1);
        assert.equal(stats.hitRate, 0.5);
        assert.equal(stats.tokensServed, 100);
    });
});

describe('failure handling', () => {
    test('surfaces a store failure as an isError result instead of crashing', async () => {
        // Drop the table out from under the server: the next call must fail loudly, not silently
        // look like a cache miss.
        db.exec('DROP TABLE nodes');
        const result = await call('cache_get', { model: 'm', prompt: 'p' });
        assert.equal(result.isError, true);
        const text = (result.content as { text: string }[])[0]!.text;
        assert.match(text, /nowhereman cache_get failed/);
    });

    test('the server still answers other requests after a failure', async () => {
        db.exec('DROP TABLE nodes');
        assert.equal((await call('cache_get', { model: 'm', prompt: 'p' })).isError, true);
        const { tools } = await client.listTools();
        assert.equal(tools.length, 6, 'server should stay connected and usable');
    });
});

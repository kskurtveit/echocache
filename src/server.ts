import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type Database from 'better-sqlite3';
import { CacheStore } from './store.js';
import type { Config } from './config.js';
import { Cipher } from './crypto.js';

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

/**
 * A cache failure must never take the server down or masquerade as a cache miss with made-up
 * data — surface it to the model as a tool error so it falls back to doing the real work.
 */
function guard(label: string, fn: () => unknown): ToolResult {
    try {
        return { content: [{ type: 'text', text: JSON.stringify(fn()) }] };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[nowhereman] ${label} failed: ${message}`);
        return {
            content: [{ type: 'text', text: `nowhereman ${label} failed: ${message}` }],
            isError: true
        };
    }
}

export function createServer(db: Database.Database, config: Partial<Config> = {}): McpServer {
    const server = new McpServer({ name: 'nowhereman', version: '0.1.0' });
    const cipher = config.encryptionKeyHex ? Cipher.fromHex(config.encryptionKeyHex) : undefined;
    const store = new CacheStore(db, config, cipher);

    server.registerTool(
        'cache_get',
        {
            description:
                'Look up a cached LLM response by exact (model, prompt, params) match, like an HTTP cache ' +
                'checking a request against its cache key. Call this BEFORE issuing an expensive prompt to a ' +
                'model. Returns hit:false on a miss or an expired entry — in that case, run the prompt yourself ' +
                'and store the result with cache_set. On a hit, freshness mirrors HTTP semantics: fresh means ' +
                'use it as-is; stale means it is past its TTL but within its stale-while-revalidate window, so ' +
                'you may still use it but consider refreshing it.',
            inputSchema: z.object({
                model: z.string().describe('Model/tool identifier the response came from, e.g. "claude-sonnet-5"'),
                prompt: z.string().describe('The exact prompt or request text'),
                params: z
                    .record(z.string(), z.unknown())
                    .optional()
                    .describe('Other call parameters that affect the response (temperature, system prompt, etc.)')
            })
        },
        async ({ model, prompt, params }) =>
            guard('cache_get', () => {
                const entry = store.get(model, prompt, params ?? {});
                return entry ? { hit: true, entry } : { hit: false };
            })
    );

    server.registerTool(
        'cache_set',
        {
            description:
                'Store a prompt/response pair in the cache. Call this AFTER getting a fresh response from a ' +
                'model that cache_get did not have. New entries are automatically linked in a similarity graph ' +
                'to existing entries with related content, so cache_related and cache_query can surface them ' +
                'later even without an exact key match. Pass derived_from with parent entry ids if this result ' +
                'was built from other cached entries — invalidating a parent with cascade can then clean up ' +
                'anything derived from it.',
            inputSchema: z.object({
                model: z.string(),
                prompt: z.string(),
                response: z.string().describe('The response text to cache'),
                params: z.record(z.string(), z.unknown()).optional(),
                ttl_seconds: z
                    .number()
                    .int()
                    .nullable()
                    .optional()
                    .describe('Freshness lifetime in seconds. null = never expires. Default: 1 day'),
                stale_while_revalidate_seconds: z
                    .number()
                    .int()
                    .optional()
                    .describe('Extra window after TTL expiry where the entry is still returned, marked stale'),
                tags: z.array(z.string()).optional(),
                derived_from: z.array(z.string()).optional().describe('Ids of parent entries this was built from')
            })
        },
        async ({ model, prompt, response, params, ttl_seconds, stale_while_revalidate_seconds, tags, derived_from }) =>
            guard('cache_set', () =>
                store.set({
                    model,
                    prompt,
                    response,
                    params,
                    ttlSeconds: ttl_seconds,
                    staleWhileRevalidateSeconds: stale_while_revalidate_seconds,
                    tags,
                    derivedFrom: derived_from
                })
            )
    );

    server.registerTool(
        'cache_query',
        {
            description:
                'Semantic search across all cached entries, independent of exact key matching. Use this when ' +
                'you suspect something related was already computed even though the prompt wording differs — ' +
                'the knowledge-graph equivalent of a cache lookup by meaning instead of by exact key.',
            inputSchema: z.object({
                text: z.string().describe('Text to search for semantically related cache entries'),
                top_k: z.number().int().positive().optional().describe('Max results, default 5'),
                min_similarity: z.number().min(0).max(1).optional().describe('Similarity floor 0-1, default 0.3')
            })
        },
        async ({ text, top_k, min_similarity }) =>
            guard('cache_query', () => ({
                matches: store.query(text, { topK: top_k, minSimilarity: min_similarity })
            }))
    );

    server.registerTool(
        'cache_related',
        {
            description:
                'Traverse the cache graph outward from one entry to find connected entries — ones auto-linked ' +
                'for content similarity ("similar" edges) or explicitly declared as built on top of it ' +
                '("derived-from" edges). Use this to pull in everything already known that connects to a given ' +
                'cached result.',
            inputSchema: z.object({
                id: z.string().describe('Id of the entry to start from (from a prior cache_get/set/query result)'),
                relation: z.enum(['similar', 'derived-from']).optional().describe('Filter to one edge type'),
                depth: z.number().int().positive().max(5).optional().describe('Hops to traverse, default 1'),
                limit: z.number().int().positive().optional().describe('Max results, default 20')
            })
        },
        async ({ id, relation, depth, limit }) =>
            guard('cache_related', () => ({ related: store.related(id, { relation, depth, limit }) }))
    );

    server.registerTool(
        'cache_invalidate',
        {
            description:
                'Delete a cache entry, e.g. because the underlying source it was based on changed. With ' +
                'cascade:true, also deletes every entry that declared this one as a derived_from parent, and ' +
                'recursively theirs — dependency-graph invalidation instead of a manual hunt for stale copies.',
            inputSchema: z.object({
                id: z.string(),
                cascade: z.boolean().optional().describe('Also delete entries derived from this one, default false')
            })
        },
        async ({ id, cascade }) => guard('cache_invalidate', () => store.invalidate(id, { cascade }))
    );

    server.registerTool(
        'cache_stats',
        {
            description:
                'Cache analytics: entry/edge counts, hit rate, and an estimated token count saved by serving ' +
                'from cache instead of re-calling a model. Useful for judging whether caching is actually ' +
                'paying off in a given session.',
            inputSchema: z.object({})
        },
        async () => guard('cache_stats', () => store.stats())
    );

    return server;
}

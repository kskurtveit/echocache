import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
    embed,
    idfWeights,
    documentSimilarity,
    queryScore,
    prepareQuery,
    toBuffer,
    fromBuffer,
    type CorpusStats
} from './embed.js';

/** Corpus statistics for an ad-hoc set of documents, as the store computes them from SQLite. */
function statsFor(...texts: string[]): CorpusStats {
    const docFreq = new Map<number, number>();
    for (const text of texts) {
        for (const bucket of embed(text).buckets) {
            docFreq.set(bucket, (docFreq.get(bucket) ?? 0) + 1);
        }
    }
    return { docCount: texts.length, docFreq };
}

function weightsFor(...texts: string[]) {
    return idfWeights(statsFor(...texts));
}

function score(query: string, doc: string, ...corpus: string[]) {
    const weights = weightsFor(...corpus);
    return queryScore(prepareQuery(embed(query), weights), embed(doc), weights);
}

describe('tokenization', () => {
    test('splits camelCase identifiers into their component words', () => {
        const weights = weightsFor('registerTool', 'register tool');
        assert.equal(
            documentSimilarity(embed('registerTool'), embed('register tool'), weights).toFixed(6),
            '1.000000'
        );
    });

    test('splits an acronym run followed by a word, as in McpServer', () => {
        const weights = weightsFor('McpServer', 'mcp server');
        assert.equal(
            documentSimilarity(embed('McpServer'), embed('mcp server'), weights).toFixed(6),
            '1.000000'
        );
    });

    test('counts repeated terms sublinearly rather than linearly', () => {
        const once = embed('alpha');
        const many = embed('alpha alpha alpha alpha alpha alpha alpha alpha');
        // Eight occurrences, damped: 1 + ln(8) ≈ 3.08, not 8.
        assert.ok(Math.abs(many.values[0]!) < 4, `expected under 4, got ${Math.abs(many.values[0]!)}`);
        assert.ok(Math.abs(many.values[0]!) > Math.abs(once.values[0]!));
    });
});

describe('document similarity', () => {
    test('identical text scores exactly 1', () => {
        const weights = weightsFor('hello world', 'something else entirely');
        assert.equal(
            documentSimilarity(embed('hello world'), embed('hello world'), weights).toFixed(6),
            '1.000000'
        );
    });

    test('unrelated text scores low and stays in range', () => {
        const a = 'kubernetes ingress tls certificates';
        const b = 'sourdough bread starter flour';
        const sim = documentSimilarity(embed(a), embed(b), weightsFor(a, b));
        assert.ok(sim <= 1 && sim >= -1, `out of range: ${sim}`);
        assert.ok(sim < 0.25, `unrelated text scored ${sim}`);
    });

    test('empty text produces an empty vector and scores zero without NaN', () => {
        const empty = embed('');
        assert.equal(empty.buckets.length, 0);
        const sim = documentSimilarity(empty, empty, weightsFor('anything at all'));
        assert.equal(Number.isNaN(sim), false);
        assert.equal(sim, 0);
    });
});

describe('query scoring', () => {
    test('a query identical to the document scores exactly 1', () => {
        const text = 'connection pooling for postgres';
        assert.equal(score(text, text, text, 'unrelated filler content').toFixed(6), '1.000000');
    });

    test('stays within 0 and 1 for a short query against a long document', () => {
        const doc = 'connection pooling for postgres '.repeat(60);
        const value = score('postgres pooling', doc, doc, 'entirely different subject matter');
        assert.ok(value >= 0 && value <= 1, `out of range: ${value}`);
        assert.ok(value > 0, 'expected a genuine match to score above zero');
    });

    test('gives partial credit when a document matches only some query terms', () => {
        const both = 'ingress certificates';
        const half = 'ingress deployments';
        const full = score('ingress certificates', both, both, half, 'unrelated filler');
        const partial = score('ingress certificates', half, both, half, 'unrelated filler');
        assert.ok(partial < full, `partial ${partial} should be below full ${full}`);
        assert.ok(partial > 0, 'a partial match should still score above zero');
    });

    test('a query term no entry contains does not drag down the terms that match', () => {
        // "city" appears in no document. Weighting it as maximally rare — which textbook IDF
        // does — made a genuine match score 0.24 instead of 0.86.
        const doc = 'what is the capital of France Paris';
        const withNovelTerm = score('France capital city', doc, doc);
        const withoutIt = score('France capital', doc, doc);
        assert.ok(
            Math.abs(withNovelTerm - withoutIt) < 0.05,
            `novel term shifted the score from ${withoutIt} to ${withNovelTerm}`
        );
    });
});

describe('vector serialization', () => {
    test('buffer round trip preserves buckets and values', () => {
        const original = embed('round trip me');
        const back = fromBuffer(toBuffer(original));
        assert.deepEqual(Array.from(back.buckets), Array.from(original.buckets));
        assert.deepEqual(Array.from(back.values), Array.from(original.values));
    });

    test('decodes correctly from an intentionally unaligned buffer', () => {
        const original = embed('alignment check');
        const src = toBuffer(original);
        // Force a non-4-byte-aligned byteOffset, which a naive typed-array view would reject.
        const padded = Buffer.alloc(src.byteLength + 1);
        src.copy(padded, 1);
        const unaligned = padded.subarray(1);
        assert.notEqual(unaligned.byteOffset % 4, 0);
        assert.deepEqual(Array.from(fromBuffer(unaligned).buckets), Array.from(original.buckets));
    });

    test('an empty vector round trips as empty', () => {
        assert.equal(fromBuffer(toBuffer(embed(''))).buckets.length, 0);
    });
});

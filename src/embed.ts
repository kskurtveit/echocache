/**
 * Local, dependency-free text embedding and scoring.
 *
 * This is deliberately not a neural embedding model: pulling one in would mean a
 * multi-hundred-MB download and real compute cost on every cache write, which defeats the
 * point of a *cache*. It is the classic feature-hashing ("hashing trick") bag-of-words
 * vector, weighted at scoring time with IDF drawn from the corpus itself.
 *
 * Three things here exist because the naive version measurably failed on real content:
 *
 * - Vectors are stored **sparsely**. A small dense space cannot tell "this term appears in no
 *   cached entry" apart from "this term collided with an unrelated one", and that ambiguity
 *   produced both failure modes at once: queries with novel words scored near zero, while
 *   queries matching nothing at all scored 0.44 on collision noise. A wide hash space makes
 *   collisions rare enough that absence is meaningful, and sparse storage keeps that wide
 *   space costing no more than the dense narrow one did.
 * - Term frequency is damped (1 + log tf) per *token*, so a word repeated forty times in a
 *   long document stops dominating its vector.
 * - IDF is applied at scoring time, not baked into stored vectors, which would leave every
 *   stored vector stale as soon as the next entry landed.
 */

/**
 * Bucket count. Wide enough that a few hundred distinct tokens collide rarely; the cost of
 * widening it is paid in the (small) IDF weight table, not in per-entry storage.
 */
const HASH_SPACE = 16384;

/**
 * How much of a document's *total* mass counts against a query score, versus only the part
 * inside the query's own buckets. 0 scores pure coverage, which lets a sprawling entry match
 * anything; 1 is plain cosine, which buries any short query. Calibrated in retrieval.test.ts.
 */
const BREADTH_PENALTY = 0.25;

/**
 * Document frequency is meaningless in a nearly-empty cache, so IDF is smoothed as though the
 * corpus were at least this large. Keeps a threshold meaning the same thing on a cache holding
 * three entries and one holding thirty thousand.
 */
const MIN_EFFECTIVE_CORPUS = 20;

function fnv1a(str: string): number {
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}

/**
 * Split on non-alphanumerics *and* on camelCase boundaries, so `registerTool` is reachable by
 * "register" and "tool" and `McpServer` by "mcp" and "server". Without this, a cache holding
 * source code is unsearchable by prose: every identifier becomes one opaque token that no
 * natural query ever spells.
 */
function tokenize(text: string): string[] {
    return text
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(tok => tok.length > 1);
}

/** A sparse feature-hashed vector: parallel arrays, ascending by bucket. */
export interface Embedding {
    buckets: Int32Array;
    /** Damped term frequency, signed. Deliberately not normalized. */
    values: Float32Array;
}

export interface CorpusStats {
    docCount: number;
    /** Per bucket: how many entries put any weight in it. Buckets nobody uses are absent. */
    docFreq: Map<number, number>;
}

export function embed(text: string): Embedding {
    const counts = new Map<string, number>();
    for (const token of tokenize(text)) {
        counts.set(token, (counts.get(token) ?? 0) + 1);
    }

    const accumulated = new Map<number, number>();
    for (const [token, tf] of counts) {
        const h = fnv1a(token);
        const bucket = h % HASH_SPACE;
        const sign = h & 0x1 ? 1 : -1; // signed hashing reduces collision bias
        accumulated.set(bucket, (accumulated.get(bucket) ?? 0) + sign * (1 + Math.log(tf)));
    }

    const buckets = Int32Array.from(accumulated.keys()).sort();
    const values = new Float32Array(buckets.length);
    for (let i = 0; i < buckets.length; i++) values[i] = accumulated.get(buckets[i]!)!;
    return { buckets, values };
}

/**
 * BM25-style inverse document frequency.
 *
 * A bucket no stored entry occupies weighs nothing. Textbook IDF scores it *highest* — it is
 * maximally rare — but here it cannot match anything, so all it would do is inflate a query's
 * norm and drag every score down in proportion to how many novel words the caller happened to
 * use. Scoring over the representable subspace keeps a score about terms the cache can answer
 * for. This is only sound because the hash space is wide enough that an unoccupied bucket
 * really does mean an unseen term rather than a missed collision.
 */
function idf(docCount: number, df: number): number {
    if (docCount === 0) return 1;
    if (df === 0) return 0;
    // Smooth against a minimum corpus size. Raw IDF is degenerate when the cache is nearly
    // empty: with two entries, a term they *share* occurs in 100% of documents and so is scored
    // as carrying no information — exactly backwards for judging whether the two are related.
    // Pretending the corpus is at least MIN_EFFECTIVE_CORPUS entries keeps weights sane while
    // the cache fills, and converges to ordinary IDF once it actually holds that many.
    const effective = Math.max(docCount, MIN_EFFECTIVE_CORPUS);
    return Math.max(0, Math.log(1 + (effective - df + 0.5) / (df + 0.5)));
}

/** Dense IDF lookup over the hash space — small, and reused across every entry in one scan. */
export function idfWeights(stats: CorpusStats): Float32Array {
    const weights = new Float32Array(HASH_SPACE);
    for (const [bucket, df] of stats.docFreq) {
        if (bucket >= 0 && bucket < HASH_SPACE) weights[bucket] = idf(stats.docCount, df);
    }
    return weights;
}

function weightedNorm(embedding: Embedding, weights: Float32Array): number {
    let sum = 0;
    for (let i = 0; i < embedding.buckets.length; i++) {
        const v = embedding.values[i]! * weights[embedding.buckets[i]!]!;
        sum += v * v;
    }
    return Math.sqrt(sum);
}

/** Scatter a sparse vector into a dense lookup, so a scan can probe it in constant time. */
function toDense(embedding: Embedding): Float32Array {
    const dense = new Float32Array(HASH_SPACE);
    for (let i = 0; i < embedding.buckets.length; i++) dense[embedding.buckets[i]!] = embedding.values[i]!;
    return dense;
}

/**
 * Symmetric similarity between two entries — used for auto-linking, where both sides are full
 * cache entries of broadly comparable shape.
 */
export function documentSimilarity(a: Embedding, b: Embedding, weights: Float32Array): number {
    const na = weightedNorm(a, weights);
    const nb = weightedNorm(b, weights);
    if (na === 0 || nb === 0) return 0;

    const dense = toDense(a);
    let dot = 0;
    for (let i = 0; i < b.buckets.length; i++) {
        const bucket = b.buckets[i]!;
        const w = weights[bucket]!;
        dot += dense[bucket]! * b.values[i]! * w * w;
    }
    return dot / (na * nb);
}

/**
 * A query prepared once per search, so scoring each candidate is O(terms in that candidate)
 * rather than O(hash space).
 */
export interface PreparedQuery {
    dense: Float32Array;
    norm: number;
}

export function prepareQuery(query: Embedding, weights: Float32Array): PreparedQuery {
    return { dense: toDense(query), norm: weightedNorm(query, weights) };
}

/**
 * Asymmetric score for a short query against a potentially long entry.
 *
 * Plain cosine cannot do this job: every term an entry has and the query lacks inflates the
 * entry's norm and drags the score toward zero, so a nine-word question scored ~0.08 against
 * the very document that answered it. So the entry is projected onto the buckets the query
 * occupies and the cosine is taken there — "of what this query asks about, how much does this
 * entry have?" — with the entry's full norm blended into the denominator so that an entry
 * whose mass mostly lies elsewhere is divided down rather than scoring on coverage alone.
 *
 * Bounded in [0,1], so it satisfies the range the tool schema promises, and identical text
 * still scores exactly 1.
 */
export function queryScore(query: PreparedQuery, doc: Embedding, weights: Float32Array): number {
    if (query.norm === 0) return 0;

    let dot = 0;
    let restrictedNorm = 0;
    let fullNorm = 0;
    for (let i = 0; i < doc.buckets.length; i++) {
        const bucket = doc.buckets[i]!;
        const w = weights[bucket]!;
        const dw = doc.values[i]! * w;
        fullNorm += dw * dw;
        const q = query.dense[bucket]!;
        if (q === 0) continue; // outside the query's subspace: ignored, not penalized
        dot += q * w * dw;
        restrictedNorm += dw * dw;
    }
    if (dot <= 0) return 0;

    const denom =
        query.norm *
        Math.pow(Math.sqrt(restrictedNorm), 1 - BREADTH_PENALTY) *
        Math.pow(Math.sqrt(fullNorm), BREADTH_PENALTY);
    return denom === 0 ? 0 : Math.min(1, dot / denom);
}

/** Wire format: one Int32 bucket plus one Float32 value per occupied bucket. */
const RECORD_BYTES = 8;

export function toBuffer(embedding: Embedding): Buffer {
    const buf = Buffer.allocUnsafe(embedding.buckets.length * RECORD_BYTES);
    for (let i = 0; i < embedding.buckets.length; i++) {
        buf.writeInt32LE(embedding.buckets[i]!, i * RECORD_BYTES);
        buf.writeFloatLE(embedding.values[i]!, i * RECORD_BYTES + 4);
    }
    return buf;
}

export function fromBuffer(buf: Buffer): Embedding {
    const count = Math.floor(buf.byteLength / RECORD_BYTES);
    const buckets = new Int32Array(count);
    const values = new Float32Array(count);
    for (let i = 0; i < count; i++) {
        buckets[i] = buf.readInt32LE(i * RECORD_BYTES);
        values[i] = buf.readFloatLE(i * RECORD_BYTES + 4);
    }
    return { buckets, values };
}

export { HASH_SPACE };

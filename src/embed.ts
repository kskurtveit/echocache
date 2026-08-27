/**
 * Local, dependency-free text embedding.
 *
 * This is deliberately not a neural embedding model: pulling one in would mean a
 * multi-hundred-MB download and real compute cost on every cache write, which
 * defeats the point of a *cache*. Instead we use the classic feature-hashing
 * ("hashing trick") bag-of-words vector, which is cheap, deterministic, offline,
 * and good enough to cluster near-duplicate / topically-related prompts for the
 * graph layer. It is not a substitute for a real semantic embedding model if you
 * need high-recall similarity search.
 */

const DIMENSIONS = 256;

function fnv1a(str: string): number {
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}

function tokenize(text: string): string[] {
    return text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(tok => tok.length > 1);
}

/** Feature-hashed, L2-normalized bag-of-words vector. */
export function embed(text: string): Float32Array {
    const vec = new Float32Array(DIMENSIONS);
    for (const token of tokenize(text)) {
        const h = fnv1a(token);
        const bucket = h % DIMENSIONS;
        const sign = h & 0x1 ? 1 : -1; // signed hashing reduces collision bias
        vec[bucket] = vec[bucket]! + sign;
    }
    let norm = 0;
    for (let i = 0; i < DIMENSIONS; i++) norm += vec[i]! * vec[i]!;
    norm = Math.sqrt(norm);
    if (norm > 0) {
        for (let i = 0; i < DIMENSIONS; i++) vec[i] = vec[i]! / norm;
    }
    return vec;
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
    let dot = 0;
    for (let i = 0; i < DIMENSIONS; i++) dot += a[i]! * b[i]!;
    return dot; // both vectors are already unit-normalized
}

export function toBuffer(vec: Float32Array): Buffer {
    return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

export function fromBuffer(buf: Buffer): Float32Array {
    // A Float32Array view requires a 4-byte-aligned offset. SQLite BLOBs come back aligned in
    // practice, but a pooled Buffer need not be — copy rather than throw in that case.
    if (buf.byteOffset % Float32Array.BYTES_PER_ELEMENT !== 0) {
        return new Float32Array(
            buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
        );
    }
    return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / Float32Array.BYTES_PER_ELEMENT);
}

export { DIMENSIONS };

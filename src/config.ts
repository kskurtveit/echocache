import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Config {
    dbPath: string;
    /** Hard ceiling on retained entries; the least-recently-used are evicted past it. */
    maxEntries: number;
    /** Hard ceiling on total retained response bytes. */
    maxBytes: number;
    /** Default freshness lifetime when a caller doesn't specify one. */
    defaultTtlSeconds: number;
    /** Cosine-similarity floor for auto-linking a new entry to existing ones. */
    similarityThreshold: number;
    /** How many recent entries a new write is compared against when auto-linking. */
    linkCandidatePool: number;
    /** 64-hex-character AES-256 key enabling at-rest encryption; undefined stores cleartext. */
    encryptionKeyHex: string | undefined;
}

function intFromEnv(name: string, fallback: number, min = 0): number {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === '') return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < min) {
        // "at least ${min}" rather than "positive"/"non-negative": the check is `< min`, and a
        // rejected 0.5 against a minimum of 1 *is* positive — the looser wording contradicts
        // itself on exactly the values a caller is most likely to mistype.
        throw new Error(`${name} must be a number of at least ${min}, got: ${raw}`);
    }
    return Math.floor(parsed);
}

function floatFromEnv(name: string, fallback: number, min: number, max: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === '') return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
        throw new Error(`${name} must be a number between ${min} and ${max}, got: ${raw}`);
    }
    return parsed;
}

export function loadConfig(): Config {
    return {
        dbPath: process.env.NOWHEREMAN_DB_PATH ?? join(homedir(), '.nowhereman', 'cache.db'),
        maxEntries: intFromEnv('NOWHEREMAN_MAX_ENTRIES', 10_000),
        maxBytes: intFromEnv('NOWHEREMAN_MAX_BYTES', 256 * 1024 * 1024),
        defaultTtlSeconds: intFromEnv('NOWHEREMAN_DEFAULT_TTL_SECONDS', 60 * 60 * 24),
        similarityThreshold: floatFromEnv('NOWHEREMAN_SIMILARITY_THRESHOLD', 0.25, 0, 1),
        linkCandidatePool: intFromEnv('NOWHEREMAN_LINK_CANDIDATE_POOL', 500, 1),
        encryptionKeyHex: process.env.NOWHEREMAN_ENCRYPTION_KEY?.trim() || undefined
    };
}

export const DEFAULT_CONFIG: Config = {
    dbPath: join(homedir(), '.nowhereman', 'cache.db'),
    maxEntries: 10_000,
    maxBytes: 256 * 1024 * 1024,
    defaultTtlSeconds: 60 * 60 * 24,
    similarityThreshold: 0.25,
    linkCandidatePool: 500,
    encryptionKeyHex: undefined
};

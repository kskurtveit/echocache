import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Optional at-rest encryption for cached text.
 *
 * Threat model: the cache DB is a plain file. Without this, anything an agent caches — file
 * contents, API responses — sits in cleartext on disk and in every backup or disk image that
 * includes it. Enabling a key encrypts the two columns that hold caller content (`prompt` and
 * `response`) with AES-256-GCM under a fresh random IV per value.
 *
 * What this does NOT protect against: an attacker who can read the key (it comes from the
 * environment of the same machine) or who can read process memory. It protects data at rest,
 * not a live compromised host.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export class Cipher {
    private constructor(private readonly key: Buffer) {}

    /**
     * Parse a key from its environment representation: 64 hex characters (32 bytes). Anything
     * shorter is rejected rather than stretched — a short passphrase silently accepted would
     * imply strength the data does not have.
     */
    static fromHex(hex: string): Cipher {
        const trimmed = hex.trim();
        if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) {
            throw new Error(
                'NOWHEREMAN_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes). ' +
                    "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
            );
        }
        return new Cipher(Buffer.from(trimmed, 'hex'));
    }

    static generateKeyHex(): string {
        return randomBytes(KEY_BYTES).toString('hex');
    }

    /** Returns iv || tag || ciphertext, base64-encoded. */
    encrypt(plaintext: string): string {
        const iv = randomBytes(IV_BYTES);
        const cipher = createCipheriv(ALGORITHM, this.key, iv);
        const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
        return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
    }

    decrypt(encoded: string): string {
        const raw = Buffer.from(encoded, 'base64');
        if (raw.length < IV_BYTES + TAG_BYTES) {
            throw new Error('cached value is too short to be a valid encrypted record');
        }
        const iv = raw.subarray(0, IV_BYTES);
        const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
        const body = raw.subarray(IV_BYTES + TAG_BYTES);
        const decipher = createDecipheriv(ALGORITHM, this.key, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
    }

    /**
     * Keyed digest for the cache key. With a plain hash, anyone holding the DB could confirm a
     * guessed prompt by hashing it; keying the digest removes that oracle.
     */
    digest(payload: string): string {
        return createHmac('sha256', this.key).update(payload).digest('hex');
    }

    /**
     * Constant-time check that a stored verifier was produced by this key.
     *
     * `Buffer.from(str, 'hex')` never throws in Node — malformed input silently truncates at the
     * first invalid character — so the length check is what actually rejects a garbage or
     * corrupted `verifier`, not exception handling. A truncated-but-coincidentally-32-byte
     * forgery would still fail `timingSafeEqual`, since it can't have hashed correctly without
     * the key.
     */
    matchesVerifier(verifier: string): boolean {
        const expected = Buffer.from(this.digest('nowhereman-key-check'), 'hex');
        const actual = Buffer.from(verifier, 'hex');
        return expected.length === actual.length && timingSafeEqual(expected, actual);
    }

    makeVerifier(): string {
        return this.digest('nowhereman-key-check');
    }
}

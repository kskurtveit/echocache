import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { openDb } from './db.js';
import { CacheStore } from './store.js';

/**
 * Retrieval quality against realistic content: long documents, short queries, and the shipped
 * defaults. The rest of the suite pins mechanics; this file pins whether the thing actually
 * finds the right entry when nobody hand-tunes a threshold for it.
 */

let dir: string;
let db: Database.Database;

/** No config overrides — every test here runs at the defaults a real caller gets. */
function newStore() {
    return new CacheStore(db);
}

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nowhereman-retrieval-'));
    db = openDb(join(dir, 'cache.db'));
});

afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
});

const POOLING = `
Connection pooling for Postgres exists because opening a new backend process for every
request is expensive. The database forks a process per connection, and once you are past a
few hundred of them the machine spends more of its time on context switching than on
answering queries. A pooler sits between the application and the server and hands out a
small number of long lived connections to a much larger number of clients. There are three
pooling modes to choose between. Session mode assigns a server connection for the whole
duration of a client session, which is the safest option but gives you the least reuse.
Transaction mode hands the server connection back to the pool at the end of every
transaction, which is what most applications should be using. Statement mode returns it
after every single statement and will break anything that relies on a multi statement
transaction. The thing that surprises people is that prepared statements and session level
settings do not survive transaction mode, because the next transaction may well land on a
different backend. If the application sets a search path once at startup and expects it to
stick, it will not.
`;

const INGRESS = `
Terminating TLS at the ingress controller is the usual arrangement for a cluster, because
it keeps certificate handling in one place instead of spreading it across every service.
The controller holds the private key and the certificate chain, accepts the encrypted
connection from outside, and forwards plain traffic inside the cluster. Certificates are
stored as secrets and referenced by name from the ingress resource. Getting one issued
automatically is a matter of running an issuer in the cluster and annotating the resource
so the controller knows which issuer to ask. The renewal loop watches expiry dates and
requests a replacement well before the old certificate lapses, then updates the secret in
place. Where this goes wrong is usually the challenge step. A HTTP challenge needs the
well known path to be reachable from outside, and if a catch all rule or an authentication
filter sits in front of it the challenge fails without a clear message. A DNS challenge
avoids that entirely but needs credentials for the DNS provider.
`;

const SOURDOUGH = `
A sourdough starter is a stable culture of wild yeast and lactic acid bacteria living in a
mixture of flour and water. You build one by mixing the two and waiting, discarding part of
it and feeding the rest every day until the rise becomes predictable. The discard step is
what people find wasteful, but without it the acidity climbs until the yeast can no longer
raise the dough. Temperature matters more than any other variable. A culture kept warm
ferments quickly and tastes sharper because the bacteria outpace the yeast, while a cooler
one works slowly and tastes milder. Once the starter reliably doubles within a few hours of
being fed it is strong enough to raise a loaf. The bulk rise is where the structure of the
finished bread is actually decided, not the final proof, and folding the dough at intervals
during that rise builds strength without kneading it.
`;

const REACT_STATE = `
Deciding where a piece of state should live is most of the work in a component tree. The
rule that holds up is to keep it as close to the place it is used as possible and only lift
it higher when two siblings genuinely need to agree on it. Lifting everything to the top
turns the root into a bottleneck where every change redraws the whole tree. Reaching for a
global store on the first day of a project usually creates more indirection than it removes,
because most values turn out to be local after all. Server data is a different category
entirely and should not be copied into component state, since doing so leaves you
maintaining a second copy that drifts out of date and needs manual invalidation. A cache
built for that job handles the refetching and the staleness rules for you. Derived values
are the other common mistake: computing them during render is almost always better than
storing them and keeping them in sync.
`;

function seed(store: CacheStore) {
    store.set({ model: 'doc', prompt: 'postgres connection pooling', response: POOLING });
    store.set({ model: 'doc', prompt: 'kubernetes ingress tls', response: INGRESS });
    store.set({ model: 'doc', prompt: 'sourdough starter', response: SOURDOUGH });
    store.set({ model: 'doc', prompt: 'react state management', response: REACT_STATE });
}

describe('semantic query at shipped defaults', () => {
    test('a short natural-language query ranks the document it describes first', () => {
        const store = newStore();
        seed(store);

        const matches = store.query('how do I get TLS certificates issued for my ingress');

        assert.ok(matches.length > 0, 'expected the query to return at least one match');
        assert.equal(matches[0]!.prompt, 'kubernetes ingress tls');
    });

    test('a long document that only mentions the query terms in passing does not outrank the one about them', () => {
        const store = newStore();
        seed(store);
        // Long, and it does touch certificates and ingress — but in passing, the way a big
        // source file incidentally contains a word the query is actually asking about.
        store.set({
            model: 'doc',
            prompt: 'sprawling release notes',
            response: [
                POOLING,
                'A certificate was rotated on the ingress this quarter without incident.',
                SOURDOUGH,
                REACT_STATE,
                'The TLS library was upgraded to a newer patch release.',
                POOLING,
                REACT_STATE
            ].join('\n')
        });

        const matches = store.query('how do I get TLS certificates issued for my ingress');

        assert.ok(matches.length > 0, 'expected the query to return at least one match');
        assert.equal(matches[0]!.prompt, 'kubernetes ingress tls');
    });
});

describe('auto-linking at shipped defaults', () => {
    const POOL_LIMITS = `
        Sizing the pool is a matter of how many server connections the database can actually
        support, not how many clients you expect. Once the pool is larger than the number of
        cores the server can keep busy, adding connections makes every transaction slower
        rather than faster. Start from the database's own connection limit, leave headroom for
        administrative sessions, and divide what remains across the application instances that
        share the pooler.
    `;

    test('two entries on the same subject link without being near-duplicates', () => {
        const store = newStore();
        store.set({ model: 'doc', prompt: 'postgres connection pooling', response: POOLING });
        const second = store.set({ model: 'doc', prompt: 'sizing the pool', response: POOL_LIMITS });

        assert.ok(second.linkedTo > 0, 'expected two documents about connection pooling to link');
    });

    test('entries on unrelated subjects stay unlinked', () => {
        const store = newStore();
        store.set({ model: 'doc', prompt: 'postgres connection pooling', response: POOLING });
        const second = store.set({ model: 'doc', prompt: 'sourdough starter', response: SOURDOUGH });

        assert.equal(second.linkedTo, 0);
    });
});

describe('queries that match nothing', () => {
    test('a query sharing no vocabulary with any entry returns nothing at the default floor', () => {
        const store = newStore();
        seed(store);

        // A large entry with a wide vocabulary — a big source file, a long transcript. It fills
        // a large share of the hash space, so an unrelated query's buckets are near-certain to
        // collide with something it holds.
        const wideVocabulary = Array.from({ length: 900 }, (_, i) => `identifier${i} symbol${i}`).join(' ');
        store.set({ model: 'doc', prompt: 'large mixed entry', response: wideVocabulary });

        // None of these words appear in any seeded document. Feature hashing still lands them
        // in buckets other entries occupy, so without a magnitude check collision noise alone
        // can score a long document near 1.
        const matches = store.query('parliamentary procedure quorum adjournment motions');

        assert.deepEqual(
            matches.map(m => m.prompt),
            [],
            `expected no matches, got ${matches.map(m => `${m.prompt}@${m.similarity.toFixed(2)}`).join(', ')}`
        );
    });
});

describe('code retrieval', () => {
    const CODE = `
        export function registerTool(name: string, handler: ToolHandler): void {
            const inputSchema = buildInputSchema(name);
            this.handlers.set(name, { handler, inputSchema });
        }
    `;
    const PROSE = `
        The registration desk opens at eight in the morning and closes once the last
        delegate has collected a badge. Handlers are on hand throughout to answer any
        question about the schedule, and the desk keeps a small supply of spare lanyards.
    `;

    test('finds an identifier by the separate words in its camelCase name', () => {
        const store = newStore();
        store.set({ model: 'code', prompt: 'server.ts', response: CODE });
        store.set({ model: 'doc', prompt: 'conference logistics', response: PROSE });

        const matches = store.query('register tool input schema');

        assert.ok(matches.length > 0, 'expected the query to return at least one match');
        assert.equal(matches[0]!.prompt, 'server.ts');
    });
});

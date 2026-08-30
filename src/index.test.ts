import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { shutdown } from './index.js';

/**
 * index.ts guards its own `main()` call behind an entrypoint check specifically so this file can
 * import it without launching the real server (loadConfig/openDb/process.exit and friends).
 */

describe('shutdown', () => {
    test('closes the transport handle before the database', async () => {
        const order: string[] = [];
        const handle = { close: async () => void order.push('handle') };
        const db = { close: () => void order.push('db') };

        await shutdown(handle, db);

        assert.deepEqual(order, ['handle', 'db']);
    });

    test('still closes the database even if the transport handle fails to close', async () => {
        let dbClosed = false;
        const handle = { close: async () => { throw new Error('transport already gone'); } };
        const db = { close: () => void (dbClosed = true) };

        await shutdown(handle, db);

        assert.equal(dbClosed, true);
    });

    test('does not throw if the database is already closed', async () => {
        const handle = { close: async () => {} };
        const db = {
            close: () => {
                throw new Error('The database connection is not open');
            }
        };

        await assert.doesNotReject(shutdown(handle, db));
    });
});

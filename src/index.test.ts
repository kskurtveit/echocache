import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isMainModule, shutdown } from './index.js';

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

describe('isMainModule', () => {
    let dir: string;

    const setup = (): { real: string; link: string } => {
        dir = mkdtempSync(join(tmpdir(), 'echocache-entrypoint-'));
        const real = join(dir, 'index.js');
        const link = join(dir, 'cli-link');
        writeFileSync(real, '// stand-in for dist/index.js\n');
        symlinkSync(real, link);
        return { real, link };
    };

    test('is true when node was pointed straight at this module', () => {
        const { real } = setup();
        assert.equal(isMainModule(real, pathToFileURL(real).href), true);
        rmSync(dir, { recursive: true, force: true });
    });

    test('is true when invoked through a symlink, as every npm-installed bin is', () => {
        // npm links a `bin` as node_modules/.bin/echocache -> ../echocache/dist/index.js, so
        // argv[1] is the symlink while import.meta.url is the real file. Comparing the two raw
        // strings is false, main() never runs, and the server exits 0 having done nothing --
        // which is how `npx echocache` and every MCP host registration would invoke it. Caught
        // by smoke-testing the packed tarball, never by running src/index.ts directly.
        const { real, link } = setup();
        assert.equal(isMainModule(link, pathToFileURL(real).href), true);
        rmSync(dir, { recursive: true, force: true });
    });

    test('is false when some other script is the entrypoint', () => {
        const { real } = setup();
        const other = join(dir, 'other.js');
        writeFileSync(other, '// a different entrypoint\n');
        assert.equal(isMainModule(other, pathToFileURL(real).href), false);
        rmSync(dir, { recursive: true, force: true });
    });

    test('is false when there is no script path at all, as under `node -e`', () => {
        const { real } = setup();
        assert.equal(isMainModule(undefined, pathToFileURL(real).href), false);
        rmSync(dir, { recursive: true, force: true });
    });

    test('does not throw when the invoked path no longer exists', () => {
        const { real } = setup();
        const gone = join(dir, 'deleted.js');
        assert.equal(isMainModule(gone, pathToFileURL(real).href), false);
        rmSync(dir, { recursive: true, force: true });
    });
});

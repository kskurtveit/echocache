#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { serveStdio, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createServer, validateConfig } from './server.js';

/**
 * Closes the transport before the database, matching the SDK's own recommended shutdown order.
 * A transport that fails to close cleanly must not block the database from closing — dropping
 * stdin/stdout is harmless on process exit either way.
 */
export async function shutdown(
    handle: Pick<StdioServerHandle, 'close'>,
    db: { close(): unknown }
): Promise<void> {
    try {
        await handle.close();
    } catch {
        // Transport already closing, or failed to close cleanly — the database still has to close.
    }
    try {
        db.close();
    } catch {
        // Already closed or never opened — nothing useful to do while exiting.
    }
}

function main(): void {
    let config;
    try {
        config = loadConfig();
    } catch (err) {
        console.error(`[echocache] invalid configuration: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
    }

    let db;
    try {
        db = openDb(config.dbPath);
    } catch (err) {
        console.error(
            `[echocache] could not open cache database at ${config.dbPath}: ` +
                `${err instanceof Error ? err.message : String(err)}`
        );
        process.exit(1);
    }

    // Run the same checks a real connection would trigger — cipher parsing, key/database match,
    // embedding migration — up front, so a bad key or mismatch fails loudly here rather than on
    // the first tool call. validateConfig() does this without building a full McpServer, unlike
    // calling createServer() twice (once to validate, once for real inside the stdio factory).
    try {
        validateConfig(db, config);
    } catch (err) {
        console.error(`[echocache] ${err instanceof Error ? err.message : String(err)}`);
        db.close();
        process.exit(1);
    }

    const handle = serveStdio(() => createServer(db, config), {
        // Out-of-band transport errors are reporting-only (never alter the wire), but going
        // silent on them would contradict this project's own rule that a failure must surface,
        // never disappear — see the `guard()` convention in server.ts.
        onerror: err => console.error(`[echocache] transport error: ${err.message}`)
    });

    const exit = () => {
        void shutdown(handle, db).then(() => process.exit(0));
    };
    process.on('SIGINT', exit);
    process.on('SIGTERM', exit);

    console.error(
        `[echocache] MCP cache server on stdio — db: ${config.dbPath}, ` +
            `max ${config.maxEntries} entries / ${Math.round(config.maxBytes / 1024 / 1024)}MB, ` +
            `encryption: ${config.encryptionKeyHex ? 'on' : 'off'}`
    );
}

// import.meta.main is the current Node idiom for this check, but it needs Node 24.2+; this
// project supports Node >=20 (CI tests 20 and 22), so compare the invoked script path instead —
// the version-compatible equivalent, and what lets this file be imported for testing without
// starting the real server.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main();
}

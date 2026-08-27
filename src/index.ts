#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createServer } from './server.js';

function main(): void {
    let config;
    try {
        config = loadConfig();
    } catch (err) {
        console.error(`[nowhereman] invalid configuration: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
    }

    let db;
    try {
        db = openDb(config.dbPath);
    } catch (err) {
        console.error(
            `[nowhereman] could not open cache database at ${config.dbPath}: ` +
                `${err instanceof Error ? err.message : String(err)}`
        );
        process.exit(1);
    }

    // Build the server once up front so a bad key or a key/database mismatch fails loudly here,
    // rather than surfacing as an error on the first tool call.
    try {
        createServer(db, config);
    } catch (err) {
        console.error(`[nowhereman] ${err instanceof Error ? err.message : String(err)}`);
        db.close();
        process.exit(1);
    }

    const shutdown = () => {
        try {
            db.close();
        } catch {
            // Already closed or never opened — nothing useful to do while exiting.
        }
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    void serveStdio(() => createServer(db, config));
    console.error(
        `[nowhereman] MCP cache server on stdio — db: ${config.dbPath}, ` +
            `max ${config.maxEntries} entries / ${Math.round(config.maxBytes / 1024 / 1024)}MB, ` +
            `encryption: ${config.encryptionKeyHex ? 'on' : 'off'}`
    );
}

main();

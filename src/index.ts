import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './db.js';
import { createServer } from './server.js';

const dbPath = process.env.NOWHEREMAN_DB_PATH ?? join(homedir(), '.nowhereman', 'cache.db');
const db = openDb(dbPath);

void serveStdio(() => createServer(db));
console.error(`nowhereman MCP cache server running on stdio (db: ${dbPath})`);

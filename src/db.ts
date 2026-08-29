import Database from 'better-sqlite3';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * The cache holds whatever agents put through it — file contents, API responses. Default umask
 * would leave it group/world-readable on a shared machine, so lock the directory and every file
 * SQLite creates down to the owner.
 */
function restrictPermissions(path: string): void {
    for (const file of [path, `${path}-wal`, `${path}-shm`]) {
        if (!existsSync(file)) continue;
        try {
            chmodSync(file, 0o600);
        } catch {
            // Best effort: a filesystem that rejects chmod (e.g. some mounts) is not fatal.
        }
    }
}

export function openDb(path: string): Database.Database {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const db = new Database(path);
    restrictPermissions(path);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL'); // safe durability tradeoff under WAL; avoids an fsync per write
    db.exec(`
        CREATE TABLE IF NOT EXISTS nodes (
            id                       TEXT PRIMARY KEY,
            key_hash                 TEXT UNIQUE NOT NULL,
            model                    TEXT NOT NULL,
            prompt                   TEXT NOT NULL,
            response                 TEXT NOT NULL,
            params_json              TEXT NOT NULL DEFAULT '{}',
            tags_json                TEXT NOT NULL DEFAULT '[]',
            embedding                BLOB NOT NULL,
            created_at               INTEGER NOT NULL,
            last_accessed_at         INTEGER NOT NULL,
            hit_count                INTEGER NOT NULL DEFAULT 0,
            ttl_seconds              INTEGER,
            stale_while_revalidate_s INTEGER NOT NULL DEFAULT 0,
            estimated_tokens         INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS edges (
            from_id  TEXT NOT NULL,
            to_id    TEXT NOT NULL,
            relation TEXT NOT NULL,
            weight   REAL NOT NULL DEFAULT 1.0,
            PRIMARY KEY (from_id, to_id, relation),
            FOREIGN KEY (from_id) REFERENCES nodes(id) ON DELETE CASCADE,
            FOREIGN KEY (to_id) REFERENCES nodes(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS stats (
            key   TEXT PRIMARY KEY,
            value INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS meta (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS doc_freq (
            bucket INTEGER PRIMARY KEY,
            count  INTEGER NOT NULL DEFAULT 0
        );

        CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_id);
        CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_id);
    `);
    db.pragma('foreign_keys = ON');
    restrictPermissions(path); // WAL/SHM only exist once SQLite has written
    return db;
}

export function getMeta(db: Database.Database, key: string): string | null {
    const row = db.prepare<[string], { value: string }>('SELECT value FROM meta WHERE key = ?').get(key);
    return row?.value ?? null;
}

export function setMeta(db: Database.Database, key: string, value: string): void {
    db.prepare(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(key, value);
}

export function bump(db: Database.Database, key: string, by = 1): void {
    db.prepare(
        `INSERT INTO stats (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = value + excluded.value`
    ).run(key, by);
}

export function getStat(db: Database.Database, key: string): number {
    const row = db.prepare<[string], { value: number }>('SELECT value FROM stats WHERE key = ?').get(key);
    return row?.value ?? 0;
}

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDb(path: string): Database.Database {
    mkdirSync(dirname(path), { recursive: true });
    const db = new Database(path);
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

        CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_id);
        CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_id);
    `);
    db.pragma('foreign_keys = ON');
    return db;
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

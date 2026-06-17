import { DatabaseSync } from 'node:sqlite';
import type { SQLOutputValue } from 'node:sqlite';

/** Coerce a raw SQLite cell to a string. */
function asString(value: SQLOutputValue | undefined): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  return String(value);
}

/** A memory entry returned to callers (value parsed from JSON when possible). */
export interface MemoryEntry {
  key: string;
  value: unknown;
  app_id: string;
  created_at: string;
  updated_at: string;
}

/** Result of writeMemory(). */
export interface WriteMemoryResult {
  user_id: string;
  key: string;
  value: string;
  app_id: string;
  updated_at: string;
}

/** A key listing row returned by listMemories(). */
export interface MemoryKeyEntry {
  key: string;
  updated_at: string;
}

/** Result of a delete/clear operation. */
export interface DeleteResult {
  deletedCount: number | bigint;
}

/**
 * SQLite-backed MemoryStore implementation
 *
 * Uses Node.js 22.5+ built-in sqlite module for zero-dependency memory storage.
 * Provides the same interface as the MongoMemoryStore for interchangeable use.
 */
export class SQLiteMemoryStore {
  db: DatabaseSync | null;

  constructor() {
    this.db = null;
  }

  /**
   * Initialize SQLite memory store
   *
   * @param dbPath - Path to SQLite database file
   */
  async init(dbPath: string): Promise<void> {
    this.db = new DatabaseSync(dbPath);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        app_id TEXT DEFAULT 'agent',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(user_id, key)
      );

      CREATE INDEX IF NOT EXISTS idx_memories_user_key ON memories(user_id, key);
    `);

    console.log('[memory] SQLiteMemoryStore initialized');
  }

  /**
   * Write or update a memory entry
   *
   * @param userId - User identifier
   * @param key - Memory key
   * @param value - Value to store (will be JSON-stringified if object)
   * @param appId - Source application
   * @returns Created/updated memory object
   */
  async writeMemory(
    userId: string,
    key: string,
    value: unknown,
    appId = 'agent',
  ): Promise<WriteMemoryResult> {
    if (!this.db) throw new Error('MemoryStore not initialized. Call init() first.');

    const now = new Date().toISOString();
    const valueStr = typeof value === 'object' ? JSON.stringify(value) : String(value);

    const stmt = this.db.prepare(`
      INSERT INTO memories (user_id, key, value, app_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, key) DO UPDATE SET
        value = excluded.value,
        app_id = excluded.app_id,
        updated_at = excluded.updated_at
    `);

    stmt.run(userId, key, valueStr, appId, now, now);

    return { user_id: userId, key, value: valueStr, app_id: appId, updated_at: now };
  }

  /**
   * Read a specific memory by key
   *
   * @param userId - User identifier
   * @param key - Memory key
   * @returns Memory object or null if not found
   */
  async readMemory(userId: string, key: string): Promise<MemoryEntry | null> {
    if (!this.db) throw new Error('MemoryStore not initialized. Call init() first.');

    const stmt = this.db.prepare('SELECT * FROM memories WHERE user_id = ? AND key = ?');
    const row = stmt.get(userId, key);

    if (!row) return null;

    return this._rowToEntry(row);
  }

  /**
   * Read memories matching a pattern
   *
   * Supports both regex patterns (e.g., ".*") and SQL LIKE wildcards (e.g., "%foo%").
   * For simple wildcard matching, use SQL LIKE syntax with %.
   *
   * @param userId - User identifier
   * @param pattern - Pattern to match keys (regex or SQL LIKE)
   * @returns Array of matching memory objects
   */
  async readMemoryPattern(userId: string, pattern: string): Promise<MemoryEntry[]> {
    if (!this.db) throw new Error('MemoryStore not initialized. Call init() first.');

    // If pattern uses SQL LIKE syntax (contains %), use SQL directly
    if (pattern.includes('%')) {
      const stmt = this.db.prepare(`
        SELECT * FROM memories WHERE user_id = ? AND key LIKE ? ORDER BY updated_at DESC
      `);
      const rows = stmt.all(userId, pattern);
      return rows.map((row) => this._rowToEntry(row));
    }

    // Otherwise, treat as regex pattern
    const stmt = this.db.prepare(`
      SELECT * FROM memories WHERE user_id = ? ORDER BY updated_at DESC
    `);
    const rows = stmt.all(userId);
    const regex = new RegExp(pattern);

    return rows
      .filter((row) => regex.test(asString(row.key)))
      .map((row) => this._rowToEntry(row));
  }

  /**
   * Delete a memory by key
   *
   * @param userId - User identifier
   * @param key - Memory key to delete
   * @returns Result with deletedCount
   */
  async deleteMemory(userId: string, key: string): Promise<DeleteResult> {
    if (!this.db) throw new Error('MemoryStore not initialized. Call init() first.');

    const stmt = this.db.prepare('DELETE FROM memories WHERE user_id = ? AND key = ?');
    const result = stmt.run(userId, key);

    return { deletedCount: result.changes };
  }

  /**
   * List all memory keys for a user
   *
   * @param userId - User identifier
   * @returns Array of { key, updated_at } objects
   */
  async listMemories(userId: string): Promise<MemoryKeyEntry[]> {
    if (!this.db) throw new Error('MemoryStore not initialized. Call init() first.');

    const stmt = this.db.prepare(`
      SELECT key, updated_at FROM memories WHERE user_id = ? ORDER BY updated_at DESC
    `);

    const rows = stmt.all(userId);
    return rows.map((row) => ({
      key: asString(row.key),
      updated_at: asString(row.updated_at),
    }));
  }

  /**
   * Get all memories for a user with full content
   *
   * @param userId - User identifier
   * @returns Array of full memory objects
   */
  async getAllMemories(userId: string): Promise<MemoryEntry[]> {
    if (!this.db) throw new Error('MemoryStore not initialized. Call init() first.');

    const stmt = this.db.prepare(`
      SELECT * FROM memories WHERE user_id = ? ORDER BY updated_at DESC
    `);
    const rows = stmt.all(userId);

    return rows.map((row) => this._rowToEntry(row));
  }

  /**
   * Delete all memories for a user
   *
   * @param userId - User identifier
   * @returns Result with deletedCount
   */
  async clearMemories(userId: string): Promise<DeleteResult> {
    if (!this.db) throw new Error('MemoryStore not initialized. Call init() first.');

    const stmt = this.db.prepare('DELETE FROM memories WHERE user_id = ?');
    const result = stmt.run(userId);

    return { deletedCount: result.changes };
  }

  /**
   * Convert a raw SQLite row to a memory entry with parsed value.
   *
   * @private
   */
  _rowToEntry(row: Record<string, SQLOutputValue>): MemoryEntry {
    return {
      key: asString(row.key),
      value: this._parseValue(asString(row.value)),
      app_id: asString(row.app_id),
      created_at: asString(row.created_at),
      updated_at: asString(row.updated_at),
    };
  }

  /**
   * Parse stored value back to object if it's JSON
   *
   * @private
   * @param value - Raw string value from database
   * @returns Parsed value
   */
  _parseValue(value: string): unknown {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }

  /**
   * Close the database connection and checkpoint WAL.
   */
  close(): void {
    if (this.db) {
      try {
        this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        this.db.close();
        this.db = null;
        console.log('[memory] SQLiteMemoryStore closed');
      } catch (err) {
        console.error('[memory] Error closing database:', err instanceof Error ? err.message : err);
      }
    }
  }
}

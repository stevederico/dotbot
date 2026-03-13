import { DatabaseSync } from 'node:sqlite';

/**
 * SQLite-backed MemoryStore implementation
 *
 * Uses Node.js 22.5+ built-in sqlite module for zero-dependency memory storage.
 * Provides the same interface as the MongoMemoryStore for interchangeable use.
 */
export class SQLiteMemoryStore {
  constructor() {
    this.db = null;
  }

  /**
   * Initialize SQLite memory store
   *
   * @param {string} dbPath - Path to SQLite database file
   */
  async init(dbPath) {
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
   * @param {string} userId - User identifier
   * @param {string} key - Memory key
   * @param {Object|string} value - Value to store (will be JSON-stringified if object)
   * @param {string} [appId='agent'] - Source application
   * @returns {Promise<Object>} Created/updated memory object
   */
  async writeMemory(userId, key, value, appId = 'agent') {
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
   * @param {string} userId - User identifier
   * @param {string} key - Memory key
   * @returns {Promise<Object|null>} Memory object or null if not found
   */
  async readMemory(userId, key) {
    if (!this.db) throw new Error('MemoryStore not initialized. Call init() first.');

    const stmt = this.db.prepare('SELECT * FROM memories WHERE user_id = ? AND key = ?');
    const row = stmt.get(userId, key);

    if (!row) return null;

    return {
      key: row.key,
      value: this._parseValue(row.value),
      app_id: row.app_id,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  /**
   * Read memories matching a pattern
   *
   * Supports both regex patterns (e.g., ".*") and SQL LIKE wildcards (e.g., "%foo%").
   * For simple wildcard matching, use SQL LIKE syntax with %.
   *
   * @param {string} userId - User identifier
   * @param {string} pattern - Pattern to match keys (regex or SQL LIKE)
   * @returns {Promise<Array>} Array of matching memory objects
   */
  async readMemoryPattern(userId, pattern) {
    if (!this.db) throw new Error('MemoryStore not initialized. Call init() first.');

    // If pattern uses SQL LIKE syntax (contains %), use SQL directly
    if (pattern.includes('%')) {
      const stmt = this.db.prepare(`
        SELECT * FROM memories WHERE user_id = ? AND key LIKE ? ORDER BY updated_at DESC
      `);
      const rows = stmt.all(userId, pattern);
      return rows.map(row => ({
        key: row.key,
        value: this._parseValue(row.value),
        app_id: row.app_id,
        created_at: row.created_at,
        updated_at: row.updated_at,
      }));
    }

    // Otherwise, treat as regex pattern
    const stmt = this.db.prepare(`
      SELECT * FROM memories WHERE user_id = ? ORDER BY updated_at DESC
    `);
    const rows = stmt.all(userId);
    const regex = new RegExp(pattern);

    return rows
      .filter(row => regex.test(row.key))
      .map(row => ({
        key: row.key,
        value: this._parseValue(row.value),
        app_id: row.app_id,
        created_at: row.created_at,
        updated_at: row.updated_at,
      }));
  }

  /**
   * Delete a memory by key
   *
   * @param {string} userId - User identifier
   * @param {string} key - Memory key to delete
   * @returns {Promise<Object>} Result with deletedCount
   */
  async deleteMemory(userId, key) {
    if (!this.db) throw new Error('MemoryStore not initialized. Call init() first.');

    const stmt = this.db.prepare('DELETE FROM memories WHERE user_id = ? AND key = ?');
    const result = stmt.run(userId, key);

    return { deletedCount: result.changes };
  }

  /**
   * List all memory keys for a user
   *
   * @param {string} userId - User identifier
   * @returns {Promise<Array>} Array of { key, updated_at } objects
   */
  async listMemories(userId) {
    if (!this.db) throw new Error('MemoryStore not initialized. Call init() first.');

    const stmt = this.db.prepare(`
      SELECT key, updated_at FROM memories WHERE user_id = ? ORDER BY updated_at DESC
    `);

    return stmt.all(userId);
  }

  /**
   * Get all memories for a user with full content
   *
   * @param {string} userId - User identifier
   * @returns {Promise<Array>} Array of full memory objects
   */
  async getAllMemories(userId) {
    if (!this.db) throw new Error('MemoryStore not initialized. Call init() first.');

    const stmt = this.db.prepare(`
      SELECT * FROM memories WHERE user_id = ? ORDER BY updated_at DESC
    `);
    const rows = stmt.all(userId);

    return rows.map(row => ({
      key: row.key,
      value: this._parseValue(row.value),
      app_id: row.app_id,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }));
  }

  /**
   * Delete all memories for a user
   *
   * @param {string} userId - User identifier
   * @returns {Promise<Object>} Result with deletedCount
   */
  async clearMemories(userId) {
    if (!this.db) throw new Error('MemoryStore not initialized. Call init() first.');

    const stmt = this.db.prepare('DELETE FROM memories WHERE user_id = ?');
    const result = stmt.run(userId);

    return { deletedCount: result.changes };
  }

  /**
   * Parse stored value back to object if it's JSON
   *
   * @private
   * @param {string} value - Raw string value from database
   * @returns {Object|string} Parsed value
   */
  _parseValue(value) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }

  /**
   * Close the database connection and checkpoint WAL.
   */
  close() {
    if (this.db) {
      try {
        this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        this.db.close();
        this.db = null;
        console.log('[memory] SQLiteMemoryStore closed');
      } catch (err) {
        console.error('[memory] Error closing database:', err.message);
      }
    }
  }
}

import crypto from 'crypto';
import { DatabaseSync } from 'node:sqlite';
import { TriggerStore } from './TriggerStore.js';

/**
 * SQLite-backed TriggerStore implementation
 *
 * Uses Node.js 22.5+ built-in sqlite module for zero-dependency trigger storage.
 * Dates stored as INTEGER (Unix ms timestamps), metadata as JSON TEXT.
 */
export class SQLiteTriggerStore extends TriggerStore {
  constructor() {
    super();
    this.db = null;
  }

  /**
   * Initialize SQLite trigger store
   *
   * @param {Object} config - Configuration object
   * @param {string} config.dbPath - Path to SQLite database file
   * @param {Object} [options={}] - Reserved for future use
   */
  async init({ dbPath }, options = {}) {
    this.db = new DatabaseSync(dbPath);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS triggers (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        prompt TEXT NOT NULL,
        cooldown_ms INTEGER DEFAULT 0,
        metadata TEXT,
        enabled INTEGER DEFAULT 1,
        last_fired_at INTEGER,
        fire_count INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_triggers_user_event ON triggers(user_id, event_type);
      CREATE INDEX IF NOT EXISTS idx_triggers_user_enabled ON triggers(user_id, enabled);
    `);

    console.log('[triggers] SQLiteTriggerStore initialized');
  }

  /**
   * Create an event trigger
   *
   * @param {Object} params
   * @param {string} params.userId - Owner user ID
   * @param {string} params.eventType - Event type to trigger on
   * @param {string} params.prompt - Prompt to inject when event fires
   * @param {number} [params.cooldownMs=0] - Cooldown period in milliseconds
   * @param {Object} [params.metadata={}] - Additional metadata
   * @param {boolean} [params.enabled=true] - Whether trigger is enabled
   * @returns {Promise<Object>} Created trigger document
   */
  async createTrigger({ userId, eventType, prompt, cooldownMs = 0, metadata = {}, enabled = true }) {
    if (!this.db) throw new Error('Triggers not initialized. Call init() first.');

    const now = Date.now();
    const doc = {
      id: crypto.randomUUID(),
      userId,
      eventType,
      prompt,
      cooldownMs,
      metadata,
      enabled,
      lastFiredAt: null,
      fireCount: 0,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    };

    const stmt = this.db.prepare(`
      INSERT INTO triggers (id, user_id, event_type, prompt, cooldown_ms, metadata, enabled, last_fired_at, fire_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      doc.id,
      userId,
      eventType,
      prompt,
      cooldownMs,
      Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null,
      enabled ? 1 : 0,
      null,
      0,
      now,
      now
    );

    return doc;
  }

  /**
   * List triggers for a user
   *
   * @param {string} userId - User ID
   * @param {Object} [filters={}] - Optional filters
   * @param {boolean} [filters.enabled] - Filter by enabled state
   * @param {string} [filters.eventType] - Filter by event type
   * @returns {Promise<Array>} Trigger list sorted by created_at DESC
   */
  async listTriggers(userId, filters = {}) {
    if (!this.db) throw new Error('Triggers not initialized. Call init() first.');

    let sql = 'SELECT * FROM triggers WHERE user_id = ?';
    const params = [userId];

    if (filters.enabled !== undefined) {
      sql += ' AND enabled = ?';
      params.push(filters.enabled ? 1 : 0);
    }
    if (filters.eventType) {
      sql += ' AND event_type = ?';
      params.push(filters.eventType);
    }

    sql += ' ORDER BY created_at DESC';

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params);

    return rows.map(row => this._rowToTrigger(row));
  }

  /**
   * Find enabled triggers matching userId and eventType, filtering out
   * those still within cooldown period
   *
   * @param {string} userId - User ID
   * @param {string} eventType - Event type to match
   * @param {Object} [metadata={}] - Event metadata for matching
   * @returns {Promise<Array>} Matching trigger documents
   */
  async findMatchingTriggers(userId, eventType, metadata = {}) {
    if (!this.db) throw new Error('Triggers not initialized. Call init() first.');

    const now = Date.now();

    const stmt = this.db.prepare(
      'SELECT * FROM triggers WHERE user_id = ? AND event_type = ? AND enabled = 1'
    );
    const rows = stmt.all(userId, eventType);
    const triggers = rows.map(row => this._rowToTrigger(row));

    // Filter by cooldown
    const activeTriggers = triggers.filter(trigger => {
      if (!trigger.cooldownMs) return true;
      if (!trigger.lastFiredAt) return true;
      const lastFiredTime = trigger.lastFiredAt.getTime();
      return (lastFiredTime + trigger.cooldownMs) <= now;
    });

    // Filter by metadata requirements
    const matchedTriggers = activeTriggers.filter(trigger => {
      if (!trigger.metadata || Object.keys(trigger.metadata).length === 0) {
        return true;
      }
      for (const [key, value] of Object.entries(trigger.metadata)) {
        if (metadata[key] !== value) return false;
      }
      return true;
    });

    return matchedTriggers;
  }

  /**
   * Toggle a trigger on/off
   *
   * @param {string} userId - User ID
   * @param {string} triggerId - Trigger ID
   * @param {boolean} enabled - Whether to enable or disable
   * @returns {Promise<Object>} Update result with changes count
   */
  async toggleTrigger(userId, triggerId, enabled) {
    if (!this.db) throw new Error('Triggers not initialized. Call init() first.');

    const stmt = this.db.prepare(
      'UPDATE triggers SET enabled = ?, updated_at = ? WHERE id = ? AND user_id = ?'
    );
    const result = stmt.run(enabled ? 1 : 0, Date.now(), triggerId, userId);
    return { changes: result.changes };
  }

  /**
   * Delete a trigger
   *
   * @param {string} userId - User ID
   * @param {string} triggerId - Trigger ID
   * @returns {Promise<Object>} Delete result with deletedCount
   */
  async deleteTrigger(userId, triggerId) {
    if (!this.db) throw new Error('Triggers not initialized. Call init() first.');

    const stmt = this.db.prepare(
      'DELETE FROM triggers WHERE id = ? AND user_id = ?'
    );
    const result = stmt.run(triggerId, userId);
    return { deletedCount: result.changes };
  }

  /**
   * Record that a trigger has fired
   *
   * @param {string} triggerId - Trigger ID
   */
  async markTriggerFired(triggerId) {
    if (!this.db) throw new Error('Triggers not initialized. Call init() first.');

    const stmt = this.db.prepare(
      'UPDATE triggers SET last_fired_at = ?, fire_count = fire_count + 1 WHERE id = ?'
    );
    stmt.run(Date.now(), triggerId);
  }

  /**
   * Convert SQLite row to trigger object
   *
   * @private
   * @param {Object} row - Raw SQLite row
   * @returns {Object} Trigger object with parsed dates and metadata
   */
  _rowToTrigger(row) {
    return {
      id: row.id,
      userId: row.user_id,
      eventType: row.event_type,
      prompt: row.prompt,
      cooldownMs: row.cooldown_ms,
      metadata: row.metadata ? JSON.parse(row.metadata) : {},
      enabled: row.enabled === 1,
      lastFiredAt: row.last_fired_at ? new Date(row.last_fired_at) : null,
      fireCount: row.fire_count,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
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
        console.log('[triggers] SQLiteTriggerStore closed');
      } catch (err) {
        console.error('[triggers] Error closing database:', err.message);
      }
    }
  }
}

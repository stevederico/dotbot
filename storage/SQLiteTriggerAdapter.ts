import crypto from 'crypto';
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue, SQLOutputValue } from 'node:sqlite';
import { TriggerStore } from './TriggerStore.js';
import type { TriggerDocument, TriggerListFilters } from './TriggerStore.js';
import type { JsonObject, JsonValue } from '../types.js';

/** Coerce a raw SQLite cell to a string. */
function asString(value: SQLOutputValue | undefined): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  return String(value);
}

/** Coerce a raw SQLite cell to a number. */
function asNumber(value: SQLOutputValue | undefined): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') return Number(value);
  return 0;
}

/** Coerce a raw SQLite cell to a number or null. */
function asNumberOrNull(value: SQLOutputValue | undefined): number | null {
  if (value === null || value === undefined) return null;
  return asNumber(value);
}

/** Recursively coerce an unknown value into a JsonValue. */
function toJsonValue(value: unknown): JsonValue {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => toJsonValue(item));
  }
  if (typeof value === 'object') {
    const out: JsonObject = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = toJsonValue(val);
    }
    return out;
  }
  return null;
}

/** Parse a JSON string into a JsonObject, returning {} on failure or non-object. */
function parseJsonObject(text: string): JsonObject {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const out: JsonObject = {};
      for (const [key, val] of Object.entries(parsed)) {
        out[key] = toJsonValue(val);
      }
      return out;
    }
  } catch {
    // fall through
  }
  return {};
}

/** Parameters for createTrigger(). */
export interface CreateTriggerParams {
  userId: string;
  eventType: string;
  prompt: string;
  cooldownMs?: number;
  metadata?: JsonObject;
  enabled?: boolean;
}

/** A trigger document with JS-native types. */
export type TriggerDoc = TriggerDocument;

/** Optional filters for listTriggers(). */
export type TriggerFilters = TriggerListFilters;

/**
 * SQLite-backed TriggerStore implementation
 *
 * Uses Node.js 22.5+ built-in sqlite module for zero-dependency trigger storage.
 * Dates stored as INTEGER (Unix ms timestamps), metadata as JSON TEXT.
 */
export class SQLiteTriggerStore extends TriggerStore {
  db: DatabaseSync | null;

  constructor() {
    super();
    this.db = null;
  }

  /**
   * Initialize SQLite trigger store
   *
   * @param dbPath - Path to SQLite database file
   * @param options - Reserved for future use
   */
  async init(dbPath: string, options: JsonObject = {}): Promise<void> {
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
   * @returns Created trigger document
   */
  async createTrigger({ userId, eventType, prompt, cooldownMs = 0, metadata = {}, enabled = true }: CreateTriggerParams): Promise<TriggerDoc> {
    if (!this.db) throw new Error('Triggers not initialized. Call init() first.');

    const now = Date.now();
    const doc: TriggerDoc = {
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
   * @param userId - User ID
   * @param filters - Optional filters
   * @returns Trigger list sorted by created_at DESC
   */
  async listTriggers(userId: string, filters: TriggerFilters = {}): Promise<TriggerDoc[]> {
    if (!this.db) throw new Error('Triggers not initialized. Call init() first.');

    let sql = 'SELECT * FROM triggers WHERE user_id = ?';
    const params: SQLInputValue[] = [userId];

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
   * @param userId - User ID
   * @param eventType - Event type to match
   * @param metadata - Event metadata for matching
   * @returns Matching trigger documents
   */
  async findMatchingTriggers(userId: string, eventType: string, metadata: JsonObject = {}): Promise<TriggerDoc[]> {
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
   * @param userId - User ID
   * @param triggerId - Trigger ID
   * @param enabled - Whether to enable or disable
   * @returns Update result with changes count
   */
  async toggleTrigger(userId: string, triggerId: string, enabled: boolean): Promise<{ changes: number | bigint }> {
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
   * @param userId - User ID
   * @param triggerId - Trigger ID
   * @returns Delete result with deletedCount
   */
  async deleteTrigger(userId: string, triggerId: string): Promise<{ deletedCount: number | bigint }> {
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
   * @param triggerId - Trigger ID
   */
  async markTriggerFired(triggerId: string): Promise<void> {
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
   */
  _rowToTrigger(row: Record<string, SQLOutputValue>): TriggerDoc {
    const lastFired = asNumberOrNull(row.last_fired_at);
    const metadataStr = row.metadata;
    return {
      id: asString(row.id),
      userId: asString(row.user_id),
      eventType: asString(row.event_type),
      prompt: asString(row.prompt),
      cooldownMs: asNumber(row.cooldown_ms),
      metadata: typeof metadataStr === 'string' ? parseJsonObject(metadataStr) : {},
      enabled: row.enabled === 1,
      lastFiredAt: lastFired !== null ? new Date(lastFired) : null,
      fireCount: asNumber(row.fire_count),
      createdAt: new Date(asNumber(row.created_at)),
      updatedAt: new Date(asNumber(row.updated_at)),
    };
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
        console.log('[triggers] SQLiteTriggerStore closed');
      } catch (err) {
        console.error('[triggers] Error closing database:', err instanceof Error ? err.message : err);
      }
    }
  }
}

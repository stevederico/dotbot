/// <reference types="node" />
import crypto from 'crypto';
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue, SQLOutputValue } from 'node:sqlite';
import { EventStore } from './EventStore.js';
import type {
  JsonObject,
  JsonValue,
  LogEventParams,
  EventQueryParams,
  EventSummaryParams,
  EventSummary,
  EventBreakdownPeriod,
  StoredEvent,
} from '../types.js';

/** Recursively coerce an unknown value into a JsonValue (drops non-JSON values). */
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

export type { EventSummary, EventBreakdownPeriod } from '../types.js';

/**
 * SQLite-backed EventStore implementation
 *
 * Uses Node.js 22.5+ built-in sqlite module for zero-dependency event storage.
 * Timestamps stored as INTEGER (Unix ms), data as JSON TEXT column.
 */
export class SQLiteEventStore extends EventStore {
  db: DatabaseSync | null;

  constructor() {
    super();
    this.db = null;
  }

  /**
   * Initialize SQLite event store
   *
   * @param dbPath - Path to SQLite database file
   */
  async init(dbPath: string): Promise<void> {
    this.db = new DatabaseSync(dbPath);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        type TEXT NOT NULL,
        data TEXT,
        timestamp INTEGER NOT NULL,
        created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
      );

      CREATE INDEX IF NOT EXISTS idx_events_user_type ON events(user_id, type);
      CREATE INDEX IF NOT EXISTS idx_events_user_timestamp ON events(user_id, timestamp);
    `);

    console.log('[events] SQLiteEventStore initialized');
  }

  /**
   * Log an event
   *
   * @returns Created event document
   */
  async logEvent({ userId, type, data = {}, timestamp }: LogEventParams): Promise<StoredEvent> {
    if (!this.db) throw new Error('Events not initialized. Call init() first.');

    const event: StoredEvent = {
      id: crypto.randomUUID(),
      userId,
      type,
      data,
      timestamp: timestamp || Date.now(),
    };

    const stmt = this.db.prepare(`
      INSERT INTO events (id, user_id, type, data, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `);

    stmt.run(
      event.id,
      event.userId,
      event.type,
      JSON.stringify(event.data),
      event.timestamp
    );

    return event;
  }

  /**
   * Query events with filters
   *
   * @returns Matching events sorted by timestamp desc
   */
  async query({ userId, type, startDate, endDate, limit = 100 }: EventQueryParams): Promise<StoredEvent[]> {
    if (!this.db) throw new Error('Events not initialized. Call init() first.');

    let sql = 'SELECT * FROM events WHERE user_id = ?';
    const params: SQLInputValue[] = [userId];

    if (type) {
      sql += ' AND type = ?';
      params.push(type);
    }

    if (startDate) {
      const startTs = new Date(startDate).getTime();
      sql += ' AND timestamp >= ?';
      params.push(startTs);
    }

    if (endDate) {
      // End of day for endDate
      const endTs = new Date(endDate).getTime() + 86400000 - 1;
      sql += ' AND timestamp <= ?';
      params.push(endTs);
    }

    sql += ' ORDER BY timestamp DESC LIMIT ?';
    params.push(limit);

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params);

    return rows.map(row => this._rowToEvent(row));
  }

  /**
   * Get aggregated usage statistics
   *
   * @returns Summary with total count and grouped breakdown
   */
  async summary({ userId, startDate, endDate, groupBy = 'type' }: EventSummaryParams): Promise<EventSummary> {
    if (!this.db) throw new Error('Events not initialized. Call init() first.');

    // Build WHERE clause
    let whereClause = 'WHERE user_id = ?';
    const params: SQLInputValue[] = [userId];

    if (startDate) {
      const startTs = new Date(startDate).getTime();
      whereClause += ' AND timestamp >= ?';
      params.push(startTs);
    }

    if (endDate) {
      const endTs = new Date(endDate).getTime() + 86400000 - 1;
      whereClause += ' AND timestamp <= ?';
      params.push(endTs);
    }

    // Total count
    const countStmt = this.db.prepare(`SELECT COUNT(*) as total FROM events ${whereClause}`);
    const countResult = countStmt.get(...params);
    const total = asNumber(countResult?.total);

    // Group by clause varies by groupBy parameter
    let groupByClause: string;
    let selectExpr: string;
    switch (groupBy) {
      case 'day':
        selectExpr = "date(timestamp / 1000, 'unixepoch') as period";
        groupByClause = "date(timestamp / 1000, 'unixepoch')";
        break;
      case 'week':
        selectExpr = "strftime('%Y-W%W', timestamp / 1000, 'unixepoch') as period";
        groupByClause = "strftime('%Y-W%W', timestamp / 1000, 'unixepoch')";
        break;
      case 'month':
        selectExpr = "strftime('%Y-%m', timestamp / 1000, 'unixepoch') as period";
        groupByClause = "strftime('%Y-%m', timestamp / 1000, 'unixepoch')";
        break;
      case 'type':
      default:
        selectExpr = 'type as period';
        groupByClause = 'type';
        break;
    }

    const groupStmt = this.db.prepare(`
      SELECT ${selectExpr}, COUNT(*) as count
      FROM events ${whereClause}
      GROUP BY ${groupByClause}
      ORDER BY count DESC
    `);
    const groups = groupStmt.all(...params);

    // Convert to object for type grouping, array for time-based grouping
    let breakdown: Record<string, number> | EventBreakdownPeriod[];
    if (groupBy === 'type') {
      const breakdownObj: Record<string, number> = {};
      for (const row of groups) {
        breakdownObj[asString(row.period)] = asNumber(row.count);
      }
      breakdown = breakdownObj;
    } else {
      breakdown = groups.map(row => ({
        period: asString(row.period),
        count: asNumber(row.count),
      }));
    }

    // Tool usage breakdown (if tool_call events exist)
    const toolStmt = this.db.prepare(`
      SELECT data FROM events ${whereClause} AND type = 'tool_call'
    `);
    const toolParams = [...params, 'tool_call'];
    // Rebuild params for tool query
    const toolWhereParams = [...params];

    const toolCountStmt = this.db.prepare(`
      SELECT data FROM events ${whereClause.replace('user_id = ?', 'user_id = ? AND type = ?')}
    `.replace('AND type = ?', ''));

    // Simpler approach: get all tool_call events and aggregate in JS
    const toolEventsStmt = this.db.prepare(`
      SELECT data FROM events WHERE user_id = ? AND type = 'tool_call'
      ${startDate ? 'AND timestamp >= ?' : ''}
      ${endDate ? 'AND timestamp <= ?' : ''}
    `);
    const toolEventParams: SQLInputValue[] = [userId];
    if (startDate) toolEventParams.push(new Date(startDate).getTime());
    if (endDate) toolEventParams.push(new Date(endDate).getTime() + 86400000 - 1);

    const toolEvents = toolEventsStmt.all(...toolEventParams);
    const toolCounts: Record<string, number> = {};
    for (const row of toolEvents) {
      try {
        const data: unknown = JSON.parse(asString(row.data));
        const toolName =
          typeof data === 'object' && data !== null && 'tool' in data && typeof data.tool === 'string'
            ? data.tool
            : 'unknown';
        toolCounts[toolName] = (toolCounts[toolName] || 0) + 1;
      } catch {
        // Skip malformed data
      }
    }

    return {
      total,
      breakdown,
      toolUsage: Object.keys(toolCounts).length > 0 ? toolCounts : undefined,
    };
  }

  /**
   * Delete events older than a given date
   *
   * @param userId - User ID
   * @param beforeDate - ISO date cutoff
   * @returns Delete result with count
   */
  async deleteOldEvents(userId: string, beforeDate: string): Promise<{ deletedCount: number }> {
    if (!this.db) throw new Error('Events not initialized. Call init() first.');

    const cutoffTs = new Date(beforeDate).getTime();
    const stmt = this.db.prepare('DELETE FROM events WHERE user_id = ? AND timestamp < ?');
    const result = stmt.run(userId, cutoffTs);

    return { deletedCount: Number(result.changes) };
  }

  /**
   * Convert SQLite row to event object
   *
   * @private
   */
  _rowToEvent(row: Record<string, SQLOutputValue>): StoredEvent {
    const data: JsonObject = parseJsonObject(asString(row.data));

    return {
      id: asString(row.id),
      userId: asString(row.user_id),
      type: asString(row.type),
      data,
      timestamp: asNumber(row.timestamp),
      createdAt: asNumber(row.created_at),
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
        console.log('[events] SQLiteEventStore closed');
      } catch (err) {
        console.error('[events] Error closing database:', err instanceof Error ? err.message : err);
      }
    }
  }
}

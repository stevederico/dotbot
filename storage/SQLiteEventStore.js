import crypto from 'crypto';
import { DatabaseSync } from 'node:sqlite';
import { EventStore } from './EventStore.js';

/**
 * SQLite-backed EventStore implementation
 *
 * Uses Node.js 22.5+ built-in sqlite module for zero-dependency event storage.
 * Timestamps stored as INTEGER (Unix ms), data as JSON TEXT column.
 */
export class SQLiteEventStore extends EventStore {
  constructor() {
    super();
    this.db = null;
  }

  /**
   * Initialize SQLite event store
   *
   * @param {Object} config - Configuration object
   * @param {string} config.dbPath - Path to SQLite database file
   */
  async init({ dbPath }) {
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
   * @param {Object} params
   * @param {string} params.userId - User ID
   * @param {string} params.type - Event type
   * @param {Object} [params.data={}] - Event-specific data
   * @param {number} [params.timestamp] - Unix ms timestamp (defaults to now)
   * @returns {Promise<Object>} Created event document
   */
  async logEvent({ userId, type, data = {}, timestamp }) {
    if (!this.db) throw new Error('Events not initialized. Call init() first.');

    const event = {
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
   * @param {Object} params
   * @param {string} params.userId - User ID
   * @param {string} [params.type] - Filter by event type
   * @param {string} [params.startDate] - ISO date start (inclusive)
   * @param {string} [params.endDate] - ISO date end (inclusive)
   * @param {number} [params.limit=100] - Max results
   * @returns {Promise<Array>} Matching events sorted by timestamp desc
   */
  async query({ userId, type, startDate, endDate, limit = 100 }) {
    if (!this.db) throw new Error('Events not initialized. Call init() first.');

    let sql = 'SELECT * FROM events WHERE user_id = ?';
    const params = [userId];

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
   * @param {Object} params
   * @param {string} params.userId - User ID
   * @param {string} [params.startDate] - ISO date start
   * @param {string} [params.endDate] - ISO date end
   * @param {string} [params.groupBy='type'] - Group by: type, day, week, month
   * @returns {Promise<Object>} Summary with total count and grouped breakdown
   */
  async summary({ userId, startDate, endDate, groupBy = 'type' }) {
    if (!this.db) throw new Error('Events not initialized. Call init() first.');

    // Build WHERE clause
    let whereClause = 'WHERE user_id = ?';
    const params = [userId];

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
    const total = countResult.total;

    // Group by clause varies by groupBy parameter
    let groupByClause, selectExpr;
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
    let breakdown;
    if (groupBy === 'type') {
      breakdown = {};
      for (const row of groups) {
        breakdown[row.period] = row.count;
      }
    } else {
      breakdown = groups.map(row => ({
        period: row.period,
        count: row.count,
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
    const toolEventParams = [userId];
    if (startDate) toolEventParams.push(new Date(startDate).getTime());
    if (endDate) toolEventParams.push(new Date(endDate).getTime() + 86400000 - 1);

    const toolEvents = toolEventsStmt.all(...toolEventParams);
    const toolCounts = {};
    for (const row of toolEvents) {
      try {
        const data = JSON.parse(row.data);
        const toolName = data.tool || 'unknown';
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
   * @param {string} userId - User ID
   * @param {string} beforeDate - ISO date cutoff
   * @returns {Promise<Object>} Delete result with count
   */
  async deleteOldEvents(userId, beforeDate) {
    if (!this.db) throw new Error('Events not initialized. Call init() first.');

    const cutoffTs = new Date(beforeDate).getTime();
    const stmt = this.db.prepare('DELETE FROM events WHERE user_id = ? AND timestamp < ?');
    const result = stmt.run(userId, cutoffTs);

    return { deletedCount: result.changes };
  }

  /**
   * Convert SQLite row to event object
   *
   * @private
   * @param {Object} row - Raw SQLite row
   * @returns {Object} Event object with parsed data and camelCase keys
   */
  _rowToEvent(row) {
    let data = {};
    try {
      data = JSON.parse(row.data);
    } catch {
      // Keep empty object
    }

    return {
      id: row.id,
      userId: row.user_id,
      type: row.type,
      data,
      timestamp: row.timestamp,
      createdAt: row.created_at,
    };
  }
}

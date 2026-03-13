import crypto from 'crypto';
import { DatabaseSync } from 'node:sqlite';
import { CronStore } from './CronStore.js';
import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_CONCURRENCY,
  HEARTBEAT_PROMPT,
  runWithConcurrency,
  parseInterval,
} from './cron_constants.js';

/**
 * SQLite-backed CronStore implementation
 *
 * Uses Node.js 22.5+ built-in sqlite module for zero-dependency cron storage.
 * All dates stored as INTEGER (Unix ms timestamps).
 */
export class SQLiteCronStore extends CronStore {
  constructor() {
    super();
    this.db = null;
    this.onTaskFire = null;
    this.pollInterval = null;
  }

  /**
   * Initialize SQLite cron store
   *
   * @param {string} dbPath - Path to SQLite database file
   * @param {Object} [options={}]
   * @param {Function} [options.onTaskFire] - Callback when a task fires: (task) => Promise<void>
   */
  async init(dbPath, options = {}) {
    this.db = new DatabaseSync(dbPath);
    this.onTaskFire = options.onTaskFire || null;

    // Migration: goal_id → task_id column
    const cols = this.db.prepare("PRAGMA table_info(cron_tasks)").all();
    if (cols.some(c => c.name === 'goal_id') && !cols.some(c => c.name === 'task_id')) {
      console.log('[cron] migrating goal_id column to task_id...');
      this.db.exec('ALTER TABLE cron_tasks RENAME COLUMN goal_id TO task_id');
    }

    // Migration: goal_step → task_step task type
    const goalStepCount = this.db.prepare("SELECT COUNT(*) as cnt FROM cron_tasks WHERE name = 'goal_step'").get();
    if (goalStepCount && goalStepCount.cnt > 0) {
      console.log('[cron] migrating goal_step tasks to task_step...');
      this.db.prepare("UPDATE cron_tasks SET name = 'task_step' WHERE name = 'goal_step'").run();
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cron_tasks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        prompt TEXT NOT NULL,
        session_id TEXT,
        user_id TEXT,
        task_id TEXT,
        next_run_at INTEGER NOT NULL,
        interval_ms INTEGER,
        recurring INTEGER DEFAULT 0,
        enabled INTEGER DEFAULT 1,
        created_at INTEGER NOT NULL,
        last_run_at INTEGER
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_heartbeat_user
        ON cron_tasks(user_id, name) WHERE name = 'heartbeat' AND enabled = 1;

      CREATE INDEX IF NOT EXISTS idx_cron_next_run ON cron_tasks(next_run_at);
      CREATE INDEX IF NOT EXISTS idx_cron_session ON cron_tasks(session_id);
    `);

    // Deduplicate existing heartbeats before relying on the unique index
    const dupes = this.db.prepare(`
      SELECT user_id, GROUP_CONCAT(id) as ids, COUNT(*) as cnt
      FROM cron_tasks
      WHERE name = 'heartbeat' AND enabled = 1 AND user_id IS NOT NULL
      GROUP BY user_id
      HAVING cnt > 1
    `).all();

    if (dupes.length > 0) {
      const deleteStmt = this.db.prepare('DELETE FROM cron_tasks WHERE id = ?');
      let cleaned = 0;
      for (const row of dupes) {
        const ids = row.ids.split(',');
        // Keep first (newest by insertion order), remove rest
        for (let i = 1; i < ids.length; i++) {
          deleteStmt.run(ids[i]);
          cleaned++;
        }
      }
      console.log(`[cron] cleaned up ${cleaned} duplicate heartbeat(s) for ${dupes.length} user(s)`);
    }

    // Start polling every 30 seconds
    this.pollInterval = setInterval(() => this.checkTasks(), 30 * 1000);
    // Also check immediately on startup
    await this.checkTasks();

    console.log('[cron] initialized with SQLite, polling every 30s');
  }

  stop() {
    if (this.pollInterval) clearInterval(this.pollInterval);
  }

  /**
   * Check for tasks that are due and fire them
   */
  async checkTasks() {
    if (!this.db || !this.onTaskFire) return;

    try {
      const now = Date.now();

      const dueTasks = this.db.prepare(
        'SELECT * FROM cron_tasks WHERE next_run_at <= ? AND enabled = 1'
      ).all(now);

      if (dueTasks.length === 0) return;

      const heartbeats = dueTasks.filter(t => t.name === 'heartbeat');
      const others = dueTasks.filter(t => t.name !== 'heartbeat');

      /** Process a single task: update schedule first, then fire callback */
      const processTask = async (task) => {
        const mapped = this._rowToTask(task);
        // Update schedule BEFORE firing to prevent duplicate picks during long-running callbacks
        if (task.recurring && task.interval_ms) {
          this.db.prepare(
            'UPDATE cron_tasks SET next_run_at = ? WHERE id = ?'
          ).run(now + task.interval_ms, task.id);
        } else {
          this.db.prepare(
            'UPDATE cron_tasks SET enabled = 0 WHERE id = ?'
          ).run(task.id);
        }
        try {
          await this.onTaskFire(mapped);
          // Update last_run_at after successful completion
          this.db.prepare(
            'UPDATE cron_tasks SET last_run_at = ? WHERE id = ?'
          ).run(Date.now(), task.id);
        } catch (err) {
          console.error(`[cron] error firing task ${task.name}:`, err.message);
        }
      };

      // Heartbeats run in parallel with a concurrency cap
      if (heartbeats.length > 0) {
        console.log(`[cron] firing ${heartbeats.length} heartbeat(s) (concurrency: ${HEARTBEAT_CONCURRENCY})`);
        await runWithConcurrency(
          heartbeats.map(t => () => processTask(t)),
          HEARTBEAT_CONCURRENCY
        );
      }

      // Other tasks run sequentially
      for (const task of others) {
        await processTask(task);
      }
    } catch (err) {
      console.error(`[cron] checkTasks query failed:`, err.message);
    }
  }

  /**
   * Create a scheduled task
   *
   * @param {Object} params - Task parameters
   * @returns {Promise<Object>} Created task
   */
  async createTask({ name, prompt, sessionId, userId, runAt, intervalMs, recurring, taskId }) {
    const id = crypto.randomUUID();
    const now = Date.now();

    this.db.prepare(`
      INSERT INTO cron_tasks (id, name, prompt, session_id, user_id, task_id, next_run_at, interval_ms, recurring, enabled, created_at, last_run_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, NULL)
    `).run(
      id,
      name,
      prompt,
      sessionId || 'default',
      userId || null,
      taskId || null,
      new Date(runAt).getTime(),
      intervalMs || null,
      recurring ? 1 : 0,
      now
    );

    return {
      id,
      name,
      prompt,
      sessionId: sessionId || 'default',
      userId: userId || null,
      taskId: taskId || null,
      nextRunAt: new Date(runAt),
      intervalMs: intervalMs || null,
      recurring: recurring || false,
      enabled: true,
      createdAt: new Date(now),
      lastRunAt: null,
    };
  }

  /**
   * List tasks for a session
   *
   * @param {string} [sessionId] - Session ID to filter by
   * @returns {Promise<Array>} Task list sorted by next run time
   */
  async listTasks(sessionId) {
    const rows = this.db.prepare(
      "SELECT * FROM cron_tasks WHERE session_id = ? AND name != 'heartbeat' ORDER BY next_run_at ASC"
    ).all(sessionId || 'default');

    return rows.map(r => ({
      id: r.id,
      name: r.name,
      prompt: r.prompt,
      nextRunAt: new Date(r.next_run_at),
      recurring: !!r.recurring,
      intervalMs: r.interval_ms,
      enabled: !!r.enabled,
      lastRunAt: r.last_run_at ? new Date(r.last_run_at) : null,
    }));
  }

  /**
   * List tasks for multiple session IDs
   *
   * @param {string[]} sessionIds - Array of session IDs
   * @param {string} [userId] - Optional user ID filter
   * @returns {Promise<Array>} Task list sorted by next run time
   */
  async listTasksBySessionIds(sessionIds, userId = null) {
    if (!this.db || sessionIds.length === 0) return [];

    const allIds = [...sessionIds, 'default'];
    const placeholders = allIds.map(() => '?').join(',');

    let query = `SELECT * FROM cron_tasks WHERE session_id IN (${placeholders}) AND name != 'heartbeat'`;
    const params = [...allIds];

    if (userId) {
      query += ' AND (user_id = ? OR user_id IS NULL)';
      params.push(userId);
    }

    query += ' ORDER BY next_run_at ASC';

    const rows = this.db.prepare(query).all(...params);

    return rows.map(r => ({
      id: r.id,
      name: r.name,
      prompt: r.prompt,
      sessionId: r.session_id,
      nextRunAt: new Date(r.next_run_at),
      recurring: !!r.recurring,
      intervalMs: r.interval_ms,
      enabled: !!r.enabled,
      lastRunAt: r.last_run_at ? new Date(r.last_run_at) : null,
      createdAt: new Date(r.created_at),
    }));
  }

  /**
   * Get a task by ID
   *
   * @param {string} id - Task ID
   * @returns {Promise<Object|null>} Task or null
   */
  async getTask(id) {
    const row = this.db.prepare('SELECT * FROM cron_tasks WHERE id = ?').get(id);
    if (!row) return null;
    return this._rowToTask(row);
  }

  /**
   * Delete a task by ID
   *
   * @param {string} id - Task ID
   * @returns {Promise<Object>} Delete result with changes count
   */
  async deleteTask(id) {
    const result = this.db.prepare('DELETE FROM cron_tasks WHERE id = ?').run(id);
    return { deletedCount: result.changes };
  }

  /**
   * Toggle a task's enabled state
   *
   * @param {string} id - Task ID
   * @param {boolean} enabled - New enabled state
   * @returns {Promise<Object>} Update result
   */
  async toggleTask(id, enabled) {
    const result = this.db.prepare(
      'UPDATE cron_tasks SET enabled = ? WHERE id = ?'
    ).run(enabled ? 1 : 0, id);
    return { modifiedCount: result.changes };
  }

  /**
   * Update a task's details
   *
   * @param {string} id - Task ID
   * @param {Object} updates - Fields to update
   * @returns {Promise<Object>} Update result
   */
  async updateTask(id, updates) {
    const sets = [];
    const params = [];

    if (updates.name !== undefined) { sets.push('name = ?'); params.push(updates.name); }
    if (updates.prompt !== undefined) { sets.push('prompt = ?'); params.push(updates.prompt); }
    if (updates.runAt !== undefined) { sets.push('next_run_at = ?'); params.push(new Date(updates.runAt).getTime()); }
    if (updates.intervalMs !== undefined) { sets.push('interval_ms = ?'); params.push(updates.intervalMs); }
    if (updates.recurring !== undefined) { sets.push('recurring = ?'); params.push(updates.recurring ? 1 : 0); }

    if (sets.length === 0) return { modifiedCount: 0 };

    params.push(id);
    const result = this.db.prepare(
      `UPDATE cron_tasks SET ${sets.join(', ')} WHERE id = ?`
    ).run(...params);
    return { modifiedCount: result.changes };
  }

  /**
   * Ensure a single recurring heartbeat exists for a user.
   * Uses INSERT OR IGNORE for atomicity against the unique partial index.
   *
   * @param {string} userId - User ID
   * @returns {Promise<Object|null>} Created task or null if already exists
   */
  async ensureHeartbeat(userId) {
    if (!this.db || !userId) {
      console.log(`[cron] ensureHeartbeat skipped: db=${!!this.db}, userId=${userId}`);
      return null;
    }

    const jitter = Math.floor(Math.random() * HEARTBEAT_INTERVAL_MS);
    const now = Date.now();
    const id = crypto.randomUUID();

    const result = this.db.prepare(`
      INSERT OR IGNORE INTO cron_tasks (id, name, prompt, session_id, user_id, next_run_at, interval_ms, recurring, enabled, created_at, last_run_at)
      VALUES (?, 'heartbeat', ?, 'default', ?, ?, ?, 1, 1, ?, NULL)
    `).run(id, HEARTBEAT_PROMPT, userId, now + jitter, HEARTBEAT_INTERVAL_MS, now);

    if (result.changes > 0) {
      console.log(`[cron] created heartbeat for user ${userId}, first run in ${Math.round(jitter / 60000)}m`);
      return { id };
    }

    // Auto-update stale prompt
    const existing = this.db.prepare(
      "SELECT id, prompt FROM cron_tasks WHERE user_id = ? AND name = 'heartbeat' AND enabled = 1"
    ).get(userId);

    if (existing && existing.prompt !== HEARTBEAT_PROMPT) {
      this.db.prepare('UPDATE cron_tasks SET prompt = ? WHERE id = ?').run(HEARTBEAT_PROMPT, existing.id);
      console.log(`[cron] updated heartbeat prompt for user ${userId}`);
    }

    return null;
  }

  /**
   * Ensure a Morning Brief job exists for the user (disabled by default).
   * Creates a daily recurring job at 8:00 AM if not present.
   *
   * @param {string} userId - User ID
   * @returns {Promise<Object|null>} Created task or null if already exists
   */
  async ensureMorningBrief(userId) {
    if (!this.db || !userId) return null;

    // Check if Morning Brief already exists for this user
    const existing = this.db.prepare(
      `SELECT id FROM cron_tasks WHERE user_id = ? AND name = 'Morning Brief' LIMIT 1`
    ).get(userId);
    if (existing) return null;

    const DAY_MS = 24 * 60 * 60 * 1000;
    const MORNING_BRIEF_PROMPT = `Good morning! Give me a brief summary to start my day:
1. What's on my calendar today?
2. Any important reminders or tasks due?
3. A quick weather update for my location.
Keep it concise and actionable.`;

    // Calculate next 8:00 AM
    const now = new Date();
    const today8AM = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 8, 0, 0, 0);
    const nextRun = now.getTime() < today8AM.getTime()
      ? today8AM.getTime()
      : today8AM.getTime() + DAY_MS;

    const id = crypto.randomUUID();
    const nowMs = Date.now();

    const result = this.db.prepare(`
      INSERT OR IGNORE INTO cron_tasks (id, name, prompt, session_id, user_id, next_run_at, interval_ms, recurring, enabled, created_at, last_run_at)
      VALUES (?, 'Morning Brief', ?, 'default', ?, ?, ?, 1, 0, ?, NULL)
    `).run(id, MORNING_BRIEF_PROMPT, userId, nextRun, DAY_MS, nowMs);

    if (result.changes > 0) {
      const runTime = new Date(nextRun);
      console.log(`[cron] created Morning Brief for user ${userId}, next run at ${runTime.toLocaleTimeString()} (disabled by default)`);
      return { id };
    }

    return null;
  }

  /**
   * Get heartbeat status for a user
   *
   * @param {string} userId - User ID
   * @returns {Promise<Object|null>} Heartbeat info or null
   */
  async getHeartbeatStatus(userId) {
    if (!this.db || !userId) return null;

    const row = this.db.prepare(
      "SELECT * FROM cron_tasks WHERE user_id = ? AND name = 'heartbeat'"
    ).get(userId);

    if (!row) return null;
    return {
      id: row.id,
      enabled: !!row.enabled,
      nextRunAt: new Date(row.next_run_at),
      lastRunAt: row.last_run_at ? new Date(row.last_run_at) : null,
      createdAt: new Date(row.created_at),
      intervalMs: row.interval_ms,
      prompt: row.prompt,
    };
  }

  /**
   * Delete existing heartbeat(s) and create a fresh one
   *
   * @param {string} userId - User ID
   * @returns {Promise<Object|null>} New heartbeat task or null
   */
  async resetHeartbeat(userId) {
    if (!this.db || !userId) return null;

    const deleted = this.db.prepare(
      "DELETE FROM cron_tasks WHERE user_id = ? AND name = 'heartbeat'"
    ).run(userId);
    console.log(`[cron] deleted existing heartbeat(s) for user ${userId}`);

    const jitter = Math.floor(Math.random() * HEARTBEAT_INTERVAL_MS);
    const now = Date.now();
    const id = crypto.randomUUID();

    this.db.prepare(`
      INSERT INTO cron_tasks (id, name, prompt, session_id, user_id, next_run_at, interval_ms, recurring, enabled, created_at, last_run_at)
      VALUES (?, 'heartbeat', ?, 'default', ?, ?, ?, 1, 1, ?, NULL)
    `).run(id, HEARTBEAT_PROMPT, userId, now + jitter, HEARTBEAT_INTERVAL_MS, now);

    console.log(`[cron] created new heartbeat for user ${userId}, first run in ${Math.round(jitter / 60000)}m`);

    return {
      id,
      name: 'heartbeat',
      prompt: HEARTBEAT_PROMPT,
      userId,
      sessionId: 'default',
      nextRunAt: new Date(now + jitter),
      intervalMs: HEARTBEAT_INTERVAL_MS,
      recurring: true,
      enabled: true,
      createdAt: new Date(now),
      lastRunAt: null,
    };
  }

  /**
   * Manually trigger the heartbeat task immediately
   *
   * @param {string} userId - User ID
   * @returns {Promise<boolean>} True if heartbeat was fired
   */
  async triggerHeartbeatNow(userId) {
    if (!this.db || !userId || !this.onTaskFire) return false;

    const row = this.db.prepare(
      "SELECT * FROM cron_tasks WHERE user_id = ? AND name = 'heartbeat' AND enabled = 1"
    ).get(userId);

    if (!row) {
      console.log(`[cron] manual trigger failed: no enabled heartbeat for user ${userId}`);
      return false;
    }

    console.log(`[cron] manually triggering heartbeat for user ${userId}`);
    try {
      await this.onTaskFire(this._rowToTask(row));
      this.db.prepare(
        'UPDATE cron_tasks SET last_run_at = ? WHERE id = ?'
      ).run(Date.now(), row.id);
      return true;
    } catch (err) {
      console.error(`[cron] manual trigger error:`, err.message);
      return false;
    }
  }

  /**
   * Convert a raw SQLite row to a task object with JS types
   *
   * @private
   * @param {Object} row - Raw SQLite row
   * @returns {Object} Task with Date objects and booleans
   */
  _rowToTask(row) {
    return {
      id: row.id,
      name: row.name,
      prompt: row.prompt,
      sessionId: row.session_id,
      userId: row.user_id,
      taskId: row.task_id,
      nextRunAt: new Date(row.next_run_at),
      intervalMs: row.interval_ms,
      recurring: !!row.recurring,
      enabled: !!row.enabled,
      createdAt: new Date(row.created_at),
      lastRunAt: row.last_run_at ? new Date(row.last_run_at) : null,
    };
  }

  /**
   * Close the database connection and checkpoint WAL.
   */
  close() {
    this.stop();
    if (this.db) {
      try {
        this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        this.db.close();
        this.db = null;
        console.log('[cron] SQLiteCronStore closed');
      } catch (err) {
        console.error('[cron] Error closing database:', err.message);
      }
    }
  }
}

// Re-export utility functions for tool definitions
export { parseInterval, HEARTBEAT_INTERVAL_MS, HEARTBEAT_PROMPT } from './cron_constants.js';

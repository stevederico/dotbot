/// <reference types="node" />
import crypto from 'crypto';
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue, SQLOutputValue } from 'node:sqlite';
import { CronStore } from './CronStore.js';
import type {
  CronTask,
  CreateCronTaskParams,
  CronTaskUpdates,
  HeartbeatStatus,
  CronStoreInitOptions,
} from './CronStore.js';
import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_CONCURRENCY,
  HEARTBEAT_PROMPT,
  runWithConcurrency,
  parseInterval,
} from './cron_constants.js';

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

/** Coerce a raw SQLite cell to a string or null. */
function asStringOrNull(value: SQLOutputValue | undefined): string | null {
  if (value === null || value === undefined) return null;
  return asString(value);
}

// Shared cron types live in CronStore.ts (the base contract); re-export them
// here to preserve this module's public API.
export type {
  CronTask,
  CreateCronTaskParams,
  CronTaskUpdates,
  HeartbeatStatus,
  CronStoreInitOptions,
} from './CronStore.js';

/**
 * SQLite-backed CronStore implementation
 *
 * Uses Node.js 22.5+ built-in sqlite module for zero-dependency cron storage.
 * All dates stored as INTEGER (Unix ms timestamps).
 */
export class SQLiteCronStore extends CronStore {
  db: DatabaseSync | null;
  onTaskFire: ((task: CronTask) => Promise<void>) | null;
  pollInterval: ReturnType<typeof setInterval> | null;

  constructor() {
    super();
    this.db = null;
    this.onTaskFire = null;
    this.pollInterval = null;
  }

  /**
   * Initialize SQLite cron store
   *
   * @param dbPath - Path to SQLite database file
   * @param options - Initialization options
   */
  async init(dbPath: string, options: CronStoreInitOptions = {}): Promise<void> {
    this.db = new DatabaseSync(dbPath);
    this.onTaskFire = options.onTaskFire || null;

    // Create table first
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

    // Migration: goal_id → task_id column
    const cols = this.db.prepare("PRAGMA table_info(cron_tasks)").all();
    if (cols.some(c => c.name === 'goal_id') && !cols.some(c => c.name === 'task_id')) {
      console.log('[cron] migrating goal_id column to task_id...');
      this.db.exec('ALTER TABLE cron_tasks RENAME COLUMN goal_id TO task_id');
    }

    // Migration: goal_step → task_step task type
    const goalStepCount = this.db.prepare("SELECT COUNT(*) as cnt FROM cron_tasks WHERE name = 'goal_step'").get();
    if (goalStepCount && asNumber(goalStepCount.cnt) > 0) {
      console.log('[cron] migrating goal_step tasks to task_step...');
      this.db.prepare("UPDATE cron_tasks SET name = 'task_step' WHERE name = 'goal_step'").run();
    }

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
        const ids = asString(row.ids).split(',');
        // Keep first (newest by insertion order), remove rest
        for (let i = 1; i < ids.length; i++) {
          const id = ids[i];
          if (id === undefined) continue;
          deleteStmt.run(id);
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

  stop(): void {
    if (this.pollInterval) clearInterval(this.pollInterval);
  }

  /**
   * Check for tasks that are due and fire them
   */
  async checkTasks(): Promise<void> {
    if (!this.db || !this.onTaskFire) return;
    const db = this.db;
    const onTaskFire = this.onTaskFire;

    try {
      const now = Date.now();

      const dueTasks = db.prepare(
        'SELECT * FROM cron_tasks WHERE next_run_at <= ? AND enabled = 1'
      ).all(now);

      if (dueTasks.length === 0) return;

      const heartbeats = dueTasks.filter(t => t.name === 'heartbeat');
      const others = dueTasks.filter(t => t.name !== 'heartbeat');

      /** Process a single task: update schedule first, then fire callback */
      const processTask = async (task: Record<string, SQLOutputValue>): Promise<void> => {
        const mapped = this._rowToTask(task);
        const taskId = asString(task.id);
        const intervalMs = asNumberOrNull(task.interval_ms);
        // Update schedule BEFORE firing to prevent duplicate picks during long-running callbacks
        if (task.recurring && intervalMs) {
          db.prepare(
            'UPDATE cron_tasks SET next_run_at = ? WHERE id = ?'
          ).run(now + intervalMs, taskId);
        } else {
          db.prepare(
            'UPDATE cron_tasks SET enabled = 0 WHERE id = ?'
          ).run(taskId);
        }
        try {
          await onTaskFire(mapped);
          // Update last_run_at after successful completion
          db.prepare(
            'UPDATE cron_tasks SET last_run_at = ? WHERE id = ?'
          ).run(Date.now(), taskId);
        } catch (err) {
          console.error(`[cron] error firing task ${asString(task.name)}:`, err instanceof Error ? err.message : err);
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
      console.error(`[cron] checkTasks query failed:`, err instanceof Error ? err.message : err);
    }
  }

  /**
   * Create a scheduled task
   *
   * @returns Created task
   */
  async createTask({ name, prompt, sessionId, userId, runAt, intervalMs, recurring, taskId }: CreateCronTaskParams): Promise<CronTask> {
    if (!this.db) throw new Error('Cron not initialized. Call init() first.');
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
   * @param sessionId - Session ID to filter by
   * @returns Task list sorted by next run time
   */
  async listTasks(sessionId?: string): Promise<CronTask[]> {
    if (!this.db) throw new Error('Cron not initialized. Call init() first.');
    const rows = this.db.prepare(
      "SELECT * FROM cron_tasks WHERE session_id = ? AND name != 'heartbeat' ORDER BY next_run_at ASC"
    ).all(sessionId || 'default');

    return rows.map(r => this._rowToTask(r));
  }

  /**
   * List tasks for multiple session IDs
   *
   * @param sessionIds - Array of session IDs
   * @param userId - Optional user ID filter
   * @returns Task list sorted by next run time
   */
  async listTasksBySessionIds(sessionIds: string[], userId: string | null = null): Promise<CronTask[]> {
    if (!this.db || sessionIds.length === 0) return [];

    const allIds = [...sessionIds, 'default'];
    const placeholders = allIds.map(() => '?').join(',');

    let query = `SELECT * FROM cron_tasks WHERE session_id IN (${placeholders}) AND name != 'heartbeat'`;
    const params: SQLInputValue[] = [...allIds];

    if (userId) {
      query += ' AND (user_id = ? OR user_id IS NULL)';
      params.push(userId);
    }

    query += ' ORDER BY next_run_at ASC';

    const rows = this.db.prepare(query).all(...params);

    return rows.map(r => this._rowToTask(r));
  }

  /**
   * Get a task by ID
   *
   * @param id - Task ID
   * @returns Task or null
   */
  async getTask(id: string): Promise<CronTask | null> {
    if (!this.db) throw new Error('Cron not initialized. Call init() first.');
    const row = this.db.prepare('SELECT * FROM cron_tasks WHERE id = ?').get(id);
    if (!row) return null;
    return this._rowToTask(row);
  }

  /**
   * Delete a task by ID
   *
   * @param id - Task ID
   * @returns Delete result with changes count
   */
  async deleteTask(id: string): Promise<{ deletedCount: number | bigint }> {
    if (!this.db) throw new Error('Cron not initialized. Call init() first.');
    const result = this.db.prepare('DELETE FROM cron_tasks WHERE id = ?').run(id);
    return { deletedCount: result.changes };
  }

  /**
   * Toggle a task's enabled state
   *
   * @param id - Task ID
   * @param enabled - New enabled state
   * @returns Update result
   */
  async toggleTask(id: string, enabled: boolean): Promise<{ modifiedCount: number | bigint }> {
    if (!this.db) throw new Error('Cron not initialized. Call init() first.');
    const result = this.db.prepare(
      'UPDATE cron_tasks SET enabled = ? WHERE id = ?'
    ).run(enabled ? 1 : 0, id);
    return { modifiedCount: result.changes };
  }

  /**
   * Update a task's details
   *
   * @param id - Task ID
   * @param updates - Fields to update
   * @returns Update result
   */
  async updateTask(id: string, updates: CronTaskUpdates): Promise<{ modifiedCount: number | bigint }> {
    if (!this.db) throw new Error('Cron not initialized. Call init() first.');
    const sets: string[] = [];
    const params: SQLInputValue[] = [];

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
   * @param userId - User ID
   * @returns Created task or null if already exists
   */
  async ensureHeartbeat(userId: string): Promise<{ id: string } | null> {
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

    if (existing && asString(existing.prompt) !== HEARTBEAT_PROMPT) {
      this.db.prepare('UPDATE cron_tasks SET prompt = ? WHERE id = ?').run(HEARTBEAT_PROMPT, asString(existing.id));
      console.log(`[cron] updated heartbeat prompt for user ${userId}`);
    }

    return null;
  }

  /**
   * Get heartbeat status for a user
   *
   * @param userId - User ID
   * @returns Heartbeat info or null
   */
  async getHeartbeatStatus(userId: string): Promise<HeartbeatStatus | null> {
    if (!this.db || !userId) return null;

    const row = this.db.prepare(
      "SELECT * FROM cron_tasks WHERE user_id = ? AND name = 'heartbeat'"
    ).get(userId);

    if (!row) return null;
    const lastRun = asNumberOrNull(row.last_run_at);
    return {
      id: asString(row.id),
      enabled: !!row.enabled,
      nextRunAt: new Date(asNumber(row.next_run_at)),
      lastRunAt: lastRun !== null ? new Date(lastRun) : null,
      createdAt: new Date(asNumber(row.created_at)),
      intervalMs: asNumberOrNull(row.interval_ms),
      prompt: asString(row.prompt),
    };
  }

  /**
   * Delete existing heartbeat(s) and create a fresh one
   *
   * @param userId - User ID
   * @returns New heartbeat task or null
   */
  async resetHeartbeat(userId: string): Promise<CronTask | null> {
    if (!this.db || !userId) return null;

    this.db.prepare(
      "DELETE FROM cron_tasks WHERE user_id = ? AND name = 'heartbeat'"
    ).run(userId);
    console.log(`[cron] deleted existing heartbeat(s) for user ${userId}`);

    const result = await this.ensureHeartbeat(userId);

    if (!result) return null;

    // Return the full task object for the newly created heartbeat
    const row = this.db.prepare('SELECT * FROM cron_tasks WHERE id = ?').get(result.id);
    return row ? this._rowToTask(row) : null;
  }

  /**
   * Manually trigger the heartbeat task immediately
   *
   * @param userId - User ID
   * @returns True if heartbeat was fired
   */
  async triggerHeartbeatNow(userId: string): Promise<boolean> {
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
      ).run(Date.now(), asString(row.id));
      return true;
    } catch (err) {
      console.error(`[cron] manual trigger error:`, err instanceof Error ? err.message : err);
      return false;
    }
  }

  /**
   * Convert a raw SQLite row to a task object with JS types
   *
   * @private
   */
  _rowToTask(row: Record<string, SQLOutputValue>): CronTask {
    const lastRun = asNumberOrNull(row.last_run_at);
    return {
      id: asString(row.id),
      name: asString(row.name),
      prompt: asString(row.prompt),
      sessionId: asStringOrNull(row.session_id),
      userId: asStringOrNull(row.user_id),
      taskId: asStringOrNull(row.task_id),
      nextRunAt: new Date(asNumber(row.next_run_at)),
      intervalMs: asNumberOrNull(row.interval_ms),
      recurring: !!row.recurring,
      enabled: !!row.enabled,
      createdAt: new Date(asNumber(row.created_at)),
      lastRunAt: lastRun !== null ? new Date(lastRun) : null,
    };
  }

  /**
   * Close the database connection and checkpoint WAL.
   */
  close(): void {
    this.stop();
    if (this.db) {
      try {
        this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        this.db.close();
        this.db = null;
        console.log('[cron] SQLiteCronStore closed');
      } catch (err) {
        console.error('[cron] Error closing database:', err instanceof Error ? err.message : err);
      }
    }
  }
}

// Re-export utility functions for tool definitions
export { parseInterval, HEARTBEAT_INTERVAL_MS, HEARTBEAT_PROMPT } from './cron_constants.js';

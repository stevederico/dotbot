import crypto from 'crypto';
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue, SQLOutputValue } from 'node:sqlite';
import { TaskStore } from './TaskStore.js';

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

/** Parse a JSON string into a TaskStep array, returning [] on failure. */
function parseSteps(text: string): TaskStep[] {
  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return parsed.map((item) => normalizeStep(item));
    }
  } catch {
    // fall through
  }
  return [];
}

/** Normalize an arbitrary step input (string or object) into a TaskStep. */
function normalizeStep(step: unknown): TaskStep {
  if (typeof step === 'string') {
    return {
      text: step,
      action: step,
      done: false,
      result: null,
      startedAt: null,
      completedAt: null,
    };
  }
  const obj: Record<string, unknown> =
    typeof step === 'object' && step !== null ? { ...step } : {};
  const text = typeof obj.text === 'string' ? obj.text : typeof obj.description === 'string' ? obj.description : '';
  const action = typeof obj.action === 'string' ? obj.action : text;
  return {
    text,
    action,
    done: obj.done === true,
    result: obj.result ?? null,
    startedAt: obj.startedAt ?? null,
    completedAt: obj.completedAt ?? null,
  };
}

/** A normalized task step. */
export interface TaskStep {
  text: string;
  action: string;
  done: boolean;
  result: unknown;
  startedAt: unknown;
  completedAt: unknown;
}

/** A raw step input accepted by createTask(). */
export interface TaskStepInput {
  text?: string;
  description?: string;
  action?: string;
  done?: boolean;
  result?: unknown;
  startedAt?: unknown;
  completedAt?: unknown;
}

/** A task document with JS-native types. */
export interface TaskDoc {
  id: string;
  userId: string;
  description: string;
  steps: TaskStep[];
  category: string;
  priority: string;
  deadline: number | null;
  mode: string;
  status: string;
  currentStep: number;
  progress: number;
  createdAt: number;
  updatedAt: number;
  lastWorkedAt: number | null;
}

/** Parameters for createTask(). */
export interface CreateTaskParams {
  userId: string;
  description: string;
  steps?: Array<string | TaskStepInput>;
  category?: string;
  priority?: string;
  deadline?: number | null;
  mode?: string;
}

/** Optional filters for getTasks(). */
export interface TaskFilters {
  status?: string;
  category?: string;
  priority?: string;
}

/** Fields accepted by updateTask(). */
export interface TaskUpdates {
  description?: string;
  steps?: Array<string | TaskStepInput>;
  category?: string;
  priority?: string;
  deadline?: number | null;
  mode?: string;
  status?: string;
  currentStep?: number;
  lastWorkedAt?: number | null;
}

/** Aggregate task statistics for a user. */
export interface TaskStats {
  total: number;
  pending: number;
  in_progress: number;
  completed: number;
  by_category: Record<string, number>;
  by_priority: Record<string, number>;
  overdue: number;
}

/**
 * SQLite-backed TaskStore implementation
 *
 * Uses Node.js 22.5+ built-in sqlite module for zero-dependency task storage.
 * Dates stored as INTEGER (Unix ms), steps as JSON TEXT column.
 */
export class SQLiteTaskStore extends TaskStore<
  TaskDoc,
  CreateTaskParams,
  TaskFilters,
  TaskUpdates,
  TaskStats,
  { changes: number | bigint },
  { deletedCount: number | bigint }
> {
  db: DatabaseSync | null;

  constructor() {
    super();
    this.db = null;
  }

  /**
   * Initialize SQLite task store
   *
   * @param dbPath - Path to SQLite database file
   */
  async init(dbPath: string): Promise<void> {
    this.db = new DatabaseSync(dbPath);

    // Migration: goals → tasks table
    const goalsExists = this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='goals'"
    ).get();
    const tasksExists = this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'"
    ).get();

    if (goalsExists && !tasksExists) {
      console.log('[tasks] migrating goals table to tasks...');
      this.db.exec('ALTER TABLE goals RENAME TO tasks');
      // Also rename indexes
      this.db.exec('DROP INDEX IF EXISTS idx_goals_user_status');
      this.db.exec('DROP INDEX IF EXISTS idx_goals_user_category');
      this.db.exec('DROP INDEX IF EXISTS idx_goals_user_priority');
      this.db.exec('DROP INDEX IF EXISTS idx_goals_user_deadline');
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        description TEXT NOT NULL,
        steps TEXT NOT NULL,
        category TEXT DEFAULT 'general',
        priority TEXT DEFAULT 'medium',
        deadline INTEGER,
        mode TEXT DEFAULT 'auto',
        status TEXT DEFAULT 'pending',
        current_step INTEGER DEFAULT 0,
        progress INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_worked_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_user_status ON tasks(user_id, status);
      CREATE INDEX IF NOT EXISTS idx_tasks_user_category ON tasks(user_id, category);
      CREATE INDEX IF NOT EXISTS idx_tasks_user_priority ON tasks(user_id, priority);
      CREATE INDEX IF NOT EXISTS idx_tasks_user_deadline ON tasks(user_id, deadline);
    `);

    console.log('[tasks] SQLiteTaskStore initialized');
  }

  /**
   * Create a new task
   *
   * @returns Created task document
   */
  async createTask({ userId, description, steps = [], category = 'general', priority = 'medium', deadline = null, mode = 'auto' }: CreateTaskParams): Promise<TaskDoc> {
    if (!this.db) throw new Error('Tasks not initialized. Call init() first.');

    const normalizedSteps: TaskStep[] = steps.map(step => {
      if (typeof step === 'string') {
        return {
          text: step,
          action: step,
          done: false,
          result: null,
          startedAt: null,
          completedAt: null,
        };
      }
      return {
        text: step.text || step.description || '',
        action: step.action || step.text || '',
        done: step.done || false,
        result: step.result || null,
        startedAt: step.startedAt || null,
        completedAt: step.completedAt || null,
      };
    });

    const now = Date.now();
    const task: TaskDoc = {
      id: crypto.randomUUID(),
      userId,
      description,
      steps: normalizedSteps,
      category,
      priority,
      deadline,
      mode,
      status: 'pending',
      currentStep: 0,
      progress: 0,
      createdAt: now,
      updatedAt: now,
      lastWorkedAt: null,
    };

    const stmt = this.db.prepare(`
      INSERT INTO tasks (id, user_id, description, steps, category, priority, deadline, mode, status, current_step, progress, created_at, updated_at, last_worked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      task.id,
      task.userId,
      task.description,
      JSON.stringify(task.steps),
      task.category,
      task.priority,
      task.deadline,
      task.mode,
      task.status,
      task.currentStep,
      task.progress,
      task.createdAt,
      task.updatedAt,
      task.lastWorkedAt
    );

    return task;
  }

  /**
   * Get tasks for a user, optionally filtered by status/category/priority
   *
   * @param userId - User ID
   * @param filters - Optional filters
   * @returns Task list with computed progress
   */
  async getTasks(userId: string, filters: TaskFilters = {}): Promise<TaskDoc[]> {
    if (!this.db) throw new Error('Tasks not initialized. Call init() first.');

    let sql = 'SELECT * FROM tasks WHERE user_id = ?';
    const params: SQLInputValue[] = [userId];

    if (filters.status) {
      sql += ' AND status = ?';
      params.push(filters.status);
    }
    if (filters.category) {
      sql += ' AND category = ?';
      params.push(filters.category);
    }
    if (filters.priority) {
      sql += ' AND priority = ?';
      params.push(filters.priority);
    }

    sql += ' ORDER BY created_at DESC';

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params);

    return rows.map((row: Record<string, SQLOutputValue>) => {
      const task = this._rowToTask(row);
      task.progress = this._calculateProgress(task);
      return task;
    });
  }

  /**
   * Get a single task by ID
   *
   * @param userId - User ID
   * @param taskId - Task UUID
   * @returns Task document or null
   */
  async getTask(userId: string, taskId: string): Promise<TaskDoc | null> {
    if (!this.db) throw new Error('Tasks not initialized. Call init() first.');

    const stmt = this.db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?');
    const row = stmt.get(taskId, userId);

    if (!row) return null;

    const task = this._rowToTask(row);
    task.progress = this._calculateProgress(task);
    return task;
  }

  /**
   * Update a task with allowed fields
   *
   * @param userId - User ID
   * @param taskId - Task UUID
   * @param updates - Fields to update
   * @returns Result with changes count
   */
  async updateTask(userId: string, taskId: string, updates: TaskUpdates): Promise<{ changes: number | bigint }> {
    if (!this.db) throw new Error('Tasks not initialized. Call init() first.');

    const allowedFields: Array<keyof TaskUpdates> = [
      'description', 'steps', 'category', 'priority', 'deadline',
      'mode', 'status', 'currentStep', 'lastWorkedAt'
    ];

    // Map camelCase to snake_case for SQL columns
    const fieldMap: Record<string, string> = {
      description: 'description',
      steps: 'steps',
      category: 'category',
      priority: 'priority',
      deadline: 'deadline',
      mode: 'mode',
      status: 'status',
      currentStep: 'current_step',
      lastWorkedAt: 'last_worked_at',
    };

    const setClauses: string[] = [];
    const values: SQLInputValue[] = [];

    for (const field of allowedFields) {
      const value = updates[field];
      if (value !== undefined) {
        const col = fieldMap[field];
        setClauses.push(`${col} = ?`);
        if (field === 'steps') {
          values.push(JSON.stringify(value));
        } else if (typeof value === 'string' || typeof value === 'number' || value === null) {
          values.push(value);
        } else {
          values.push(JSON.stringify(value));
        }
      }
    }

    if (updates.steps) {
      setClauses.push('progress = ?');
      values.push(this._calculateProgressFromSteps(updates.steps));
    }

    setClauses.push('updated_at = ?');
    values.push(Date.now());

    const sql = `UPDATE tasks SET ${setClauses.join(', ')} WHERE id = ? AND user_id = ?`;
    values.push(taskId, userId);

    const stmt = this.db.prepare(sql);
    const result = stmt.run(...values);

    return { changes: result.changes };
  }

  /**
   * Delete a task
   *
   * @param userId - User ID
   * @param taskId - Task UUID
   * @returns Result with deletedCount
   */
  async deleteTask(userId: string, taskId: string): Promise<{ deletedCount: number | bigint }> {
    if (!this.db) throw new Error('Tasks not initialized. Call init() first.');

    const stmt = this.db.prepare('DELETE FROM tasks WHERE id = ? AND user_id = ?');
    const result = stmt.run(taskId, userId);

    return { deletedCount: result.changes };
  }

  /**
   * Search tasks by description or step text (case-insensitive LIKE)
   *
   * @param userId - User ID
   * @param query - Search text
   * @returns Matching tasks with computed progress
   */
  async searchTasks(userId: string, query: string): Promise<TaskDoc[]> {
    if (!this.db) throw new Error('Tasks not initialized. Call init() first.');

    const pattern = `%${query}%`;
    const stmt = this.db.prepare(`
      SELECT * FROM tasks
      WHERE user_id = ? AND (description LIKE ? OR steps LIKE ?)
      ORDER BY created_at DESC
    `);

    const rows = stmt.all(userId, pattern, pattern);

    return rows.map((row: Record<string, SQLOutputValue>) => {
      const task = this._rowToTask(row);
      task.progress = this._calculateProgress(task);
      return task;
    });
  }

  /**
   * Get aggregate task statistics for a user
   *
   * @param userId - User ID
   * @returns Stats object with totals, breakdowns, and overdue count
   */
  async getTaskStats(userId: string): Promise<TaskStats> {
    if (!this.db) throw new Error('Tasks not initialized. Call init() first.');

    const stmt = this.db.prepare('SELECT * FROM tasks WHERE user_id = ?');
    const rows = stmt.all(userId);
    const tasks = rows.map((row: Record<string, SQLOutputValue>) => this._rowToTask(row));

    const now = Date.now();
    const stats: TaskStats = {
      total: tasks.length,
      pending: tasks.filter(g => g.status === 'pending').length,
      in_progress: tasks.filter(g => g.status === 'in_progress').length,
      completed: tasks.filter(g => g.status === 'completed').length,
      by_category: {},
      by_priority: {},
      overdue: 0,
    };

    for (const task of tasks) {
      const cat = task.category || 'general';
      stats.by_category[cat] = (stats.by_category[cat] || 0) + 1;

      const pri = task.priority || 'medium';
      stats.by_priority[pri] = (stats.by_priority[pri] || 0) + 1;

      if (task.deadline && task.deadline < now && task.status !== 'completed') {
        stats.overdue++;
      }
    }

    return stats;
  }

  /**
   * Convert SQLite row (snake_case) to task object (camelCase)
   *
   * @private
   */
  _rowToTask(row: Record<string, SQLOutputValue>): TaskDoc {
    return {
      id: asString(row.id),
      userId: asString(row.user_id),
      description: asString(row.description),
      steps: parseSteps(asString(row.steps)),
      category: asString(row.category),
      priority: asString(row.priority),
      deadline: asNumberOrNull(row.deadline),
      mode: asString(row.mode),
      status: asString(row.status),
      currentStep: asNumber(row.current_step),
      progress: asNumber(row.progress),
      createdAt: asNumber(row.created_at),
      updatedAt: asNumber(row.updated_at),
      lastWorkedAt: asNumberOrNull(row.last_worked_at),
    };
  }

  /**
   * Calculate progress percentage from a task object
   * @private
   * @returns Progress 0-100
   */
  _calculateProgress(task: TaskDoc): number {
    return this._calculateProgressFromSteps(task.steps || []);
  }

  /**
   * Calculate progress percentage from a steps array
   * @private
   * @returns Progress 0-100
   */
  _calculateProgressFromSteps(steps: Array<string | TaskStepInput | TaskStep>): number {
    if (!steps || steps.length === 0) return 0;
    const doneCount = steps.filter(s => typeof s !== 'string' && s.done).length;
    return Math.round((doneCount / steps.length) * 100);
  }

  /**
   * Close the database connection and checkpoint WAL.
   * Should be called on shutdown to ensure all changes are persisted.
   */
  close(): void {
    if (this.db) {
      try {
        // Force WAL checkpoint before closing
        this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        this.db.close();
        this.db = null;
        console.log('[tasks] SQLiteTaskStore closed');
      } catch (err) {
        console.error('[tasks] Error closing database:', err instanceof Error ? err.message : err);
      }
    }
  }
}

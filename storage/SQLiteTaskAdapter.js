import crypto from 'crypto';
import { DatabaseSync } from 'node:sqlite';
import { TaskStore } from './TaskStore.js';

/**
 * SQLite-backed TaskStore implementation
 *
 * Uses Node.js 22.5+ built-in sqlite module for zero-dependency task storage.
 * Dates stored as INTEGER (Unix ms), steps as JSON TEXT column.
 */
export class SQLiteTaskStore extends TaskStore {
  constructor() {
    super();
    this.db = null;
  }

  /**
   * Initialize SQLite task store
   *
   * @param {string} dbPath - Path to SQLite database file
   */
  async init(dbPath) {
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
   * @param {Object} params
   * @param {string} params.userId - Owner user ID
   * @param {string} params.description - Task description
   * @param {Array<string|Object>} [params.steps=[]] - Step descriptions or step objects
   * @param {string} [params.category='general'] - Task category
   * @param {string} [params.priority='medium'] - Priority: low, medium, high
   * @param {number|null} [params.deadline=null] - Unix ms deadline or null
   * @param {string} [params.mode='auto'] - Execution mode: auto or manual
   * @returns {Promise<Object>} Created task document
   */
  async createTask({ userId, description, steps = [], category = 'general', priority = 'medium', deadline = null, mode = 'auto' }) {
    if (!this.db) throw new Error('Tasks not initialized. Call init() first.');

    const normalizedSteps = steps.map(step => {
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
    const task = {
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
   * @param {string} userId - User ID
   * @param {Object} [filters={}] - Optional filters
   * @param {string} [filters.status] - Filter by status
   * @param {string} [filters.category] - Filter by category
   * @param {string} [filters.priority] - Filter by priority
   * @returns {Promise<Array>} Task list with computed progress
   */
  async getTasks(userId, filters = {}) {
    if (!this.db) throw new Error('Tasks not initialized. Call init() first.');

    let sql = 'SELECT * FROM tasks WHERE user_id = ?';
    const params = [userId];

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

    return rows.map(row => {
      const task = this._rowToTask(row);
      task.progress = this._calculateProgress(task);
      return task;
    });
  }

  /**
   * Get a single task by ID
   *
   * @param {string} userId - User ID
   * @param {string} taskId - Task UUID
   * @returns {Promise<Object|null>} Task document or null
   */
  async getTask(userId, taskId) {
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
   * @param {string} userId - User ID
   * @param {string} taskId - Task UUID
   * @param {Object} updates - Fields to update
   * @returns {Promise<Object>} Result with changes count
   */
  async updateTask(userId, taskId, updates) {
    if (!this.db) throw new Error('Tasks not initialized. Call init() first.');

    const allowedFields = [
      'description', 'steps', 'category', 'priority', 'deadline',
      'mode', 'status', 'currentStep', 'lastWorkedAt'
    ];

    // Map camelCase to snake_case for SQL columns
    const fieldMap = {
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

    const setClauses = [];
    const values = [];

    for (const field of allowedFields) {
      if (updates[field] !== undefined) {
        const col = fieldMap[field];
        setClauses.push(`${col} = ?`);
        if (field === 'steps') {
          values.push(JSON.stringify(updates[field]));
        } else {
          values.push(updates[field]);
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
   * @param {string} userId - User ID
   * @param {string} taskId - Task UUID
   * @returns {Promise<Object>} Result with deletedCount
   */
  async deleteTask(userId, taskId) {
    if (!this.db) throw new Error('Tasks not initialized. Call init() first.');

    const stmt = this.db.prepare('DELETE FROM tasks WHERE id = ? AND user_id = ?');
    const result = stmt.run(taskId, userId);

    return { deletedCount: result.changes };
  }

  /**
   * Search tasks by description or step text (case-insensitive LIKE)
   *
   * @param {string} userId - User ID
   * @param {string} query - Search text
   * @returns {Promise<Array>} Matching tasks with computed progress
   */
  async searchTasks(userId, query) {
    if (!this.db) throw new Error('Tasks not initialized. Call init() first.');

    const pattern = `%${query}%`;
    const stmt = this.db.prepare(`
      SELECT * FROM tasks
      WHERE user_id = ? AND (description LIKE ? OR steps LIKE ?)
      ORDER BY created_at DESC
    `);

    const rows = stmt.all(userId, pattern, pattern);

    return rows.map(row => {
      const task = this._rowToTask(row);
      task.progress = this._calculateProgress(task);
      return task;
    });
  }

  /**
   * Get aggregate task statistics for a user
   *
   * @param {string} userId - User ID
   * @returns {Promise<Object>} Stats object with totals, breakdowns, and overdue count
   */
  async getTaskStats(userId) {
    if (!this.db) throw new Error('Tasks not initialized. Call init() first.');

    const stmt = this.db.prepare('SELECT * FROM tasks WHERE user_id = ?');
    const rows = stmt.all(userId);
    const tasks = rows.map(row => this._rowToTask(row));

    const now = Date.now();
    const stats = {
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
   * @param {Object} row - Raw SQLite row
   * @returns {Object} Task object with parsed steps and camelCase keys
   */
  _rowToTask(row) {
    return {
      id: row.id,
      userId: row.user_id,
      description: row.description,
      steps: JSON.parse(row.steps),
      category: row.category,
      priority: row.priority,
      deadline: row.deadline,
      mode: row.mode,
      status: row.status,
      currentStep: row.current_step,
      progress: row.progress,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastWorkedAt: row.last_worked_at,
    };
  }

  /**
   * Calculate progress percentage from a task object
   * @private
   * @param {Object} task - Task with steps array
   * @returns {number} Progress 0-100
   */
  _calculateProgress(task) {
    return this._calculateProgressFromSteps(task.steps || []);
  }

  /**
   * Calculate progress percentage from a steps array
   * @private
   * @param {Array} steps - Steps array
   * @returns {number} Progress 0-100
   */
  _calculateProgressFromSteps(steps) {
    if (!steps || steps.length === 0) return 0;
    const doneCount = steps.filter(s => s.done).length;
    return Math.round((doneCount / steps.length) * 100);
  }

  /**
   * Close the database connection and checkpoint WAL.
   * Should be called on shutdown to ensure all changes are persisted.
   */
  close() {
    if (this.db) {
      try {
        // Force WAL checkpoint before closing
        this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        this.db.close();
        this.db = null;
        console.log('[tasks] SQLiteTaskStore closed');
      } catch (err) {
        console.error('[tasks] Error closing database:', err.message);
      }
    }
  }
}

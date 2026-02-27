import crypto from 'crypto';
import { DatabaseSync } from 'node:sqlite';
import { GoalStore } from './GoalStore.js';

/**
 * SQLite-backed GoalStore implementation
 *
 * Uses Node.js 22.5+ built-in sqlite module for zero-dependency goal storage.
 * Dates stored as INTEGER (Unix ms), steps as JSON TEXT column.
 */
export class SQLiteGoalStore extends GoalStore {
  constructor() {
    super();
    this.db = null;
  }

  /**
   * Initialize SQLite goal store
   *
   * @param {Object} config - Configuration object
   * @param {string} config.dbPath - Path to SQLite database file
   */
  async init({ dbPath }) {
    this.db = new DatabaseSync(dbPath);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS goals (
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

      CREATE INDEX IF NOT EXISTS idx_goals_user_status ON goals(user_id, status);
      CREATE INDEX IF NOT EXISTS idx_goals_user_category ON goals(user_id, category);
      CREATE INDEX IF NOT EXISTS idx_goals_user_priority ON goals(user_id, priority);
      CREATE INDEX IF NOT EXISTS idx_goals_user_deadline ON goals(user_id, deadline);
    `);

    console.log('[goals] SQLiteGoalStore initialized');
  }

  /**
   * Create a new goal
   *
   * @param {Object} params
   * @param {string} params.userId - Owner user ID
   * @param {string} params.description - Goal description
   * @param {Array<string|Object>} [params.steps=[]] - Step descriptions or step objects
   * @param {string} [params.category='general'] - Goal category
   * @param {string} [params.priority='medium'] - Priority: low, medium, high
   * @param {number|null} [params.deadline=null] - Unix ms deadline or null
   * @param {string} [params.mode='auto'] - Execution mode: auto or manual
   * @returns {Promise<Object>} Created goal document
   */
  async createGoal({ userId, description, steps = [], category = 'general', priority = 'medium', deadline = null, mode = 'auto' }) {
    if (!this.db) throw new Error('Goals not initialized. Call init() first.');

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
    const goal = {
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
      INSERT INTO goals (id, user_id, description, steps, category, priority, deadline, mode, status, current_step, progress, created_at, updated_at, last_worked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      goal.id,
      goal.userId,
      goal.description,
      JSON.stringify(goal.steps),
      goal.category,
      goal.priority,
      goal.deadline,
      goal.mode,
      goal.status,
      goal.currentStep,
      goal.progress,
      goal.createdAt,
      goal.updatedAt,
      goal.lastWorkedAt
    );

    return goal;
  }

  /**
   * Get goals for a user, optionally filtered by status/category/priority
   *
   * @param {string} userId - User ID
   * @param {Object} [filters={}] - Optional filters
   * @param {string} [filters.status] - Filter by status
   * @param {string} [filters.category] - Filter by category
   * @param {string} [filters.priority] - Filter by priority
   * @returns {Promise<Array>} Goal list with computed progress
   */
  async getGoals(userId, filters = {}) {
    if (!this.db) throw new Error('Goals not initialized. Call init() first.');

    let sql = 'SELECT * FROM goals WHERE user_id = ?';
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
      const goal = this._rowToGoal(row);
      goal.progress = this._calculateProgress(goal);
      return goal;
    });
  }

  /**
   * Get a single goal by ID
   *
   * @param {string} userId - User ID
   * @param {string} goalId - Goal UUID
   * @returns {Promise<Object|null>} Goal document or null
   */
  async getGoal(userId, goalId) {
    if (!this.db) throw new Error('Goals not initialized. Call init() first.');

    const stmt = this.db.prepare('SELECT * FROM goals WHERE id = ? AND user_id = ?');
    const row = stmt.get(goalId, userId);

    if (!row) return null;

    const goal = this._rowToGoal(row);
    goal.progress = this._calculateProgress(goal);
    return goal;
  }

  /**
   * Update a goal with allowed fields
   *
   * @param {string} userId - User ID
   * @param {string} goalId - Goal UUID
   * @param {Object} updates - Fields to update
   * @returns {Promise<Object>} Result with changes count
   */
  async updateGoal(userId, goalId, updates) {
    if (!this.db) throw new Error('Goals not initialized. Call init() first.');

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

    const sql = `UPDATE goals SET ${setClauses.join(', ')} WHERE id = ? AND user_id = ?`;
    values.push(goalId, userId);

    const stmt = this.db.prepare(sql);
    const result = stmt.run(...values);

    return { changes: result.changes };
  }

  /**
   * Delete a goal
   *
   * @param {string} userId - User ID
   * @param {string} goalId - Goal UUID
   * @returns {Promise<Object>} Result with deletedCount
   */
  async deleteGoal(userId, goalId) {
    if (!this.db) throw new Error('Goals not initialized. Call init() first.');

    const stmt = this.db.prepare('DELETE FROM goals WHERE id = ? AND user_id = ?');
    const result = stmt.run(goalId, userId);

    return { deletedCount: result.changes };
  }

  /**
   * Search goals by description or step text (case-insensitive LIKE)
   *
   * @param {string} userId - User ID
   * @param {string} query - Search text
   * @returns {Promise<Array>} Matching goals with computed progress
   */
  async searchGoals(userId, query) {
    if (!this.db) throw new Error('Goals not initialized. Call init() first.');

    const pattern = `%${query}%`;
    const stmt = this.db.prepare(`
      SELECT * FROM goals
      WHERE user_id = ? AND (description LIKE ? OR steps LIKE ?)
      ORDER BY created_at DESC
    `);

    const rows = stmt.all(userId, pattern, pattern);

    return rows.map(row => {
      const goal = this._rowToGoal(row);
      goal.progress = this._calculateProgress(goal);
      return goal;
    });
  }

  /**
   * Get aggregate goal statistics for a user
   *
   * @param {string} userId - User ID
   * @returns {Promise<Object>} Stats object with totals, breakdowns, and overdue count
   */
  async getGoalStats(userId) {
    if (!this.db) throw new Error('Goals not initialized. Call init() first.');

    const stmt = this.db.prepare('SELECT * FROM goals WHERE user_id = ?');
    const rows = stmt.all(userId);
    const goals = rows.map(row => this._rowToGoal(row));

    const now = Date.now();
    const stats = {
      total: goals.length,
      pending: goals.filter(g => g.status === 'pending').length,
      in_progress: goals.filter(g => g.status === 'in_progress').length,
      completed: goals.filter(g => g.status === 'completed').length,
      by_category: {},
      by_priority: {},
      overdue: 0,
    };

    for (const goal of goals) {
      const cat = goal.category || 'general';
      stats.by_category[cat] = (stats.by_category[cat] || 0) + 1;

      const pri = goal.priority || 'medium';
      stats.by_priority[pri] = (stats.by_priority[pri] || 0) + 1;

      if (goal.deadline && goal.deadline < now && goal.status !== 'completed') {
        stats.overdue++;
      }
    }

    return stats;
  }

  /**
   * Convert SQLite row (snake_case) to goal object (camelCase)
   *
   * @private
   * @param {Object} row - Raw SQLite row
   * @returns {Object} Goal object with parsed steps and camelCase keys
   */
  _rowToGoal(row) {
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
   * Calculate progress percentage from a goal object
   * @private
   * @param {Object} goal - Goal with steps array
   * @returns {number} Progress 0-100
   */
  _calculateProgress(goal) {
    return this._calculateProgressFromSteps(goal.steps || []);
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
   */
  close() {
    if (this.db) {
      try {
        this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        this.db.close();
        this.db = null;
        console.log('[goals] SQLiteGoalStore closed');
      } catch (err) {
        console.error('[goals] Error closing database:', err.message);
      }
    }
  }
}

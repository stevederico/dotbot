import { ObjectId } from 'mongodb';
import { GoalStore } from './GoalStore.js';

/**
 * MongoDB implementation of GoalStore
 */
export class MongoGoalStore extends GoalStore {
  constructor() {
    super();
    this.collection = null;
  }

  /**
   * Initialize MongoDB goal store
   *
   * @param {import('mongodb').Db} db - MongoDB database instance
   * @param {Object} options - Optional configuration
   */
  async init(db, options = {}) {
    this.collection = db.collection('goals');

    // Create indexes
    await this.collection.createIndex({ userId: 1, status: 1 }).catch(() => {});
    await this.collection.createIndex({ userId: 1, category: 1 }).catch(() => {});
    await this.collection.createIndex({ userId: 1, priority: 1 }).catch(() => {});
    await this.collection.createIndex({ userId: 1, deadline: 1 }).catch(() => {});

    console.log('[goals] MongoGoalStore initialized');
  }

  /**
   * Create a new goal
   */
  async createGoal({ userId, description, steps = [], category = 'general', priority = 'medium', deadline = null, mode = 'auto' }) {
    // Normalize steps to objects
    const normalizedSteps = steps.map(step => {
      if (typeof step === 'string') {
        return {
          text: step,
          action: step,  // Default action is same as text
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

    const doc = {
      userId,
      description,
      steps: normalizedSteps,
      category,
      priority,
      deadline,
      mode,  // 'auto' or 'manual'
      status: 'pending',  // pending, in_progress, completed
      currentStep: 0,
      progress: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastWorkedAt: null,
    };

    const result = await this.collection.insertOne(doc);
    return { ...doc, _id: result.insertedId };
  }

  /**
   * Get goals for a user
   */
  async getGoals(userId, filters = {}) {
    const query = { userId };

    if (filters.status) query.status = filters.status;
    if (filters.category) query.category = filters.category;
    if (filters.priority) query.priority = filters.priority;

    const goals = await this.collection
      .find(query)
      .sort({ createdAt: -1 })
      .toArray();

    // Calculate progress for each goal
    return goals.map(goal => ({
      ...goal,
      progress: this._calculateProgress(goal),
    }));
  }

  /**
   * Get a single goal by ID
   */
  async getGoal(userId, goalId) {
    const goal = await this.collection.findOne({
      _id: new ObjectId(goalId),
      userId,
    });

    if (!goal) return null;

    return {
      ...goal,
      progress: this._calculateProgress(goal),
    };
  }

  /**
   * Update a goal
   */
  async updateGoal(userId, goalId, updates) {
    const validUpdates = {};
    const allowedFields = [
      'description', 'steps', 'category', 'priority', 'deadline',
      'mode', 'status', 'currentStep', 'lastWorkedAt'
    ];

    for (const field of allowedFields) {
      if (updates[field] !== undefined) {
        validUpdates[field] = updates[field];
      }
    }

    // Recalculate progress if steps changed
    if (updates.steps) {
      validUpdates.progress = this._calculateProgressFromSteps(updates.steps);
    }

    validUpdates.updatedAt = new Date();

    const result = await this.collection.updateOne(
      { _id: new ObjectId(goalId), userId },
      { $set: validUpdates }
    );

    return result;
  }

  /**
   * Delete a goal
   */
  async deleteGoal(userId, goalId) {
    const result = await this.collection.deleteOne({
      _id: new ObjectId(goalId),
      userId,
    });
    return result;
  }

  /**
   * Search goals by text
   */
  async searchGoals(userId, query) {
    const regex = new RegExp(query, 'i');
    const goals = await this.collection
      .find({
        userId,
        $or: [
          { description: regex },
          { 'steps.text': regex },
        ],
      })
      .sort({ createdAt: -1 })
      .toArray();

    return goals.map(goal => ({
      ...goal,
      progress: this._calculateProgress(goal),
    }));
  }

  /**
   * Get goal statistics
   */
  async getGoalStats(userId) {
    const goals = await this.collection.find({ userId }).toArray();

    const stats = {
      total: goals.length,
      pending: goals.filter(g => g.status === 'pending').length,
      in_progress: goals.filter(g => g.status === 'in_progress').length,
      completed: goals.filter(g => g.status === 'completed').length,
      by_category: {},
      by_priority: {},
      overdue: 0,
    };

    const now = new Date();

    for (const goal of goals) {
      // Count by category
      const cat = goal.category || 'general';
      stats.by_category[cat] = (stats.by_category[cat] || 0) + 1;

      // Count by priority
      const pri = goal.priority || 'medium';
      stats.by_priority[pri] = (stats.by_priority[pri] || 0) + 1;

      // Count overdue
      if (goal.deadline && new Date(goal.deadline) < now && goal.status !== 'completed') {
        stats.overdue++;
      }
    }

    return stats;
  }

  /**
   * Calculate progress percentage from goal
   * @private
   */
  _calculateProgress(goal) {
    return this._calculateProgressFromSteps(goal.steps || []);
  }

  /**
   * Calculate progress percentage from steps array
   * @private
   */
  _calculateProgressFromSteps(steps) {
    if (!steps || steps.length === 0) return 0;
    const doneCount = steps.filter(s => s.done).length;
    return Math.round((doneCount / steps.length) * 100);
  }
}

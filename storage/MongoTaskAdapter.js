import { TaskStore } from './TaskStore.js';

// Lazy-load mongodb to avoid hard dependency at module evaluation time
let _ObjectId = null;
async function getObjectId() {
  if (!_ObjectId) { _ObjectId = (await import('mongodb')).ObjectId; }
  return _ObjectId;
}

/**
 * MongoDB implementation of TaskStore
 */
export class MongoTaskStore extends TaskStore {
  constructor() {
    super();
    this.collection = null;
  }

  /**
   * Initialize MongoDB task store
   *
   * @param {import('mongodb').Db} db - MongoDB database instance
   * @param {Object} options - Optional configuration
   */
  async init(db, options = {}) {
    this.collection = db.collection('tasks');

    // Create indexes
    await this.collection.createIndex({ userId: 1, status: 1 }).catch(() => {});
    await this.collection.createIndex({ userId: 1, category: 1 }).catch(() => {});
    await this.collection.createIndex({ userId: 1, priority: 1 }).catch(() => {});
    await this.collection.createIndex({ userId: 1, deadline: 1 }).catch(() => {});

    console.log('[tasks] MongoTaskStore initialized');
  }

  /**
   * Create a new task
   */
  async createTask({ userId, description, steps = [], category = 'general', priority = 'medium', deadline = null, mode = 'auto' }) {
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
   * Get tasks for a user
   */
  async getTasks(userId, filters = {}) {
    const query = { userId };

    if (filters.status) query.status = filters.status;
    if (filters.category) query.category = filters.category;
    if (filters.priority) query.priority = filters.priority;

    const tasks = await this.collection
      .find(query)
      .sort({ createdAt: -1 })
      .toArray();

    // Calculate progress for each task
    return tasks.map(task => ({
      ...task,
      progress: this._calculateProgress(task),
    }));
  }

  /**
   * Get a single task by ID
   */
  async getTask(userId, taskId) {
    const ObjectId = await getObjectId();
    const task = await this.collection.findOne({
      _id: new ObjectId(taskId),
      userId,
    });

    if (!task) return null;

    return {
      ...task,
      progress: this._calculateProgress(task),
    };
  }

  /**
   * Update a task
   */
  async updateTask(userId, taskId, updates) {
    const ObjectId = await getObjectId();
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
      { _id: new ObjectId(taskId), userId },
      { $set: validUpdates }
    );

    return result;
  }

  /**
   * Delete a task
   */
  async deleteTask(userId, taskId) {
    const ObjectId = await getObjectId();
    const result = await this.collection.deleteOne({
      _id: new ObjectId(taskId),
      userId,
    });
    return result;
  }

  /**
   * Search tasks by text
   */
  async searchTasks(userId, query) {
    const regex = new RegExp(query, 'i');
    const tasks = await this.collection
      .find({
        userId,
        $or: [
          { description: regex },
          { 'steps.text': regex },
        ],
      })
      .sort({ createdAt: -1 })
      .toArray();

    return tasks.map(task => ({
      ...task,
      progress: this._calculateProgress(task),
    }));
  }

  /**
   * Get task statistics
   */
  async getTaskStats(userId) {
    const tasks = await this.collection.find({ userId }).toArray();

    const stats = {
      total: tasks.length,
      pending: tasks.filter(g => g.status === 'pending').length,
      in_progress: tasks.filter(g => g.status === 'in_progress').length,
      completed: tasks.filter(g => g.status === 'completed').length,
      by_category: {},
      by_priority: {},
      overdue: 0,
    };

    const now = new Date();

    for (const task of tasks) {
      // Count by category
      const cat = task.category || 'general';
      stats.by_category[cat] = (stats.by_category[cat] || 0) + 1;

      // Count by priority
      const pri = task.priority || 'medium';
      stats.by_priority[pri] = (stats.by_priority[pri] || 0) + 1;

      // Count overdue
      if (task.deadline && new Date(task.deadline) < now && task.status !== 'completed') {
        stats.overdue++;
      }
    }

    return stats;
  }

  /**
   * Calculate progress percentage from task
   * @private
   */
  _calculateProgress(task) {
    return this._calculateProgressFromSteps(task.steps || []);
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

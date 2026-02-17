import { CronStore } from './CronStore.js';

/** Max heartbeats processed in parallel per poll cycle */
const HEARTBEAT_CONCURRENCY = 5;

/** Heartbeat interval in milliseconds (15 minutes) */
const HEARTBEAT_INTERVAL_MS = 15 * 60 * 1000;

/** The current heartbeat prompt — defines proactive agent behavior */
const HEARTBEAT_PROMPT = "Review your active goals and take action on the highest priority one. Use tools to make real progress — search for information, execute tasks, send notifications. If no goals exist, check memories for pending tasks. IMPORTANT: If you have nothing actionable, respond with exactly 'No action needed.' and nothing else. Do NOT ask if help is needed. Do NOT summarize status. Either take meaningful action or stay silent.";

/**
 * Run an array of async functions with a concurrency limit
 *
 * @param {Array<Function>} fns - Async functions to execute
 * @param {number} limit - Max concurrent executions
 */
async function runWithConcurrency(fns, limit) {
  const executing = new Set();
  for (const fn of fns) {
    const p = fn().finally(() => executing.delete(p));
    executing.add(p);
    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }
  await Promise.all(executing);
}

/**
 * Parse a human-friendly interval string to milliseconds
 *
 * @param {string} str - Interval string e.g. "5m", "2h", "1d", "1w"
 * @returns {number|null} Milliseconds or null if invalid
 */
function parseInterval(str) {
  const match = str.match(/^(\d+)\s*(s|m|h|d|w)$/i);
  if (!match) return null;
  const num = parseInt(match[1]);
  const unit = match[2].toLowerCase();
  const multipliers = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 };
  return num * multipliers[unit];
}

/**
 * MongoDB-backed CronStore implementation
 */
export class MongoCronStore extends CronStore {
  constructor() {
    super();
    this.collection = null;
    this.onTaskFire = null;
    this.pollInterval = null;
  }

  /**
   * Initialize MongoDB cron store
   *
   * @param {import('mongodb').Db} db - MongoDB database instance
   * @param {Object} options
   * @param {Function} options.onTaskFire - Callback when a task fires: (task) => Promise<void>
   */
  async init(db, options = {}) {
    this.collection = db.collection('cron_tasks');
    this.onTaskFire = options.onTaskFire;

    await this.collection.createIndex({ nextRunAt: 1 }).catch(() => {});
    await this.collection.createIndex({ sessionId: 1 }).catch(() => {});
    await this.collection.createIndex({ userId: 1, name: 1 }).catch(() => {});

    // Deduplicate existing heartbeats before adding the unique index
    const dupes = await this.collection.aggregate([
      { $match: { name: 'heartbeat', enabled: true, userId: { $exists: true } } },
      { $sort: { createdAt: -1 } },
      { $group: { _id: '$userId', ids: { $push: '$_id' }, count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
    ]).toArray();
    if (dupes.length > 0) {
      const idsToRemove = dupes.flatMap(d => d.ids.slice(1));
      const result = await this.collection.deleteMany({ _id: { $in: idsToRemove } });
      console.log(`[cron] cleaned up ${result.deletedCount} duplicate heartbeat(s) for ${dupes.length} user(s)`);
    }

    // One enabled heartbeat per user — enforced at DB level
    await this.collection.createIndex(
      { userId: 1, name: 1, enabled: 1 },
      { unique: true, partialFilterExpression: { name: 'heartbeat', enabled: true } }
    ).catch(() => {});

    // Start polling every 30 seconds
    this.pollInterval = setInterval(() => this.checkTasks(), 30 * 1000);
    // Also check immediately on startup
    await this.checkTasks();

    console.log('[cron] initialized with MongoDB, polling every 30s');
  }

  stop() {
    if (this.pollInterval) clearInterval(this.pollInterval);
  }

  /**
   * Check for tasks that are due and fire them
   */
  async checkTasks() {
    if (!this.collection || !this.onTaskFire) return;

    try {
      const now = new Date();

      const dueTasks = await this.collection
        .find({ nextRunAt: { $lte: now }, enabled: true })
        .toArray();

      if (dueTasks.length === 0) return;

      const heartbeats = dueTasks.filter(t => t.name === 'heartbeat');
      const others = dueTasks.filter(t => t.name !== 'heartbeat');

      /** Process a single task: fire callback, then update schedule */
      const processTask = async (task) => {
        try {
          await this.onTaskFire(task);
          if (task.recurring && task.intervalMs) {
            const nextRun = new Date(now.getTime() + task.intervalMs);
            await this.collection.updateOne(
              { _id: task._id },
              { $set: { nextRunAt: nextRun, lastRunAt: now } }
            );
          } else {
            await this.collection.updateOne(
              { _id: task._id },
              { $set: { enabled: false, lastRunAt: now } }
            );
          }
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

      // Other tasks (user-scheduled) run sequentially
      for (const task of others) {
        await processTask(task);
      }
    } catch (err) {
      console.error(`[cron] checkTasks query failed:`, err.message);
    }
  }

  async createTask({ name, prompt, sessionId, userId, runAt, intervalMs, recurring, goalId }) {
    const task = {
      name,
      prompt,
      sessionId: sessionId || 'default',
      nextRunAt: new Date(runAt),
      intervalMs: intervalMs || null,
      recurring: recurring || false,
      enabled: true,
      createdAt: new Date(),
      lastRunAt: null,
    };
    if (userId) task.userId = userId;
    if (goalId) task.goalId = goalId;

    const result = await this.collection.insertOne(task);
    return { id: result.insertedId, ...task };
  }

  async listTasks(sessionId) {
    return await this.collection
      .find({ sessionId: sessionId || 'default' })
      .sort({ nextRunAt: 1 })
      .toArray()
      .then((docs) =>
        docs.map((d) => ({
          id: d._id.toString(),
          name: d.name,
          prompt: d.prompt,
          nextRunAt: d.nextRunAt,
          recurring: d.recurring,
          intervalMs: d.intervalMs,
          enabled: d.enabled,
          lastRunAt: d.lastRunAt,
        }))
      );
  }

  async listTasksBySessionIds(sessionIds, userId = null) {
    if (!this.collection || sessionIds.length === 0) return [];
    const query = { sessionId: { $in: [...sessionIds, 'default'] } };
    if (userId) {
      query.$or = [
        { userId: userId },
        { userId: { $exists: false } },
        { userId: null }
      ];
    }
    return await this.collection
      .find(query)
      .sort({ nextRunAt: 1 })
      .toArray()
      .then(docs => docs.map(d => ({
        id: d._id.toString(),
        name: d.name,
        prompt: d.prompt,
        sessionId: d.sessionId,
        nextRunAt: d.nextRunAt,
        recurring: d.recurring,
        intervalMs: d.intervalMs,
        enabled: d.enabled,
        lastRunAt: d.lastRunAt,
        createdAt: d.createdAt,
      })));
  }

  async getTask(id) {
    const { ObjectId } = await import('mongodb');
    const task = await this.collection.findOne({ _id: new ObjectId(id) });
    if (!task) return null;
    return {
      id: task._id.toString(),
      name: task.name,
      prompt: task.prompt,
      sessionId: task.sessionId,
      nextRunAt: task.nextRunAt,
      recurring: task.recurring,
      intervalMs: task.intervalMs,
      enabled: task.enabled,
      lastRunAt: task.lastRunAt,
      createdAt: task.createdAt,
    };
  }

  async deleteTask(id) {
    const { ObjectId } = await import('mongodb');
    return await this.collection.deleteOne({ _id: new ObjectId(id) });
  }

  async toggleTask(id, enabled) {
    const { ObjectId } = await import('mongodb');
    return await this.collection.updateOne(
      { _id: new ObjectId(id) },
      { $set: { enabled } }
    );
  }

  async updateTask(id, updates) {
    const { ObjectId } = await import('mongodb');
    const updateFields = {};
    if (updates.name !== undefined) updateFields.name = updates.name;
    if (updates.prompt !== undefined) updateFields.prompt = updates.prompt;
    if (updates.runAt !== undefined) updateFields.nextRunAt = new Date(updates.runAt);
    if (updates.intervalMs !== undefined) updateFields.intervalMs = updates.intervalMs;
    if (updates.recurring !== undefined) updateFields.recurring = updates.recurring;

    return await this.collection.updateOne(
      { _id: new ObjectId(id) },
      { $set: updateFields }
    );
  }

  async ensureHeartbeat(userId) {
    if (!this.collection || !userId) {
      console.log(`[cron] ensureHeartbeat skipped: collection=${!!this.collection}, userId=${userId}`);
      return null;
    }

    const jitter = Math.floor(Math.random() * HEARTBEAT_INTERVAL_MS);
    const now = new Date();

    // Atomic upsert — eliminates race conditions
    const result = await this.collection.updateOne(
      { userId, name: 'heartbeat', enabled: true },
      {
        $setOnInsert: {
          name: 'heartbeat',
          prompt: HEARTBEAT_PROMPT,
          userId,
          sessionId: 'default',
          nextRunAt: new Date(now.getTime() + jitter),
          intervalMs: HEARTBEAT_INTERVAL_MS,
          recurring: true,
          enabled: true,
          createdAt: now,
          lastRunAt: null,
        },
      },
      { upsert: true }
    );

    if (result.upsertedId) {
      console.log(`[cron] created heartbeat for user ${userId}, first run in ${Math.round(jitter / 60000)}m`);
      return { id: result.upsertedId };
    }

    // Auto-update stale prompt
    const existing = await this.collection.findOne({ userId, name: 'heartbeat', enabled: true });
    if (existing && existing.prompt !== HEARTBEAT_PROMPT) {
      await this.collection.updateOne({ _id: existing._id }, { $set: { prompt: HEARTBEAT_PROMPT } });
      console.log(`[cron] updated heartbeat prompt for user ${userId}`);
    }

    return null;
  }

  async getHeartbeatStatus(userId) {
    if (!this.collection || !userId) return null;
    const task = await this.collection.findOne({ userId, name: 'heartbeat' });
    if (!task) return null;
    return {
      id: task._id.toString(),
      enabled: task.enabled,
      nextRunAt: task.nextRunAt,
      lastRunAt: task.lastRunAt,
      createdAt: task.createdAt,
      intervalMs: task.intervalMs,
      prompt: task.prompt,
    };
  }

  async resetHeartbeat(userId) {
    if (!this.collection || !userId) return null;

    // Delete existing heartbeat(s)
    await this.collection.deleteMany({ userId, name: 'heartbeat' });
    console.log(`[cron] deleted existing heartbeat(s) for user ${userId}`);

    // Create fresh heartbeat
    const jitter = Math.floor(Math.random() * HEARTBEAT_INTERVAL_MS);
    const now = new Date();
    const task = {
      name: 'heartbeat',
      prompt: HEARTBEAT_PROMPT,
      userId,
      sessionId: 'default',
      nextRunAt: new Date(now.getTime() + jitter),
      intervalMs: HEARTBEAT_INTERVAL_MS,
      recurring: true,
      enabled: true,
      createdAt: now,
      lastRunAt: null,
    };
    const result = await this.collection.insertOne(task);
    console.log(`[cron] created new heartbeat for user ${userId}, first run in ${Math.round(jitter / 60000)}m`);
    return { id: result.insertedId, ...task };
  }

  async triggerHeartbeatNow(userId) {
    if (!this.collection || !userId || !this.onTaskFire) return false;

    const heartbeat = await this.collection.findOne({ userId, name: 'heartbeat', enabled: true });
    if (!heartbeat) {
      console.log(`[cron] manual trigger failed: no enabled heartbeat for user ${userId}`);
      return false;
    }

    console.log(`[cron] manually triggering heartbeat for user ${userId}`);
    try {
      await this.onTaskFire(heartbeat);
      await this.collection.updateOne(
        { _id: heartbeat._id },
        { $set: { lastRunAt: new Date() } }
      );
      return true;
    } catch (err) {
      console.error(`[cron] manual trigger error:`, err.message);
      return false;
    }
  }
}

// Export utility functions for tool definitions
export { parseInterval, HEARTBEAT_INTERVAL_MS, HEARTBEAT_PROMPT };

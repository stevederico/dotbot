import { TriggerStore } from './TriggerStore.js';

// Lazy-load mongodb to avoid hard dependency at module evaluation time
let _ObjectId = null;
async function getObjectId() {
  if (!_ObjectId) { _ObjectId = (await import('mongodb')).ObjectId; }
  return _ObjectId;
}

/**
 * MongoDB implementation of TriggerStore
 */
export class MongoTriggerStore extends TriggerStore {
  constructor() {
    super();
    this.collection = null;
  }

  /**
   * Initialize MongoDB trigger store
   *
   * @param {import('mongodb').Db} db - MongoDB database instance
   * @param {Object} options - Optional configuration
   */
  async init(db, options = {}) {
    this.collection = db.collection('triggers');

    // Create indexes
    await this.collection.createIndex({ userId: 1, eventType: 1 }).catch(() => {});
    await this.collection.createIndex({ userId: 1, enabled: 1 }).catch(() => {});

    console.log('[triggers] MongoTriggerStore initialized');
  }

  /**
   * Create an event trigger
   */
  async createTrigger({ userId, eventType, prompt, cooldownMs = 0, metadata = {}, enabled = true }) {
    const doc = {
      userId,
      eventType,
      prompt,
      cooldownMs,
      metadata,
      enabled,
      lastFiredAt: null,
      fireCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await this.collection.insertOne(doc);
    return { ...doc, _id: result.insertedId };
  }

  /**
   * List triggers for a user
   */
  async listTriggers(userId, filters = {}) {
    const query = { userId };

    if (filters.enabled !== undefined) {
      query.enabled = filters.enabled;
    }
    if (filters.eventType) {
      query.eventType = filters.eventType;
    }

    return await this.collection
      .find(query)
      .sort({ createdAt: -1 })
      .toArray();
  }

  /**
   * Find enabled triggers matching userId and eventType, filtering out
   * those still within cooldown period
   */
  async findMatchingTriggers(userId, eventType, metadata = {}) {
    const now = Date.now();

    // Find all enabled triggers for this user and event type
    const triggers = await this.collection
      .find({ userId, eventType, enabled: true })
      .toArray();

    // Filter by cooldown
    const activeTriggers = triggers.filter(trigger => {
      // No cooldown → always active
      if (!trigger.cooldownMs) return true;

      // Never fired → active
      if (!trigger.lastFiredAt) return true;

      // Check if cooldown period has passed
      const lastFiredTime = new Date(trigger.lastFiredAt).getTime();
      return (lastFiredTime + trigger.cooldownMs) <= now;
    });

    // Filter by metadata if trigger has metadata requirements
    const matchedTriggers = activeTriggers.filter(trigger => {
      if (!trigger.metadata || Object.keys(trigger.metadata).length === 0) {
        return true;  // No metadata requirements
      }

      // Check if event metadata matches trigger metadata
      for (const [key, value] of Object.entries(trigger.metadata)) {
        if (metadata[key] !== value) return false;
      }
      return true;
    });

    return matchedTriggers;
  }

  /**
   * Toggle a trigger on/off
   */
  async toggleTrigger(userId, triggerId, enabled) {
    const ObjectId = await getObjectId();
    const result = await this.collection.updateOne(
      { _id: new ObjectId(triggerId), userId },
      {
        $set: {
          enabled,
          updatedAt: new Date()
        }
      }
    );
    return result;
  }

  /**
   * Delete a trigger
   */
  async deleteTrigger(userId, triggerId) {
    const ObjectId = await getObjectId();
    const result = await this.collection.deleteOne({
      _id: new ObjectId(triggerId),
      userId,
    });
    return result;
  }

  /**
   * Record that a trigger has fired
   */
  async markTriggerFired(triggerId) {
    const ObjectId = await getObjectId();
    await this.collection.updateOne(
      { _id: new ObjectId(triggerId) },
      {
        $set: { lastFiredAt: new Date() },
        $inc: { fireCount: 1 }
      }
    );
  }
}

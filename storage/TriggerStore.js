/**
 * TriggerStore Interface
 *
 * Abstract interface for event trigger storage. Implementations must provide
 * all methods defined here.
 */
export class TriggerStore {
  /**
   * Initialize the trigger store
   *
   * @param {Object} db - Database instance (implementation-specific)
   * @param {Object} options - Store-specific initialization options
   */
  async init(db, options = {}) {
    throw new Error('TriggerStore.init() must be implemented');
  }

  /**
   * Create an event trigger
   *
   * @param {Object} params
   * @param {string} params.userId - Owner user ID
   * @param {string} params.eventType - Event type to trigger on
   * @param {string} params.prompt - Prompt to inject when event fires
   * @param {number} [params.cooldownMs] - Cooldown period in milliseconds
   * @param {Object} [params.metadata] - Additional metadata (e.g., appName for app_opened events)
   * @param {boolean} [params.enabled] - Whether trigger is enabled (default: true)
   * @returns {Promise<Object>} Created trigger document
   */
  async createTrigger({ userId, eventType, prompt, cooldownMs, metadata, enabled }) {
    throw new Error('TriggerStore.createTrigger() must be implemented');
  }

  /**
   * List triggers for a user
   *
   * @param {string} userId - User ID
   * @param {Object} filters - Optional filters (enabled, eventType, etc.)
   * @returns {Promise<Array>} Trigger list
   */
  async listTriggers(userId, filters = {}) {
    throw new Error('TriggerStore.listTriggers() must be implemented');
  }

  /**
   * Find enabled triggers matching userId and eventType, filtering out
   * those still within cooldown period
   *
   * @param {string} userId - User ID
   * @param {string} eventType - Event type to match
   * @param {Object} metadata - Event metadata for matching (e.g., { appName: 'Mail' })
   * @returns {Promise<Array>} Matching trigger documents
   */
  async findMatchingTriggers(userId, eventType, metadata = {}) {
    throw new Error('TriggerStore.findMatchingTriggers() must be implemented');
  }

  /**
   * Toggle a trigger on/off
   *
   * @param {string} userId - User ID
   * @param {string} triggerId - Trigger document ID
   * @param {boolean} enabled - Whether to enable or disable
   * @returns {Promise<Object>} Update result
   */
  async toggleTrigger(userId, triggerId, enabled) {
    throw new Error('TriggerStore.toggleTrigger() must be implemented');
  }

  /**
   * Delete a trigger
   *
   * @param {string} userId - User ID
   * @param {string} triggerId - Trigger document ID
   * @returns {Promise<Object>} Delete result
   */
  async deleteTrigger(userId, triggerId) {
    throw new Error('TriggerStore.deleteTrigger() must be implemented');
  }

  /**
   * Record that a trigger has fired by updating its lastFiredAt timestamp
   *
   * @param {string} triggerId - Trigger document ID
   * @returns {Promise<void>}
   */
  async markTriggerFired(triggerId) {
    throw new Error('TriggerStore.markTriggerFired() must be implemented');
  }
}

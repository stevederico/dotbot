/**
 * EventStore Interface
 *
 * Abstract interface for event/analytics storage. Implementations must provide
 * all methods defined here.
 */
export class EventStore {
  /**
   * Initialize the event store
   *
   * @param {Object} db - Database instance (implementation-specific)
   * @param {Object} options - Store-specific initialization options
   */
  async init(db, options = {}) {
    throw new Error('EventStore.init() must be implemented');
  }

  /**
   * Log an event
   *
   * @param {Object} params
   * @param {string} params.userId - User ID
   * @param {string} params.type - Event type (message_sent, message_received, tool_call, task_created, task_completed, trigger_fired)
   * @param {Object} [params.data] - Event-specific data (e.g., { tool: 'web_search' })
   * @param {number} [params.timestamp] - Unix ms timestamp (defaults to now)
   * @returns {Promise<Object>} Created event document
   */
  async logEvent({ userId, type, data, timestamp }) {
    throw new Error('EventStore.logEvent() must be implemented');
  }

  /**
   * Query events with filters
   *
   * @param {Object} params
   * @param {string} params.userId - User ID
   * @param {string} [params.type] - Filter by event type
   * @param {string} [params.startDate] - ISO date start (inclusive)
   * @param {string} [params.endDate] - ISO date end (inclusive)
   * @param {number} [params.limit=100] - Max results
   * @returns {Promise<Array>} Matching events
   */
  async query({ userId, type, startDate, endDate, limit }) {
    throw new Error('EventStore.query() must be implemented');
  }

  /**
   * Get aggregated usage statistics
   *
   * @param {Object} params
   * @param {string} params.userId - User ID
   * @param {string} [params.startDate] - ISO date start
   * @param {string} [params.endDate] - ISO date end
   * @param {string} [params.groupBy='type'] - Group by: type, day, week, month
   * @returns {Promise<Object>} Summary statistics
   */
  async summary({ userId, startDate, endDate, groupBy }) {
    throw new Error('EventStore.summary() must be implemented');
  }

  /**
   * Delete events older than a given date
   *
   * @param {string} userId - User ID
   * @param {string} beforeDate - ISO date cutoff
   * @returns {Promise<Object>} Delete result with count
   */
  async deleteOldEvents(userId, beforeDate) {
    throw new Error('EventStore.deleteOldEvents() must be implemented');
  }
}

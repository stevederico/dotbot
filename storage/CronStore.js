/**
 * CronStore Interface
 *
 * Abstract interface for scheduled task storage. Implementations must provide
 * all methods defined here.
 */
export class CronStore {
  /**
   * Initialize the cron store
   *
   * @param {Object} options - Store-specific initialization options
   * @param {Function} options.onTaskFire - Callback when a task fires: (task) => Promise<void>
   */
  async init(options = {}) {
    throw new Error('CronStore.init() must be implemented');
  }

  /**
   * Stop the cron polling loop
   */
  stop() {
    throw new Error('CronStore.stop() must be implemented');
  }

  /**
   * Create a scheduled task
   *
   * @param {Object} params
   * @param {string} params.name - Short task name
   * @param {string} params.prompt - Message to inject when task fires
   * @param {string} [params.sessionId] - Session to inject into
   * @param {string} [params.userId] - Owner user ID
   * @param {string} params.runAt - ISO 8601 datetime for first run
   * @param {number} [params.intervalMs] - Repeat interval in milliseconds
   * @param {boolean} [params.recurring] - Whether task repeats
   * @param {string} [params.taskId] - Associated task ID
   * @returns {Promise<Object>} Created task document
   */
  async createTask({ name, prompt, sessionId, userId, runAt, intervalMs, recurring, taskId }) {
    throw new Error('CronStore.createTask() must be implemented');
  }

  /**
   * List tasks for a session
   *
   * @param {string} [sessionId] - Session ID to filter by
   * @returns {Promise<Array>} Task list sorted by next run time
   */
  async listTasks(sessionId) {
    throw new Error('CronStore.listTasks() must be implemented');
  }

  /**
   * List tasks for multiple session IDs
   *
   * @param {string[]} sessionIds - Array of session IDs
   * @param {string} [userId] - User ID to filter by
   * @returns {Promise<Array>} Task list sorted by next run time
   */
  async listTasksBySessionIds(sessionIds, userId) {
    throw new Error('CronStore.listTasksBySessionIds() must be implemented');
  }

  /**
   * Get a task by ID
   *
   * @param {string} id - Task document ID
   * @returns {Promise<Object|null>} Task document or null
   */
  async getTask(id) {
    throw new Error('CronStore.getTask() must be implemented');
  }

  /**
   * Delete a task by its ID
   *
   * @param {string} id - Task document ID
   * @returns {Promise<any>} Delete result
   */
  async deleteTask(id) {
    throw new Error('CronStore.deleteTask() must be implemented');
  }

  /**
   * Toggle a task's enabled/disabled state
   *
   * @param {string} id - Task document ID
   * @param {boolean} enabled - Whether the task should be enabled
   * @returns {Promise<any>} Update result
   */
  async toggleTask(id, enabled) {
    throw new Error('CronStore.toggleTask() must be implemented');
  }

  /**
   * Update a task's details
   *
   * @param {string} id - Task document ID
   * @param {Object} updates - Fields to update
   * @returns {Promise<any>} Update result
   */
  async updateTask(id, updates) {
    throw new Error('CronStore.updateTask() must be implemented');
  }

  /**
   * Ensure a single recurring heartbeat task exists for a user
   *
   * @param {string} userId - User ID
   * @returns {Promise<Object|null>} Created task or null if already exists
   */
  async ensureHeartbeat(userId) {
    throw new Error('CronStore.ensureHeartbeat() must be implemented');
  }

  /**
   * Get heartbeat status for a user
   *
   * @param {string} userId - User ID
   * @returns {Promise<Object|null>} Heartbeat task or null
   */
  async getHeartbeatStatus(userId) {
    throw new Error('CronStore.getHeartbeatStatus() must be implemented');
  }

  /**
   * Reset/update an existing heartbeat to use the latest prompt
   *
   * @param {string} userId - User ID
   * @returns {Promise<Object|null>} New heartbeat task or null
   */
  async resetHeartbeat(userId) {
    throw new Error('CronStore.resetHeartbeat() must be implemented');
  }

  /**
   * Manually trigger the heartbeat task immediately
   *
   * @param {string} userId - User ID
   * @returns {Promise<boolean>} True if heartbeat was fired
   */
  async triggerHeartbeatNow(userId) {
    throw new Error('CronStore.triggerHeartbeatNow() must be implemented');
  }
}

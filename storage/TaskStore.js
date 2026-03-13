/**
 * TaskStore Interface
 *
 * Abstract interface for task storage. Implementations must provide
 * all methods defined here.
 */
export class TaskStore {
  /**
   * Initialize the task store
   *
   * @param {Object} db - Database instance (implementation-specific)
   * @param {Object} options - Store-specific initialization options
   */
  async init(db, options = {}) {
    throw new Error('TaskStore.init() must be implemented');
  }

  /**
   * Create a new task
   *
   * @param {Object} params
   * @param {string} params.userId - Owner user ID
   * @param {string} params.description - Task description
   * @param {Array<string|Object>} params.steps - Array of step descriptions or step objects
   * @param {string} [params.category] - Category (e.g., fitness, learning, productivity)
   * @param {string} [params.priority] - Priority: low, medium, high
   * @param {string} [params.deadline] - ISO 8601 deadline
   * @param {string} [params.mode] - Execution mode: manual or auto
   * @returns {Promise<Object>} Created task document
   */
  async createTask({ userId, description, steps, category, priority, deadline, mode }) {
    throw new Error('TaskStore.createTask() must be implemented');
  }

  /**
   * Get tasks for a user
   *
   * @param {string} userId - User ID
   * @param {Object} filters - Optional filters (status, category, etc.)
   * @returns {Promise<Array>} Task list
   */
  async getTasks(userId, filters = {}) {
    throw new Error('TaskStore.getTasks() must be implemented');
  }

  /**
   * Get a single task by ID
   *
   * @param {string} userId - User ID
   * @param {string} taskId - Task document ID
   * @returns {Promise<Object|null>} Task document or null
   */
  async getTask(userId, taskId) {
    throw new Error('TaskStore.getTask() must be implemented');
  }

  /**
   * Update a task
   *
   * @param {string} userId - User ID
   * @param {string} taskId - Task document ID
   * @param {Object} updates - Fields to update
   * @returns {Promise<Object>} Update result
   */
  async updateTask(userId, taskId, updates) {
    throw new Error('TaskStore.updateTask() must be implemented');
  }

  /**
   * Delete a task
   *
   * @param {string} userId - User ID
   * @param {string} taskId - Task document ID
   * @returns {Promise<Object>} Delete result
   */
  async deleteTask(userId, taskId) {
    throw new Error('TaskStore.deleteTask() must be implemented');
  }

  /**
   * Search tasks by text
   *
   * @param {string} userId - User ID
   * @param {string} query - Search query
   * @returns {Promise<Array>} Matching tasks
   */
  async searchTasks(userId, query) {
    throw new Error('TaskStore.searchTasks() must be implemented');
  }

  /**
   * Get task statistics
   *
   * @param {string} userId - User ID
   * @returns {Promise<Object>} Stats (total, completed, in_progress, etc.)
   */
  async getTaskStats(userId) {
    throw new Error('TaskStore.getTaskStats() must be implemented');
  }
}

/**
 * GoalStore Interface
 *
 * Abstract interface for goal storage. Implementations must provide
 * all methods defined here.
 */
export class GoalStore {
  /**
   * Initialize the goal store
   *
   * @param {Object} db - Database instance (implementation-specific)
   * @param {Object} options - Store-specific initialization options
   */
  async init(db, options = {}) {
    throw new Error('GoalStore.init() must be implemented');
  }

  /**
   * Create a new goal
   *
   * @param {Object} params
   * @param {string} params.userId - Owner user ID
   * @param {string} params.description - Goal description
   * @param {Array<string|Object>} params.steps - Array of step descriptions or step objects
   * @param {string} [params.category] - Category (e.g., fitness, learning, productivity)
   * @param {string} [params.priority] - Priority: low, medium, high
   * @param {string} [params.deadline] - ISO 8601 deadline
   * @param {string} [params.mode] - Execution mode: manual or auto
   * @returns {Promise<Object>} Created goal document
   */
  async createGoal({ userId, description, steps, category, priority, deadline, mode }) {
    throw new Error('GoalStore.createGoal() must be implemented');
  }

  /**
   * Get goals for a user
   *
   * @param {string} userId - User ID
   * @param {Object} filters - Optional filters (status, category, etc.)
   * @returns {Promise<Array>} Goal list
   */
  async getGoals(userId, filters = {}) {
    throw new Error('GoalStore.getGoals() must be implemented');
  }

  /**
   * Get a single goal by ID
   *
   * @param {string} userId - User ID
   * @param {string} goalId - Goal document ID
   * @returns {Promise<Object|null>} Goal document or null
   */
  async getGoal(userId, goalId) {
    throw new Error('GoalStore.getGoal() must be implemented');
  }

  /**
   * Update a goal
   *
   * @param {string} userId - User ID
   * @param {string} goalId - Goal document ID
   * @param {Object} updates - Fields to update
   * @returns {Promise<Object>} Update result
   */
  async updateGoal(userId, goalId, updates) {
    throw new Error('GoalStore.updateGoal() must be implemented');
  }

  /**
   * Delete a goal
   *
   * @param {string} userId - User ID
   * @param {string} goalId - Goal document ID
   * @returns {Promise<Object>} Delete result
   */
  async deleteGoal(userId, goalId) {
    throw new Error('GoalStore.deleteGoal() must be implemented');
  }

  /**
   * Search goals by text
   *
   * @param {string} userId - User ID
   * @param {string} query - Search query
   * @returns {Promise<Array>} Matching goals
   */
  async searchGoals(userId, query) {
    throw new Error('GoalStore.searchGoals() must be implemented');
  }

  /**
   * Get goal statistics
   *
   * @param {string} userId - User ID
   * @returns {Promise<Object>} Stats (total, completed, in_progress, etc.)
   */
  async getGoalStats(userId) {
    throw new Error('GoalStore.getGoalStats() must be implemented');
  }
}

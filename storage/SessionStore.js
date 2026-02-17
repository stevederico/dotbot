/**
 * SessionStore Interface
 *
 * Abstract interface for session storage backends. Implementations must provide
 * all methods defined here.
 */
export class SessionStore {
  /**
   * Initialize the session store
   *
   * @param {Object} options - Store-specific initialization options
   * @param {Function} [options.prefsFetcher] - Async function (userId) => { agentName, agentPersonality }
   * @param {Function} [options.systemPromptBuilder] - Function ({ agentName, agentPersonality }) => string
   * @param {Function} [options.heartbeatEnsurer] - Async function (userId) => Promise<Object|null>
   */
  async init(options = {}) {
    throw new Error('SessionStore.init() must be implemented');
  }

  /**
   * Create a new session for a user
   *
   * @param {string} owner - User ID who owns this session
   * @param {string} [model] - Initial model name
   * @param {string} [provider] - AI provider ID
   * @returns {Promise<Object>} Newly created session document
   */
  async createSession(owner, model, provider) {
    throw new Error('SessionStore.createSession() must be implemented');
  }

  /**
   * Get a session by its UUID, verifying ownership
   *
   * @param {string} sessionId - Session UUID
   * @param {string} owner - User ID (for ownership verification)
   * @returns {Promise<Object|null>} Session document or null
   */
  async getSession(sessionId, owner) {
    throw new Error('SessionStore.getSession() must be implemented');
  }

  /**
   * Get a session by ID without ownership check (for internal/cron use)
   *
   * @param {string} sessionId - Session UUID
   * @returns {Promise<Object|null>} Session document or null
   */
  async getSessionInternal(sessionId) {
    throw new Error('SessionStore.getSessionInternal() must be implemented');
  }

  /**
   * Get the most recent session for a user, or create one if none exist
   *
   * @param {string} owner - User ID
   * @returns {Promise<Object>} Session document
   */
  async getOrCreateDefaultSession(owner) {
    throw new Error('SessionStore.getOrCreateDefaultSession() must be implemented');
  }

  /**
   * Save messages back to storage after agent loop
   *
   * @param {string} sessionId - Session UUID
   * @param {Array} messages - Full conversation history
   * @param {string} model - Current model name
   * @param {string} [provider] - AI provider ID
   */
  async saveSession(sessionId, messages, model, provider) {
    throw new Error('SessionStore.saveSession() must be implemented');
  }

  /**
   * Add a single message to a session and persist
   *
   * @param {string} sessionId - Session UUID
   * @param {Object} message - Message object with role and content
   * @returns {Promise<Object>} Updated session
   */
  async addMessage(sessionId, message) {
    throw new Error('SessionStore.addMessage() must be implemented');
  }

  /**
   * Set the model for a session
   *
   * @param {string} sessionId - Session UUID
   * @param {string} model - Model name
   */
  async setModel(sessionId, model) {
    throw new Error('SessionStore.setModel() must be implemented');
  }

  /**
   * Set the AI provider for a session
   *
   * @param {string} sessionId - Session UUID
   * @param {string} provider - Provider ID
   */
  async setProvider(sessionId, provider) {
    throw new Error('SessionStore.setProvider() must be implemented');
  }

  /**
   * Clear a session's conversation history (keeps system prompt)
   *
   * @param {string} sessionId - Session UUID
   */
  async clearSession(sessionId) {
    throw new Error('SessionStore.clearSession() must be implemented');
  }

  /**
   * List all sessions for a user with summary info
   *
   * @param {string} owner - User ID
   * @returns {Promise<Array>} Session summaries sorted by last update
   */
  async listSessions(owner) {
    throw new Error('SessionStore.listSessions() must be implemented');
  }

  /**
   * Delete a session by ID, verifying ownership
   *
   * @param {string} sessionId - Session UUID
   * @param {string} owner - User ID (for ownership verification)
   * @returns {Promise<any>} Delete result
   */
  async deleteSession(sessionId, owner) {
    throw new Error('SessionStore.deleteSession() must be implemented');
  }

  /**
   * Trim messages if conversation is too long
   *
   * @param {Array} messages - Full message array
   * @param {number} [maxMessages] - Maximum messages to keep
   * @returns {Array} Trimmed message array
   */
  trimMessages(messages, maxMessages = 40) {
    if (messages.length <= maxMessages) return messages;
    const system = messages[0];
    const recent = messages.slice(-(maxMessages - 1));
    return [system, ...recent];
  }
}

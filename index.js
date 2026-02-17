/**
 * DotBot Agent Library
 *
 * Framework-agnostic AI agent system with tool execution, session management,
 * and scheduled tasks.
 */

// Import tool arrays for use in createAgent()
import {
  coreTools,
  memoryTools,
  webTools,
  codeTools,
  fileTools,
  messageTools,
  imageTools,
  weatherTools,
  notifyTools,
  createBrowserTools,
  goalTools,
  triggerTools,
} from './tools/index.js';

// Export core abstractions
export {
  SessionStore,
  SQLiteSessionStore,
  MongoSessionStore,
  MemorySessionStore,
  defaultSystemPrompt,
  CronStore,
  MongoCronStore,
  parseInterval,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_PROMPT,
  GoalStore,
  MongoGoalStore,
  TriggerStore,
  MongoTriggerStore,
} from './storage/index.js';

// Export tool system
export {
  createToolRegistry,
  coreTools,
  memoryTools,
  webTools,
  codeTools,
  fileTools,
  messageTools,
  imageTools,
  weatherTools,
  notifyTools,
  browserTools,
  createBrowserTools,
  goalTools,
  triggerTools,
} from './tools/index.js';

// Export provider configuration
export { AI_PROVIDERS } from './utils/providers.js';

// Export agent loop (already well-abstracted)
export { agentLoop } from './core/agent.js';

// Export compaction utilities
export { compactMessages, estimateTokens } from './core/compaction.js';

// Export message normalization
export { toStandardFormat, toProviderFormat, normalizeMessages } from './core/normalize.js';

// Export event system
export { validateEvent, normalizeStatsEvent } from './core/events.js';

/**
 * Create an agent instance with configurable stores, providers, and tools
 *
 * @param {Object} options - Configuration options
 * @param {SessionStore} options.sessionStore - Session storage backend
 * @param {Object} options.providers - Provider API keys: { anthropic: { apiKey }, openai: { apiKey }, xai: { apiKey }, ollama: { baseUrl } }
 * @param {Function} [options.systemPrompt] - System prompt builder: (agentName, agentPersonality, timestamp) => string
 * @param {Array} [options.tools] - Tool definitions (defaults to coreTools)
 * @param {CronStore} [options.cronStore] - Optional cron storage backend for scheduled tasks
 * @param {GoalStore} [options.goalStore] - Optional goal storage backend for multi-step autonomous execution
 * @param {TriggerStore} [options.triggerStore] - Optional trigger storage backend for event-driven responses
 * @param {Function} [options.screenshotUrlPattern] - Screenshot URL pattern: (filename) => URL string
 * @param {Object} [options.compaction] - Compaction settings: { enabled: true, ... }
 * @returns {Object} Agent API
 */
export function createAgent({
  sessionStore,
  providers = {},
  systemPrompt,
  tools = coreTools,
  cronStore = null,
  goalStore = null,
  triggerStore = null,
  screenshotUrlPattern = (filename) => `/screenshots/${filename}`,
  compaction = { enabled: true },
} = {}) {
  if (!sessionStore) {
    throw new Error('createAgent() requires a sessionStore (SessionStore instance)');
  }

  // If custom screenshotUrlPattern provided, rebuild browser tools
  let finalTools = tools;
  if (screenshotUrlPattern && tools === coreTools) {
    // Replace default browser tools with customized ones
    const customBrowserTools = createBrowserTools(screenshotUrlPattern);
    finalTools = [
      ...memoryTools,
      ...webTools,
      ...codeTools,
      ...fileTools,
      ...messageTools,
      ...imageTools,
      ...weatherTools,
      ...notifyTools,
      ...customBrowserTools,
      ...goalTools,
      ...triggerTools,
    ];
  }

  return {
    /**
     * Run agent chat loop with streaming
     *
     * @param {Object} params
     * @param {string} params.sessionId - Session UUID
     * @param {string} params.message - User message
     * @param {string} params.provider - AI provider ID
     * @param {string} params.model - Model name
     * @param {AbortSignal} [params.signal] - Abort signal
     * @param {Object} [params.context] - Tool execution context
     * @returns {AsyncGenerator} SSE event stream
     */
    async* chat({ sessionId, message, provider, model, signal, context = {} }) {
      // Get session
      const session = await sessionStore.getSessionInternal(sessionId);
      if (!session) throw new Error(`Session ${sessionId} not found`);

      // Inject providers and stores into context
      const enhancedContext = {
        ...context,
        providers,
        cronStore,
        goalStore,
        triggerStore,
      };

      // Run agent loop
      const generator = agentLoop({
        session,
        userMessage: message,
        tools: finalTools,
        provider,
        model,
        signal,
        context: enhancedContext,
        compaction: { ...compaction, providers },
      });

      // Stream events and save session on completion
      let finalMessages = session.messages;
      let finalModel = model;
      let finalProvider = provider;

      for await (const event of generator) {
        yield event;
        if (event.type === 'done' && event.messages) {
          finalMessages = event.messages;
          if (event.model) finalModel = event.model;
          if (event.provider) finalProvider = event.provider;
        }
      }

      // Save session after loop completes
      await sessionStore.saveSession(sessionId, finalMessages, finalModel, finalProvider);
    },

    /**
     * Create a new session
     *
     * @param {string} owner - User ID
     * @param {string} [model] - Initial model
     * @param {string} [provider] - Initial provider
     * @returns {Promise<Object>} Session document
     */
    async createSession(owner, model, provider) {
      return await sessionStore.createSession(owner, model, provider);
    },

    /**
     * Get a session by ID
     *
     * @param {string} sessionId - Session UUID
     * @param {string} owner - User ID
     * @returns {Promise<Object|null>} Session document
     */
    async getSession(sessionId, owner) {
      return await sessionStore.getSession(sessionId, owner);
    },

    /**
     * List sessions for a user
     *
     * @param {string} owner - User ID
     * @returns {Promise<Array>} Session summaries
     */
    async listSessions(owner) {
      return await sessionStore.listSessions(owner);
    },

    /**
     * Delete a session
     *
     * @param {string} sessionId - Session UUID
     * @param {string} owner - User ID
     * @returns {Promise<any>} Delete result
     */
    async deleteSession(sessionId, owner) {
      return await sessionStore.deleteSession(sessionId, owner);
    },

    /**
     * Clear session conversation history
     *
     * @param {string} sessionId - Session UUID
     */
    async clearSession(sessionId) {
      await sessionStore.clearSession(sessionId);
    },

    /**
     * Get registered tools
     *
     * @returns {Array} Tool definitions
     */
    getTools() {
      return finalTools;
    },

    /**
     * Get cron store (if configured)
     *
     * @returns {CronStore|null} Cron store instance
     */
    getCronStore() {
      return cronStore;
    },

    /**
     * Get goal store (if configured)
     *
     * @returns {GoalStore|null} Goal store instance
     */
    getGoalStore() {
      return goalStore;
    },

    /**
     * Get trigger store (if configured)
     *
     * @returns {TriggerStore|null} Trigger store instance
     */
    getTriggerStore() {
      return triggerStore;
    },
  };
}

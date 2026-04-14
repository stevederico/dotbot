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
  taskTools,
  triggerTools,
  jobTools,
  eventTools,
  appgenTools,
} from './tools/index.js';

// Export core abstractions
export {
  SessionStore,
  SQLiteSessionStore,
  MemorySessionStore,
  defaultSystemPrompt,
  CronStore,
  SQLiteCronStore,
  parseInterval,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_PROMPT,
  runWithConcurrency,
  TaskStore,
  SQLiteTaskStore,
  TriggerStore,
  SQLiteTriggerStore,
  SQLiteMemoryStore,
  EventStore,
  SQLiteEventStore,
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
  taskTools,
  triggerTools,
  jobTools,
  eventTools,
  appgenTools,
} from './tools/index.js';

// Export provider configuration
import { AI_PROVIDERS } from './utils/providers.js';
export { AI_PROVIDERS };

// Import and export agent loop
import { agentLoop } from './core/agent.js';
export { agentLoop };

// Export compaction utilities
export { compactMessages, estimateTokens } from './core/compaction.js';

// Export message normalization
export { toStandardFormat, toProviderFormat, normalizeMessages } from './core/normalize.js';

// Export event system
export { validateEvent, normalizeStatsEvent } from './core/events.js';

// Export unified initialization
export { init } from './core/init.js';

// Export handler factories for advanced use cases
export { createCronHandler } from './core/cron_handler.js';
export { createTriggerHandler } from './core/trigger_handler.js';

/**
 * Build a default system prompt from parts
 *
 * @param {Object} options
 * @param {string} [options.agentName] - Agent name (default: 'Assistant')
 * @param {string} [options.userName] - User's name
 * @param {string} [options.agentPersonality] - Personality/tone description
 * @param {string} [options.userContext] - Additional user context
 * @param {string} [options.memories] - Remembered facts
 * @param {string} [options.timestamp] - Current timestamp
 * @returns {string} Formatted system prompt
 */
export function buildSystemPrompt({ agentName = 'Assistant', userName, agentPersonality, userContext, memories, timestamp } = {}) {
  const parts = [];
  let identity = `You are a helpful personal AI assistant called ${agentName}.`;
  if (userName) identity += `\nYou are speaking with ${userName}.`;
  if (agentPersonality) identity += `\nYour personality and tone: ${agentPersonality}.`;
  identity += `\nKeep responses concise. Use markdown for formatting.`;
  identity += `\nAfter your response, optionally add: <followup>suggested next message</followup>`;
  identity += `\nRespond directly — no preambles.`;
  parts.push(identity);
  if (userContext) parts.push(`## User Context\n\n${userContext}`);
  if (memories) parts.push(`## Remembered Facts\n\n${memories}`);
  if (timestamp) parts.push(`## Current Time\n\n${timestamp}`);
  return parts.join('\n\n---\n\n');
}

/**
 * Create an agent instance with configurable stores, providers, and tools
 *
 * @param {Object} options - Configuration options
 * @param {SessionStore} options.sessionStore - Session storage backend
 * @param {Object} options.providers - Provider API keys: { anthropic: { apiKey }, openai: { apiKey }, xai: { apiKey }, ollama: { baseUrl } }
 * @param {Function} [options.systemPrompt] - System prompt builder: (agentName, agentPersonality, timestamp) => string
 * @param {Array} [options.tools] - Tool definitions (defaults to coreTools)
 * @param {CronStore} [options.cronStore] - Optional cron storage backend for scheduled tasks
 * @param {TaskStore} [options.taskStore] - Optional task storage backend for multi-step autonomous execution
 * @param {TriggerStore} [options.triggerStore] - Optional trigger storage backend for event-driven responses
 * @param {SQLiteMemoryStore} [options.memoryStore] - Optional memory storage backend for long-term memory
 * @param {EventStore} [options.eventStore] - Optional event storage backend for usage analytics
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
  taskStore = null,
  triggerStore = null,
  memoryStore = null,
  eventStore = null,
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
      ...taskTools,
      ...triggerTools,
      ...jobTools,
      ...eventTools,
      ...appgenTools,
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
        taskStore,
        triggerStore,
        memoryStore,
        eventStore,
      };

      const resolvedProvider = this.resolveProvider(provider);

      // Run agent loop
      const generator = agentLoop({
        session,
        userMessage: message,
        tools: finalTools,
        provider: resolvedProvider,
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
     * Run agent chat loop with raw messages (no session management)
     *
     * @param {Object} params
     * @param {Array} params.messages - Full message array
     * @param {string|Object} params.provider - AI provider ID or config
     * @param {string} params.model - Model name
     * @param {AbortSignal} [params.signal] - Abort signal
     * @param {Object} [params.context] - Tool execution context
     * @param {number} [params.maxTurns] - Max agent loop turns
     * @returns {AsyncGenerator} SSE event stream
     */
    async* chatRaw({ messages, provider, model, signal, context = {}, maxTurns, tools: overrideTools }) {
      const enhancedContext = {
        ...context,
        providers,
        cronStore,
        taskStore,
        triggerStore,
        memoryStore,
        eventStore,
      };

      const resolvedProvider = this.resolveProvider(provider);

      const generator = agentLoop({
        messages,
        tools: overrideTools || finalTools,
        provider: resolvedProvider,
        model,
        signal,
        context: enhancedContext,
        maxTurns,
      });

      for await (const event of generator) {
        yield event;
      }
    },

    /**
     * Resolve a provider string ID to a full provider config with API key
     *
     * @param {string|Object} providerIdOrConfig - Provider ID string or config object
     * @returns {Object|string} Resolved provider config
     */
    resolveProvider(providerIdOrConfig) {
      if (typeof providerIdOrConfig !== 'string') return providerIdOrConfig;
      const base = AI_PROVIDERS[providerIdOrConfig];
      if (!base) return providerIdOrConfig;
      const apiKey = providers[providerIdOrConfig]?.apiKey;
      return apiKey ? { ...base, headers: () => base.headers(apiKey) } : base;
    },

    /**
     * Filter tools based on permission grants
     *
     * @param {Array} tools - Tool definitions to filter
     * @param {Object} [options]
     * @param {Object} [options.permissions] - Permission grants: { scope: true/false }
     * @returns {Array} Filtered tools
     */
    filterTools(tools, { permissions = {} } = {}) {
      return tools.filter(tool => {
        if (!tool.requiresPermission) return true;
        return permissions[tool.requiresPermission] === true;
      });
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
     * Get task store (if configured)
     *
     * @returns {TaskStore|null} Task store instance
     */
    getTaskStore() {
      return taskStore;
    },

    /**
     * Get trigger store (if configured)
     *
     * @returns {TriggerStore|null} Trigger store instance
     */
    getTriggerStore() {
      return triggerStore;
    },

    /**
     * Get memory store (if configured)
     *
     * @returns {SQLiteMemoryStore|null} Memory store instance
     */
    getMemoryStore() {
      return memoryStore;
    },

    /**
     * Get event store (if configured)
     *
     * @returns {EventStore|null} Event store instance
     */
    getEventStore() {
      return eventStore;
    },
  };
}

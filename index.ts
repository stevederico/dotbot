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

import type {
  AgentContext,
  AgentEvent,
  CronStore,
  EventStore,
  MemoryStore,
  Message,
  Provider,
  ProvidersMap,
  Session,
  SessionStore,
  SessionSummary,
  TaskStore,
  ToolDefinition,
  TriggerStore,
} from './types.js';

/** Read an arbitrary property off an event object as unknown (no cast). */
function doneField(event: AgentEvent, key: string): unknown {
  const record: Record<string, unknown> = { ...event };
  return record[key];
}

/**
 * Narrow a resolved provider (string id | Provider config) to the Provider the
 * agent loop expects. resolveProvider() returns a Provider config for known ids
 * and echoes back the raw id string for unknown ones. The agent loop only
 * consumes a Provider object, so an unresolved id string is a misconfiguration:
 * surface it explicitly instead of letting an unusable string flow into the loop.
 */
function toLoopProvider(resolved: string | Provider): Provider {
  if (typeof resolved === 'string') {
    throw new Error(`Unknown provider: ${resolved}`);
  }
  return resolved;
}

/**
 * Type predicate: true when value is a non-empty array of role-bearing message
 * objects. Mirrors the original truthiness guard (`event.messages`) and lets us
 * read the agent loop's done-event payload (untyped on DoneEvent) without a cast.
 */
function isMessageArray(value: unknown): value is Message[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  for (const item of value) {
    if (typeof item !== 'object' || item === null) return false;
    if (!('role' in item) || typeof item.role !== 'string') return false;
  }
  return true;
}

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

/** Options for buildSystemPrompt(). */
export interface BuildSystemPromptOptions {
  /** Agent name (default: 'Assistant') */
  agentName?: string;
  /** User's name */
  userName?: string;
  /** Personality/tone description */
  agentPersonality?: string;
  /** Additional user context */
  userContext?: string;
  /** Remembered facts */
  memories?: string;
  /** Current timestamp */
  timestamp?: string;
}

/**
 * Build a default system prompt from parts
 */
export function buildSystemPrompt({ agentName = 'Assistant', userName, agentPersonality, userContext, memories, timestamp }: BuildSystemPromptOptions = {}): string {
  const parts: string[] = [];
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

/** Compaction settings passed to createAgent() and the agent loop. */
export interface CompactionConfig {
  enabled: boolean;
  [key: string]: unknown;
}

/** System prompt builder signature. */
export type SystemPromptBuilder = (
  agentName?: string,
  agentPersonality?: string,
  timestamp?: string,
) => string;

/** Configuration options for createAgent(). */
export interface CreateAgentOptions {
  /** Session storage backend */
  sessionStore: SessionStore;
  /** Provider API keys: { anthropic: { apiKey }, openai: { apiKey }, xai: { apiKey }, ollama: { baseUrl } } */
  providers?: ProvidersMap;
  /** System prompt builder: (agentName, agentPersonality, timestamp) => string */
  systemPrompt?: SystemPromptBuilder;
  /** Tool definitions (defaults to coreTools) */
  tools?: ToolDefinition[];
  /** Optional cron storage backend for scheduled tasks */
  cronStore?: CronStore | null;
  /** Optional task storage backend for multi-step autonomous execution */
  taskStore?: TaskStore | null;
  /** Optional trigger storage backend for event-driven responses */
  triggerStore?: TriggerStore | null;
  /** Optional memory storage backend for long-term memory */
  memoryStore?: MemoryStore | null;
  /** Optional event storage backend for usage analytics */
  eventStore?: EventStore | null;
  /** Screenshot URL pattern: (filename) => URL string */
  screenshotUrlPattern?: (filename: string) => string;
  /** Compaction settings: { enabled: true, ... } */
  compaction?: CompactionConfig;
}

/** Parameters for Agent.chat(). */
export interface ChatParams {
  /** Session UUID */
  sessionId: string;
  /** User message */
  message: string;
  /** AI provider ID */
  provider: string;
  /** Model name */
  model: string;
  /** Abort signal */
  signal?: AbortSignal;
  /** Tool execution context */
  context?: AgentContext;
}

/** Parameters for Agent.chatRaw(). */
export interface ChatRawParams {
  /** Full message array */
  messages: Message[];
  /** AI provider ID or config */
  provider: string | Provider;
  /** Model name */
  model: string;
  /** Abort signal */
  signal?: AbortSignal;
  /** Tool execution context */
  context?: AgentContext;
  /** Max agent loop turns */
  maxTurns?: number;
  /** Override tool set for this call */
  tools?: ToolDefinition[];
}

/** Permission grants for filterTools(). */
export interface FilterToolsOptions {
  permissions?: Record<string, boolean>;
}

/** The agent API returned by createAgent(). */
export interface Agent {
  chat(params: ChatParams): AsyncGenerator<AgentEvent, void, unknown>;
  chatRaw(params: ChatRawParams): AsyncGenerator<AgentEvent, void, unknown>;
  resolveProvider(providerIdOrConfig: string | Provider): string | Provider;
  filterTools(tools: ToolDefinition[], options?: FilterToolsOptions): ToolDefinition[];
  createSession(owner: string, model?: string, provider?: string): Promise<Session>;
  getSession(sessionId: string, owner: string): Promise<Session | null>;
  listSessions(owner: string): Promise<SessionSummary[]>;
  deleteSession(sessionId: string, owner: string): Promise<unknown>;
  clearSession(sessionId: string): Promise<void>;
  getTools(): ToolDefinition[];
  getCronStore(): CronStore | null;
  getTaskStore(): TaskStore | null;
  getTriggerStore(): TriggerStore | null;
  getMemoryStore(): MemoryStore | null;
  getEventStore(): EventStore | null;
}

/**
 * Create an agent instance with configurable stores, providers, and tools
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
  screenshotUrlPattern = (filename: string) => `/screenshots/${filename}`,
  compaction = { enabled: true },
}: CreateAgentOptions): Agent {
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

  const agent: Agent = {
    /**
     * Run agent chat loop with streaming
     */
    async* chat({ sessionId, message, provider, model, signal, context = {} }) {
      // Get session
      const session = await sessionStore.getSessionInternal(sessionId);
      if (!session) throw new Error(`Session ${sessionId} not found`);

      // Inject providers and stores into context
      const enhancedContext: AgentContext = {
        ...context,
        providers,
        cronStore,
        taskStore,
        triggerStore,
        memoryStore,
        eventStore,
      };

      const resolvedProvider = agent.resolveProvider(provider);

      // Run agent loop.
      // agentLoop reads `messages` (the session-mode extras session/userMessage/
      // compaction are ignored by it). Building the argument object as a
      // non-literal keeps those extras from tripping TS's excess-property check.
      const loopArgs = {
        session,
        userMessage: message,
        messages: session.messages,
        tools: finalTools,
        provider: toLoopProvider(resolvedProvider),
        model,
        signal,
        context: enhancedContext,
        compaction: { ...compaction, providers },
      };
      const generator = agentLoop(loopArgs);

      // Stream events and save session on completion
      let finalMessages: Message[] = session.messages;
      let finalModel = model;
      let finalProvider = provider;

      for await (const event of generator) {
        yield event;
        // The done event may carry updated session state (messages/model/
        // provider) that the typed DoneEvent does not declare; read defensively.
        if (event.type === 'done') {
          const doneMessages = doneField(event, 'messages');
          if (isMessageArray(doneMessages)) {
            finalMessages = doneMessages;
            const doneModel = doneField(event, 'model');
            if (typeof doneModel === 'string') finalModel = doneModel;
            const doneProvider = doneField(event, 'provider');
            if (typeof doneProvider === 'string') finalProvider = doneProvider;
          }
        }
      }

      // Save session after loop completes
      await sessionStore.saveSession(sessionId, finalMessages, finalModel, finalProvider);
    },

    /**
     * Run agent chat loop with raw messages (no session management)
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
        provider: toLoopProvider(resolvedProvider),
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
     */
    filterTools(tools, { permissions = {} } = {}) {
      return tools.filter(tool => {
        // requiresPermission is an optional, app-specific field not present on
        // the base ToolDefinition; read it defensively without a cast.
        const scope = ('requiresPermission' in tool && typeof tool.requiresPermission === 'string')
          ? tool.requiresPermission
          : undefined;
        if (!scope) return true;
        return permissions[scope] === true;
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

  return agent;
}

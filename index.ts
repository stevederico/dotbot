
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

function doneField(event: AgentEvent, key: string): unknown {
  const record: Record<string, unknown> = { ...event };
  return record[key];
}

function toLoopProvider(resolved: string | Provider): Provider {
  if (typeof resolved === 'string') {
    throw new Error(`Unknown provider: ${resolved}`);
  }
  return resolved;
}

function isMessageArray(value: unknown): value is Message[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  for (const item of value) {
    if (typeof item !== 'object' || item === null) return false;
    if (!('role' in item) || typeof item.role !== 'string') return false;
  }
  return true;
}

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

import { AI_PROVIDERS } from './utils/providers.js';
export { AI_PROVIDERS };

import { agentLoop } from './core/agent.js';
export { agentLoop };

export { compactMessages, estimateTokens } from './core/compaction.js';

export { toStandardFormat, toProviderFormat, normalizeMessages } from './core/normalize.js';

export { validateEvent, normalizeStatsEvent } from './core/events.js';

export { init } from './core/init.js';

export { createCronHandler } from './core/cron_handler.js';
export { createTriggerHandler } from './core/trigger_handler.js';

export interface BuildSystemPromptOptions {
  agentName?: string;
  userName?: string;
  agentPersonality?: string;
  userContext?: string;
  memories?: string;
  timestamp?: string;
}

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

export interface CompactionConfig {
  enabled: boolean;
  [key: string]: unknown;
}

export type SystemPromptBuilder = (
  agentName?: string,
  agentPersonality?: string,
  timestamp?: string,
) => string;

export interface CreateAgentOptions {
  sessionStore: SessionStore;
  providers?: ProvidersMap;
  systemPrompt?: SystemPromptBuilder;
  tools?: ToolDefinition[];
  cronStore?: CronStore | null;
  taskStore?: TaskStore | null;
  triggerStore?: TriggerStore | null;
  memoryStore?: MemoryStore | null;
  eventStore?: EventStore | null;
  screenshotUrlPattern?: (filename: string) => string;
  compaction?: CompactionConfig;
}

export interface ChatParams {
  sessionId: string;
  message: string;
  provider: string;
  model: string;
  signal?: AbortSignal;
  context?: AgentContext;
}

export interface ChatRawParams {
  messages: Message[];
  provider: string | Provider;
  model: string;
  signal?: AbortSignal;
  context?: AgentContext;
  maxTurns?: number;
  tools?: ToolDefinition[];
}

export interface FilterToolsOptions {
  permissions?: Record<string, boolean>;
}

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

  let finalTools = tools;
  if (screenshotUrlPattern && tools === coreTools) {
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
    async* chat({ sessionId, message, provider, model, signal, context = {} }) {
      const session = await sessionStore.getSessionInternal(sessionId);
      if (!session) throw new Error(`Session ${sessionId} not found`);

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

      let finalMessages: Message[] = session.messages;
      let finalModel = model;
      let finalProvider = provider;

      for await (const event of generator) {
        yield event;
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

      await sessionStore.saveSession(sessionId, finalMessages, finalModel, finalProvider);
    },

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

    resolveProvider(providerIdOrConfig) {
      if (typeof providerIdOrConfig !== 'string') return providerIdOrConfig;
      const base = AI_PROVIDERS[providerIdOrConfig];
      if (!base) return providerIdOrConfig;
      const apiKey = providers[providerIdOrConfig]?.apiKey;
      return apiKey ? { ...base, headers: () => base.headers(apiKey) } : base;
    },

    filterTools(tools, { permissions = {} } = {}) {
      return tools.filter(tool => {
        const scope = ('requiresPermission' in tool && typeof tool.requiresPermission === 'string')
          ? tool.requiresPermission
          : undefined;
        if (!scope) return true;
        return permissions[scope] === true;
      });
    },

    async createSession(owner, model, provider) {
      return await sessionStore.createSession(owner, model, provider);
    },

    async getSession(sessionId, owner) {
      return await sessionStore.getSession(sessionId, owner);
    },

    async listSessions(owner) {
      return await sessionStore.listSessions(owner);
    },

    async deleteSession(sessionId, owner) {
      return await sessionStore.deleteSession(sessionId, owner);
    },

    async clearSession(sessionId) {
      await sessionStore.clearSession(sessionId);
    },

    getTools() {
      return finalTools;
    },

    getCronStore() {
      return cronStore;
    },

    getTaskStore() {
      return taskStore;
    },

    getTriggerStore() {
      return triggerStore;
    },

    getMemoryStore() {
      return memoryStore;
    },

    getEventStore() {
      return eventStore;
    },
  };

  return agent;
}

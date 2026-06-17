/**
 * Unified initialization for dotbot.
 *
 * Provides a single entry point that creates and wires all stores, handlers,
 * and the agent instance. Host apps only need to provide hooks for host-specific
 * behavior (notifications, preferences).
 */

import { SQLiteSessionStore } from '../storage/SQLiteAdapter.js';
import { SQLiteCronStore } from '../storage/SQLiteCronAdapter.js';
import { SQLiteTaskStore } from '../storage/SQLiteTaskAdapter.js';
import { SQLiteTriggerStore } from '../storage/SQLiteTriggerAdapter.js';
import { SQLiteMemoryStore } from '../storage/SQLiteMemoryAdapter.js';
import { coreTools } from '../tools/index.js';
import { createCronHandler } from './cron_handler.js';
import { createTriggerHandler } from './trigger_handler.js';
import type {
  Agent,
  CronHandlerHooks,
  CronTaskHandler,
} from './cron_handler.js';
import type {
  ProvidersMap,
  ToolDefinition,
  MemoryStore,
  TaskStore,
  SessionStore,
} from '../types.js';

/**
 * System prompt builder supplied by the host. Forwarded verbatim to
 * createAgent(); its exact shape lives with the agent factory.
 */
export type SystemPromptBuilder = (...args: unknown[]) => string;

/** Screenshot URL pattern function: (filename) => URL string. */
export type ScreenshotUrlPattern = (filename: string) => string;

/** Compaction settings forwarded to createAgent(). */
export interface CompactionConfig {
  enabled: boolean;
  [key: string]: unknown;
}

/**
 * Host-supplied preference fetcher result and the broader hooks bag accepted
 * by init(). Cron-specific hooks are reused from the cron handler; the session
 * prefsFetcher is additional.
 */
export interface InitHooks extends CronHandlerHooks {
  /** async (userId) => { agentName, agentPersonality } */
  prefsFetcher?: (
    userId: string,
  ) => Promise<{ agentName?: string; agentPersonality?: string }>;
}

/** Configuration options for init(). */
export interface InitOptions {
  /**
   * Path to SQLite database file. Optional in the type so init() may be called
   * with no arguments (it throws at runtime when dbPath is missing), matching
   * the original JS contract.
   */
  dbPath?: string;
  /** If true, only initialize stores (no agent, cron, triggers). */
  storesOnly?: boolean;
  /** Custom session store (default: SQLiteSessionStore). */
  sessionStore?: SessionStore;
  /** Provider API keys: { anthropic: { apiKey }, openai: { apiKey }, xai: { apiKey } } */
  providers?: ProvidersMap;
  /** Tool definitions (default: coreTools). */
  tools?: ToolDefinition[];
  /** Skip heartbeat if user idle longer than this (default: 24h). */
  staleThresholdMs?: number;
  /** Title used when cron/trigger handlers dispatch notifications. */
  notificationTitle?: string;
  /** System prompt builder function. */
  systemPrompt?: SystemPromptBuilder;
  /** Screenshot URL pattern function. */
  screenshotUrlPattern?: ScreenshotUrlPattern;
  /** Compaction settings. */
  compaction?: CompactionConfig;
  /** Host-specific hooks. */
  hooks?: InitHooks;
}

/** Bundle of initialized stores returned by init(). */
export interface InitStores {
  task: SQLiteTaskStore;
  trigger: SQLiteTriggerStore;
  memory: SQLiteMemoryStore;
  session?: SessionStore;
  cron?: SQLiteCronStore;
}

/** Trigger executor returned by init() (full mode only). */
export type FireTrigger = ReturnType<typeof createTriggerHandler>;

/** Result of a stores-only init(). */
export interface StoresOnlyResult {
  stores: InitStores;
  shutdown: () => Promise<void>;
}

/** Result of a full init(). */
export interface FullInitResult {
  agent: Agent;
  stores: InitStores;
  fireTrigger: FireTrigger;
  shutdown: () => Promise<void>;
}

/**
 * Initialize dotbot with unified configuration.
 *
 * @returns { agent, stores, fireTrigger, shutdown } or { stores, shutdown } if storesOnly
 */
export async function init({
  dbPath,
  storesOnly = false,
  sessionStore: customSessionStore,
  providers = {},
  tools = coreTools,
  staleThresholdMs = 24 * 60 * 60 * 1000,
  notificationTitle = 'Assistant',
  systemPrompt,
  screenshotUrlPattern,
  compaction = { enabled: true },
  hooks = {},
}: InitOptions = {}): Promise<StoresOnlyResult | FullInitResult> {
  if (!dbPath) {
    throw new Error('init() requires a dbPath');
  }

  // Initialize stores
  const taskStore = new SQLiteTaskStore();
  const triggerStore = new SQLiteTriggerStore();
  const memoryStore = new SQLiteMemoryStore();

  // Initialize task, trigger, and memory stores (always needed)
  await taskStore.init(dbPath);
  await triggerStore.init(dbPath);
  await memoryStore.init(dbPath);

  // Bundle stores
  const stores: InitStores = {
    task: taskStore,
    trigger: triggerStore,
    memory: memoryStore,
  };

  // For stores-only mode (host manages sessions/cron/agent itself),
  // skip session/cron/agent setup
  if (storesOnly) {
    return {
      stores,
      shutdown: async () => {},
    };
  }

  // Full initialization with sessions, cron, and agent.
  // The concrete SQLiteSessionStore keeps its richer init(dbPath, options)
  // signature in its own binding so the two-arg init type-checks; the shared
  // `sessionStore` is typed against the SessionStore interface.
  const cronStore = new SQLiteCronStore();

  let sessionStore: SessionStore;
  if (customSessionStore) {
    sessionStore = customSessionStore;
  } else {
    const defaultSessionStore = new SQLiteSessionStore();
    // Initialize session store with hooks
    await defaultSessionStore.init(dbPath, {
      prefsFetcher: hooks.prefsFetcher,
      heartbeatEnsurer: async (userId: string) => {
        return await cronStore.ensureHeartbeat(userId);
      },
    });
    sessionStore = defaultSessionStore;
  }

  stores.session = sessionStore;
  stores.cron = cronStore;

  // Build cron handler with extracted logic
  const handleCronTask = createCronHandler({
    sessionStore,
    cronStore,
    taskStore,
    memoryStore,
    providers,
    staleThresholdMs,
    notificationTitle,
    hooks,
  });

  // Initialize cron store with the handler
  await cronStore.init(dbPath, { onTaskFire: handleCronTask });

  // Import createAgent dynamically to avoid circular dependency
  const { createAgent } = await import('../index.js');

  // Create the agent
  const agent = createAgent({
    sessionStore,
    cronStore,
    taskStore,
    triggerStore,
    memoryStore,
    providers,
    tools,
    systemPrompt,
    screenshotUrlPattern,
    compaction,
  });

  // Wire agent to cron handler (resolves chicken-and-egg dependency)
  handleCronTask.setAgent(agent);

  // Create trigger handler
  const fireTrigger = createTriggerHandler({
    agent,
    sessionStore,
    triggerStore,
    memoryStore,
    providers,
    notificationTitle,
    hooks,
  });

  /**
   * Gracefully shut down all stores and handlers.
   */
  async function shutdown(): Promise<void> {
    cronStore.stop();
    // Add any other cleanup needed
  }

  return {
    agent,
    stores,
    fireTrigger,
    shutdown,
  };
}

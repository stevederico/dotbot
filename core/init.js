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

/**
 * Initialize dotbot with unified configuration.
 *
 * @param {Object} options - Configuration options
 * @param {string} options.dbPath - Path to SQLite database file
 * @param {boolean} [options.storesOnly=false] - If true, only initialize stores (no agent, cron, triggers)
 * @param {Object} [options.sessionStore] - Custom session store (default: SQLiteSessionStore)
 * @param {Object} [options.providers] - Provider API keys: { anthropic: { apiKey }, openai: { apiKey }, xai: { apiKey } }
 * @param {Array} [options.tools] - Tool definitions (default: coreTools)
 * @param {number} [options.staleThresholdMs=86400000] - Skip heartbeat if user idle longer than this (default: 24h)
 * @param {string} [options.notificationTitle='Assistant'] - Title used when cron/trigger handlers dispatch notifications
 * @param {Function} [options.systemPrompt] - System prompt builder function
 * @param {Function} [options.screenshotUrlPattern] - Screenshot URL pattern function
 * @param {Object} [options.compaction] - Compaction settings
 * @param {Object} [options.hooks] - Host-specific hooks
 * @param {Function} [options.hooks.onNotification] - async (userId, { title, body, type }) => void
 * @param {Function} [options.hooks.prefsFetcher] - async (userId) => { agentName, agentPersonality }
 * @param {Function} [options.hooks.taskFetcher] - async (userId, taskId) => task object
 * @param {Function} [options.hooks.tasksFinder] - async (userId, filter) => tasks array
 * @returns {Promise<Object>} { agent, stores, fireTrigger, shutdown } or { stores, shutdown } if storesOnly
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
} = {}) {
  if (!dbPath) {
    throw new Error('init() requires a dbPath');
  }

  // Initialize stores
  const taskStore = new SQLiteTaskStore();
  const triggerStore = new SQLiteTriggerStore();
  const memoryStore = new SQLiteMemoryStore();

  // Initialize task, trigger, and memory stores (always needed)
  await taskStore.init({ dbPath });
  await triggerStore.init({ dbPath });
  await memoryStore.init({ dbPath });

  // Bundle stores
  const stores = {
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

  // Full initialization with sessions, cron, and agent
  const sessionStore = customSessionStore || new SQLiteSessionStore();
  const cronStore = new SQLiteCronStore();

  stores.session = sessionStore;
  stores.cron = cronStore;

  // Initialize session store with hooks
  if (!customSessionStore) {
    await sessionStore.init(dbPath, {
      prefsFetcher: hooks.prefsFetcher,
      heartbeatEnsurer: async (userId) => {
        return await cronStore.ensureHeartbeat(userId);
      },
    });
  }

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
  async function shutdown() {
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

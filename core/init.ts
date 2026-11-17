
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

export type SystemPromptBuilder = (...args: unknown[]) => string;

export type ScreenshotUrlPattern = (filename: string) => string;

export interface CompactionConfig {
  enabled: boolean;
  [key: string]: unknown;
}

export interface InitHooks extends CronHandlerHooks {
  prefsFetcher?: (
    userId: string,
  ) => Promise<{ agentName?: string; agentPersonality?: string }>;
}

export interface InitOptions {
  dbPath?: string;
  storesOnly?: boolean;
  sessionStore?: SessionStore;
  providers?: ProvidersMap;
  tools?: ToolDefinition[];
  staleThresholdMs?: number;
  notificationTitle?: string;
  systemPrompt?: SystemPromptBuilder;
  screenshotUrlPattern?: ScreenshotUrlPattern;
  compaction?: CompactionConfig;
  hooks?: InitHooks;
}

export interface InitStores {
  task: SQLiteTaskStore;
  trigger: SQLiteTriggerStore;
  memory: SQLiteMemoryStore;
  session?: SessionStore;
  cron?: SQLiteCronStore;
}

export type FireTrigger = ReturnType<typeof createTriggerHandler>;

export interface StoresOnlyResult {
  stores: InitStores;
  shutdown: () => Promise<void>;
}

export interface FullInitResult {
  agent: Agent;
  stores: InitStores;
  fireTrigger: FireTrigger;
  shutdown: () => Promise<void>;
}

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

  const taskStore = new SQLiteTaskStore();
  const triggerStore = new SQLiteTriggerStore();
  const memoryStore = new SQLiteMemoryStore();

  await taskStore.init(dbPath);
  await triggerStore.init(dbPath);
  await memoryStore.init(dbPath);

  const stores: InitStores = {
    task: taskStore,
    trigger: triggerStore,
    memory: memoryStore,
  };

  if (storesOnly) {
    return {
      stores,
      shutdown: async () => {},
    };
  }

  const cronStore = new SQLiteCronStore();

  let sessionStore: SessionStore;
  if (customSessionStore) {
    sessionStore = customSessionStore;
  } else {
    const defaultSessionStore = new SQLiteSessionStore();
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

  await cronStore.init(dbPath, { onTaskFire: handleCronTask });

  const { createAgent } = await import('../index.js');

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

  handleCronTask.setAgent(agent);

  const fireTrigger = createTriggerHandler({
    agent,
    sessionStore,
    triggerStore,
    memoryStore,
    providers,
    notificationTitle,
    hooks,
  });

  async function shutdown(): Promise<void> {
    cronStore.stop();
  }

  return {
    agent,
    stores,
    fireTrigger,
    shutdown,
  };
}

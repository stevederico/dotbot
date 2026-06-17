/// <reference types="node" />
/**
 * Cron task handler for dotbot.
 *
 * Reusable cron task executor that handles session resolution, stale user
 * gates, task injection, and notification hooks.
 */

import { compactMessages } from './compaction.js';
import type {
  AgentContext,
  AgentEvent,
  CronStore,
  MemoryStore,
  ProvidersMap,
  Session,
  SessionStore,
  TaskStore,
} from '../types.js';

/** Options passed to agent.chat(). */
export interface AgentChatOptions {
  sessionId: string;
  message: string;
  provider?: string;
  model?: string;
  context?: AgentContext;
}

/** Agent instance with a streaming chat() method. */
export interface Agent {
  chat(options: AgentChatOptions): AsyncGenerator<AgentEvent>;
}

/**
 * Cron store instance accepted by the cron handler. The handler holds the
 * store but doesn't call any methods on it directly, so it reuses the shared
 * CronStore contract (concrete adapters are assignable to it).
 */
export type CronHandlerCronStore = CronStore;

/** A single step within a multi-step task. */
export interface TaskStep {
  text: string;
  done: boolean;
}

/** A task document fetched for cron task execution. */
export interface TaskDoc {
  _id?: string;
  id?: string;
  description: string;
  status?: string;
  mode?: string;
  priority?: string;
  deadline?: string;
  steps?: TaskStep[];
}

/**
 * A cron task object passed to the handler when a cron job fires.
 *
 * The scoping fields are `string | null` (not just optional) because the
 * SQLiteCronStore passes a fully-populated record whose unset columns are
 * `null`. The handler only ever truthy-checks these fields, so null and
 * undefined behave identically at runtime.
 */
export interface CronTask {
  /** Task name (e.g., "heartbeat", "task_step"). */
  name: string;
  /** User ID for user-level tasks. */
  userId?: string | null;
  /** Session ID for session-scoped tasks. */
  sessionId?: string | null;
  /** Task ID for task_step cron jobs. */
  taskId?: string | null;
  /** Task prompt. */
  prompt?: string;
}

/** Notification payload dispatched via hooks.onNotification. */
export interface NotificationPayload {
  title: string;
  body: string;
  type: string;
}

/** Filter passed to tasksFinder / taskStore.findTasks. */
export interface TaskFilter {
  status: string[];
}

/** Host-specific hooks for the cron handler. */
export interface CronHandlerHooks {
  onNotification?: (userId: string, payload: NotificationPayload) => Promise<void>;
  taskFetcher?: (userId: string, taskId: string) => Promise<TaskDoc | null>;
  tasksFinder?: (userId: string, filter: TaskFilter) => Promise<TaskDoc[]>;
}

/** Options for createCronHandler(). */
export interface CronHandlerOptions {
  /** Session store instance. */
  sessionStore: SessionStore;
  /** Cron store instance. */
  cronStore: CronHandlerCronStore;
  /** Task store instance (optional). */
  taskStore?: TaskStore;
  /** Memory store instance (optional). */
  memoryStore?: MemoryStore;
  /** Provider API keys for compaction. */
  providers?: ProvidersMap;
  /** Skip heartbeat if user idle longer than this (default: 24h). */
  staleThresholdMs?: number;
  /** Title used when dispatching notifications via hooks.onNotification. */
  notificationTitle?: string;
  /** Host-specific hooks. */
  hooks?: CronHandlerHooks;
}

/** Async handler for cron task execution, with setAgent attached. */
export interface CronTaskHandler {
  (task: CronTask): Promise<void>;
  setAgent(agentInstance: Agent): void;
}

/** Read a string-valued field from a Session (whose values are `unknown`). */
function sessionString(session: Session, key: string): string | undefined {
  const value: unknown = session[key];
  return typeof value === 'string' ? value : undefined;
}

/** Narrow an unknown store result to a TaskDoc. */
function isTaskDoc(value: unknown): value is TaskDoc {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { description?: unknown }).description === 'string'
  );
}

/**
 * Create a cron task handler function.
 */
export function createCronHandler({
  sessionStore,
  cronStore,
  taskStore,
  memoryStore,
  providers = {},
  staleThresholdMs = 24 * 60 * 60 * 1000,
  notificationTitle = 'Assistant',
  hooks = {},
}: CronHandlerOptions): CronTaskHandler {
  // Agent reference - will be set after init() creates the agent
  let agent: Agent | null = null;

  /**
   * Set the agent instance (called by init() after agent creation).
   */
  function setAgent(agentInstance: Agent): void {
    agent = agentInstance;
  }

  /**
   * Handle a cron task firing.
   */
  async function handleTaskFire(task: CronTask): Promise<void> {
    console.log(`[cron] processing task ${task.name} (userId=${task.userId || 'none'}, sessionId=${task.sessionId || 'none'})`);

    // Skip if agent not initialized yet
    if (!agent) {
      console.warn('[cron] task skipped - agent not initialized');
      return;
    }

    // Resolve session: user-level heartbeats find the most recent session,
    // session-scoped tasks use the explicit sessionId.
    let session: Session | null | undefined;
    if (task.userId) {
      session = await sessionStore.getOrCreateDefaultSession(task.userId);
    } else if (task.sessionId) {
      session = await sessionStore.getSessionInternal(task.sessionId);
    }

    if (!session) {
      console.log(`[cron] no session found for task ${task.name}, skipping`);
      return;
    }

    const sessionId = sessionString(session, 'id');
    if (!sessionId) {
      console.log(`[cron] session for task ${task.name} has no id, skipping`);
      return;
    }

    // Stale user check: skip heartbeat if user hasn't interacted recently
    const updatedAt = sessionString(session, 'updatedAt');
    if (task.name === 'heartbeat' && updatedAt) {
      const idleMs = Date.now() - new Date(updatedAt).getTime();
      if (idleMs > staleThresholdMs) {
        console.log(`[cron] skipping heartbeat for stale user ${session.owner} (idle ${Math.round(idleMs / 3600000)}h)`);
        return;
      }
    }

    // Build task content depending on task type
    const taskContent = await buildTaskContent(task, session);
    if (!taskContent) return;

    // Add message to session
    await sessionStore.addMessage(sessionId, {
      role: 'user',
      content: taskContent,
    });

    // Re-fetch session to pick up the added message
    const updatedSession = await sessionStore.getSessionInternal(sessionId);
    if (!updatedSession) return;
    const updatedSessionId = sessionString(updatedSession, 'id') ?? sessionId;
    const providerId = updatedSession.provider || 'ollama';

    // Compact old messages before running agent loop
    const compacted = await compactMessages(updatedSession.messages, {
      providerId,
      providers,
    });

    if (compacted.compacted) {
      updatedSession.messages = compacted.messages;
      updatedSession.messages.push({
        role: 'user',
        content: '[Compaction] Compressed conversation history',
        _ts: Date.now(),
      });
    }

    // Run the agent chat loop
    let finalText = '';
    for await (const event of agent.chat({
      sessionId: updatedSessionId,
      message: '', // Message already added to session
      provider: providerId,
      model: updatedSession.model,
      context: {
        userID: updatedSession.owner,
        sessionId: updatedSessionId,
        memoryStore,
        taskStore,
      },
    })) {
      if (event.type === 'text_delta' && event.text) {
        finalText += event.text;
      }
    }

    // Create notification if the agent produced meaningful output
    const trimmed = finalText.trim();
    if (trimmed && trimmed.length > 10 && updatedSession.owner && hooks.onNotification) {
      try {
        await hooks.onNotification(updatedSession.owner, {
          title: notificationTitle,
          body: trimmed.slice(0, 500),
          type: task.name === 'heartbeat' ? 'heartbeat' : 'cron',
        });
        console.log(`[cron] notification created for ${updatedSession.owner} (${trimmed.length} chars)`);
      } catch (err) {
        console.error('[cron] failed to create notification:', err instanceof Error ? err.message : err);
      }
    } else if (task.name === 'heartbeat') {
      console.log(`[cron] heartbeat for ${updatedSession.owner} produced no meaningful output (${finalText.trim().length} chars)`);
    }
  }

  /**
   * Build the content for a cron task based on its type.
   *
   * @returns Task content or null to skip.
   */
  async function buildTaskContent(task: CronTask, session: Session): Promise<string | null> {
    if (task.name === 'task_step' && task.taskId) {
      // Task step continuation — inject targeted prompt for the specific task
      return await buildTaskStepContent(task, session);
    }

    if (task.name === 'heartbeat' && session.owner) {
      // Heartbeat — check for auto-mode tasks with pending steps
      return await buildHeartbeatContent(task, session);
    }

    // Default: use the task prompt
    return `[Heartbeat] ${task.prompt}`;
  }

  /**
   * Build content for a task_step cron job.
   */
  async function buildTaskStepContent(task: CronTask, session: Session): Promise<string | null> {
    try {
      let taskDoc: TaskDoc | null | undefined;
      if (hooks.taskFetcher) {
        taskDoc = await hooks.taskFetcher(session.owner ?? '', task.taskId ?? '');
      } else if (taskStore) {
        const getTask = taskStore.getTask;
        if (typeof getTask === 'function') {
          const result: unknown = await getTask(session.owner, task.taskId);
          taskDoc = isTaskDoc(result) ? result : null;
        }
      }

      if (!taskDoc) {
        console.log(`[cron] task_step: task ${task.taskId} not found, skipping`);
        return null;
      }

      if (taskDoc.status === 'completed' || taskDoc.status === 'abandoned') {
        console.log(`[cron] task_step: task ${task.taskId} already ${taskDoc.status}, skipping`);
        return null;
      }

      const nextStep = taskDoc.steps?.find(s => !s.done);
      if (!nextStep) {
        console.log(`[cron] task_step: all steps done for task ${task.taskId}, skipping`);
        return null;
      }

      const steps = taskDoc.steps ?? [];
      const doneCount = steps.filter(s => s.done).length;
      return `[Task Work] Continue auto-executing task "${taskDoc.description}" (${doneCount}/${steps.length} steps done). Call task_work with task_id "${task.taskId}" to execute the next step.`;
    } catch (err) {
      console.error('[cron] task_step error:', err instanceof Error ? err.message : err);
      return null;
    }
  }

  /**
   * Build content for a heartbeat cron job.
   */
  async function buildHeartbeatContent(task: CronTask, session: Session): Promise<string | null> {
    let taskContent = `[Heartbeat] ${task.prompt}`;

    try {
      let tasks: TaskDoc[] = [];
      if (hooks.tasksFinder) {
        tasks = await hooks.tasksFinder(session.owner ?? '', { status: ['pending', 'in_progress'] });
      } else if (taskStore) {
        const findTasks = taskStore.findTasks;
        if (typeof findTasks === 'function') {
          const result: unknown = await findTasks(session.owner, { status: ['pending', 'in_progress'] });
          tasks = Array.isArray(result) ? result.filter(isTaskDoc) : [];
        }
      }

      // Skip the LLM call entirely when there's nothing to discuss. A heartbeat
      // with no active tasks is a waste of tokens on every provider (and is
      // especially expensive on cloud providers that charge per call). The
      // caller at handleTaskFire() treats a null return as "skip this tick".
      if (tasks.length === 0) {
        console.log(`[cron] heartbeat for ${session.owner}: no active tasks, skipping AI call`);
        return null;
      }

      // Check if any task is in auto mode with pending steps
      const autoTask = tasks.find(t => t.mode === 'auto' && t.steps?.some(s => !s.done));
      if (autoTask && autoTask.steps) {
        const doneCount = autoTask.steps.filter(s => s.done).length;
        const nextStep = autoTask.steps.find(s => !s.done);
        taskContent = `[Heartbeat] Auto-mode task "${autoTask.description}" has pending steps (${doneCount}/${autoTask.steps.length} done). Call task_work with task_id "${autoTask._id || autoTask.id}" to execute: "${nextStep?.text}"`;
      } else {
        // List all active tasks
        const lines = tasks.map(t => {
          let line = `• [${t.priority}] ${t.description}`;
          if (t.mode) line += ` [${t.mode}]`;
          if (t.deadline) line += ` (due: ${t.deadline})`;
          if (t.steps && t.steps.length > 0) {
            const done = t.steps.filter(s => s.done).length;
            line += ` (${done}/${t.steps.length} steps)`;
            for (const step of t.steps) {
              line += `\n  ${step.done ? '[x]' : '[ ]'} ${step.text}`;
            }
          }
          return line;
        });
        taskContent += `\n\nActive tasks:\n${lines.join('\n')}`;
      }
    } catch (err) {
      // Fail closed: if we can't fetch tasks, skip this heartbeat rather
      // than call the LLM with a meaningless default prompt.
      console.error('[cron] failed to fetch tasks for heartbeat:', err instanceof Error ? err.message : err);
      return null;
    }

    return taskContent;
  }

  // Return handler with setAgent method attached
  const handler: CronTaskHandler = Object.assign(handleTaskFire, { setAgent });
  return handler;
}

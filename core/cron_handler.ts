/// <reference types="node" />

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

export interface AgentChatOptions {
  sessionId: string;
  message: string;
  provider?: string;
  model?: string;
  context?: AgentContext;
}

export interface Agent {
  chat(options: AgentChatOptions): AsyncGenerator<AgentEvent>;
}

export type CronHandlerCronStore = CronStore;

export interface TaskStep {
  text: string;
  done: boolean;
}

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

export interface CronTask {
  name: string;
  userId?: string | null;
  sessionId?: string | null;
  taskId?: string | null;
  prompt?: string;
}

export interface NotificationPayload {
  title: string;
  body: string;
  type: string;
}

export interface TaskFilter {
  status: string[];
}

export interface CronHandlerHooks {
  onNotification?: (userId: string, payload: NotificationPayload) => Promise<void>;
  taskFetcher?: (userId: string, taskId: string) => Promise<TaskDoc | null>;
  tasksFinder?: (userId: string, filter: TaskFilter) => Promise<TaskDoc[]>;
}

export interface CronHandlerOptions {
  sessionStore: SessionStore;
  cronStore: CronHandlerCronStore;
  taskStore?: TaskStore;
  memoryStore?: MemoryStore;
  providers?: ProvidersMap;
  staleThresholdMs?: number;
  notificationTitle?: string;
  hooks?: CronHandlerHooks;
}

export interface CronTaskHandler {
  (task: CronTask): Promise<void>;
  setAgent(agentInstance: Agent): void;
}

function sessionString(session: Session, key: string): string | undefined {
  const value: unknown = session[key];
  return typeof value === 'string' ? value : undefined;
}

function isTaskDoc(value: unknown): value is TaskDoc {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { description?: unknown }).description === 'string'
  );
}

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
  let agent: Agent | null = null;

  function setAgent(agentInstance: Agent): void {
    agent = agentInstance;
  }

  async function handleTaskFire(task: CronTask): Promise<void> {
    console.log(`[cron] processing task ${task.name} (userId=${task.userId || 'none'}, sessionId=${task.sessionId || 'none'})`);

    if (!agent) {
      console.warn('[cron] task skipped - agent not initialized');
      return;
    }

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

    const updatedAt = sessionString(session, 'updatedAt');
    if (task.name === 'heartbeat' && updatedAt) {
      const idleMs = Date.now() - new Date(updatedAt).getTime();
      if (idleMs > staleThresholdMs) {
        console.log(`[cron] skipping heartbeat for stale user ${session.owner} (idle ${Math.round(idleMs / 3600000)}h)`);
        return;
      }
    }

    const taskContent = await buildTaskContent(task, session);
    if (!taskContent) return;

    await sessionStore.addMessage(sessionId, {
      role: 'user',
      content: taskContent,
    });

    const updatedSession = await sessionStore.getSessionInternal(sessionId);
    if (!updatedSession) return;
    const updatedSessionId = sessionString(updatedSession, 'id') ?? sessionId;
    const providerId = updatedSession.provider || 'ollama';

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

    let finalText = '';
    for await (const event of agent.chat({
      sessionId: updatedSessionId,
      message: '',
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

  async function buildTaskContent(task: CronTask, session: Session): Promise<string | null> {
    if (task.name === 'task_step' && task.taskId) {
      return await buildTaskStepContent(task, session);
    }

    if (task.name === 'heartbeat' && session.owner) {
      return await buildHeartbeatContent(task, session);
    }

    return `[Heartbeat] ${task.prompt}`;
  }

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
      return `[Task Work] Continue auto-executing task "${taskDoc.description}" (${doneCount}/${steps.length} steps done). Call dot_task_work with task_id "${task.taskId}" to execute the next step.`;
    } catch (err) {
      console.error('[cron] task_step error:', err instanceof Error ? err.message : err);
      return null;
    }
  }

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

      if (tasks.length === 0) {
        console.log(`[cron] heartbeat for ${session.owner}: no active tasks, skipping AI call`);
        return null;
      }

      const autoTask = tasks.find(t => t.mode === 'auto' && t.steps?.some(s => !s.done));
      if (autoTask && autoTask.steps) {
        const doneCount = autoTask.steps.filter(s => s.done).length;
        const nextStep = autoTask.steps.find(s => !s.done);
        taskContent = `[Heartbeat] Auto-mode task "${autoTask.description}" has pending steps (${doneCount}/${autoTask.steps.length} done). Call dot_task_work with task_id "${autoTask._id || autoTask.id}" to execute: "${nextStep?.text}"`;
      } else {
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
      console.error('[cron] failed to fetch tasks for heartbeat:', err instanceof Error ? err.message : err);
      return null;
    }

    return taskContent;
  }

  const handler: CronTaskHandler = Object.assign(handleTaskFire, { setAgent });
  return handler;
}

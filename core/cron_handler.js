/**
 * Cron task handler for dotbot.
 *
 * Reusable cron task executor that handles session resolution, stale user
 * gates, task injection, and notification hooks.
 */

import { compactMessages } from './compaction.js';

/**
 * Create a cron task handler function.
 *
 * @param {Object} options
 * @param {Object} options.sessionStore - Session store instance
 * @param {Object} options.cronStore - Cron store instance
 * @param {Object} options.taskStore - Task store instance (optional)
 * @param {Object} options.memoryStore - Memory store instance (optional)
 * @param {Object} options.providers - Provider API keys for compaction
 * @param {number} [options.staleThresholdMs=86400000] - Skip heartbeat if user idle longer than this (default: 24h)
 * @param {string} [options.notificationTitle='Assistant'] - Title used when dispatching notifications via hooks.onNotification
 * @param {Object} [options.hooks] - Host-specific hooks
 * @param {Function} [options.hooks.onNotification] - async (userId, { title, body, type }) => void
 * @param {Function} [options.hooks.taskFetcher] - async (userId, taskId) => task object
 * @param {Function} [options.hooks.tasksFinder] - async (userId, filter) => tasks array
 * @returns {Function} Async handler for cron task execution
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
}) {
  // Agent reference - will be set after init() creates the agent
  let agent = null;

  /**
   * Set the agent instance (called by init() after agent creation).
   * @param {Object} agentInstance
   */
  function setAgent(agentInstance) {
    agent = agentInstance;
  }

  /**
   * Handle a cron task firing.
   *
   * @param {Object} task - Cron task object
   * @param {string} task.name - Task name (e.g., "heartbeat", "task_step")
   * @param {string} [task.userId] - User ID for user-level tasks
   * @param {string} [task.sessionId] - Session ID for session-scoped tasks
   * @param {string} [task.taskId] - Task ID for task_step cron jobs
   * @param {string} [task.prompt] - Task prompt
   */
  async function handleTaskFire(task) {
    console.log(`[cron] processing task ${task.name} (userId=${task.userId || 'none'}, sessionId=${task.sessionId || 'none'})`);

    // Skip if agent not initialized yet
    if (!agent) {
      console.warn('[cron] task skipped - agent not initialized');
      return;
    }

    // Resolve session: user-level heartbeats find the most recent session,
    // session-scoped tasks use the explicit sessionId.
    let session;
    if (task.userId) {
      session = await sessionStore.getOrCreateDefaultSession(task.userId);
    } else if (task.sessionId) {
      session = await sessionStore.getSessionInternal(task.sessionId);
    }

    if (!session) {
      console.log(`[cron] no session found for task ${task.name}, skipping`);
      return;
    }

    // Stale user check: skip heartbeat if user hasn't interacted recently
    if (task.name === 'heartbeat' && session.updatedAt) {
      const idleMs = Date.now() - new Date(session.updatedAt).getTime();
      if (idleMs > staleThresholdMs) {
        console.log(`[cron] skipping heartbeat for stale user ${session.owner} (idle ${Math.round(idleMs / 3600000)}h)`);
        return;
      }
    }

    // Build task content depending on task type
    const taskContent = await buildTaskContent(task, session);
    if (!taskContent) return;

    // Add message to session
    await sessionStore.addMessage(session.id, {
      role: 'user',
      content: taskContent,
    });

    // Re-fetch session to pick up the added message
    const updatedSession = await sessionStore.getSessionInternal(session.id);
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
      sessionId: updatedSession.id,
      message: '', // Message already added to session
      provider: providerId,
      model: updatedSession.model,
      context: {
        userID: updatedSession.owner,
        sessionId: updatedSession.id,
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
        console.error('[cron] failed to create notification:', err.message);
      }
    } else if (task.name === 'heartbeat') {
      console.log(`[cron] heartbeat for ${updatedSession.owner} produced no meaningful output (${finalText.trim().length} chars)`);
    }
  }

  /**
   * Build the content for a cron task based on its type.
   *
   * @param {Object} task - Cron task
   * @param {Object} session - User session
   * @returns {Promise<string|null>} Task content or null to skip
   */
  async function buildTaskContent(task, session) {
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
  async function buildTaskStepContent(task, session) {
    try {
      let taskDoc;
      if (hooks.taskFetcher) {
        taskDoc = await hooks.taskFetcher(session.owner, task.taskId);
      } else if (taskStore) {
        taskDoc = await taskStore.getTask(session.owner, task.taskId);
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

      const doneCount = taskDoc.steps.filter(s => s.done).length;
      return `[Task Work] Continue auto-executing task "${taskDoc.description}" (${doneCount}/${taskDoc.steps.length} steps done). Call task_work with task_id "${task.taskId}" to execute the next step.`;
    } catch (err) {
      console.error('[cron] task_step error:', err.message);
      return null;
    }
  }

  /**
   * Build content for a heartbeat cron job.
   */
  async function buildHeartbeatContent(task, session) {
    let taskContent = `[Heartbeat] ${task.prompt}`;

    try {
      let tasks = [];
      if (hooks.tasksFinder) {
        tasks = await hooks.tasksFinder(session.owner, { status: ['pending', 'in_progress'] });
      } else if (taskStore) {
        tasks = await taskStore.findTasks(session.owner, { status: ['pending', 'in_progress'] });
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
      if (autoTask) {
        const doneCount = autoTask.steps.filter(s => s.done).length;
        const nextStep = autoTask.steps.find(s => !s.done);
        taskContent = `[Heartbeat] Auto-mode task "${autoTask.description}" has pending steps (${doneCount}/${autoTask.steps.length} done). Call task_work with task_id "${autoTask._id || autoTask.id}" to execute: "${nextStep.text}"`;
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
      console.error('[cron] failed to fetch tasks for heartbeat:', err.message);
      return null;
    }

    return taskContent;
  }

  // Return handler with setAgent method attached
  handleTaskFire.setAgent = setAgent;
  return handleTaskFire;
}

/**
 * Cron task handler for dotbot.
 *
 * Extracted from dottie-os server.js to provide a reusable cron task executor
 * that handles session resolution, stale user gates, goal injection, and
 * notification hooks.
 */

import { compactMessages } from './compaction.js';

/**
 * Create a cron task handler function.
 *
 * @param {Object} options
 * @param {Object} options.sessionStore - Session store instance
 * @param {Object} options.cronStore - Cron store instance
 * @param {Object} options.goalStore - Goal store instance (optional)
 * @param {Object} options.memoryStore - Memory store instance (optional)
 * @param {Object} options.providers - Provider API keys for compaction
 * @param {number} [options.staleThresholdMs=86400000] - Skip heartbeat if user idle longer than this (default: 24h)
 * @param {Object} [options.hooks] - Host-specific hooks
 * @param {Function} [options.hooks.onNotification] - async (userId, { title, body, type }) => void
 * @param {Function} [options.hooks.goalFetcher] - async (userId, goalId) => goal object
 * @param {Function} [options.hooks.goalsFinder] - async (userId, filter) => goals array
 * @returns {Function} Async handler for cron task execution
 */
export function createCronHandler({
  sessionStore,
  cronStore,
  goalStore,
  memoryStore,
  providers = {},
  staleThresholdMs = 24 * 60 * 60 * 1000,
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
   * @param {string} task.name - Task name (e.g., "heartbeat", "goal_step")
   * @param {string} [task.userId] - User ID for user-level tasks
   * @param {string} [task.sessionId] - Session ID for session-scoped tasks
   * @param {string} [task.goalId] - Goal ID for goal_step tasks
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
        goalStore,
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
          title: 'Dottie',
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
    if (task.name === 'goal_step' && task.goalId) {
      // Goal step continuation — inject targeted prompt for the specific goal
      return await buildGoalStepContent(task, session);
    }

    if (task.name === 'heartbeat' && session.owner) {
      // Heartbeat — check for auto-mode goals with pending steps
      return await buildHeartbeatContent(task, session);
    }

    // Default: use the task prompt
    return `[Heartbeat] ${task.prompt}`;
  }

  /**
   * Build content for a goal_step task.
   */
  async function buildGoalStepContent(task, session) {
    try {
      let goal;
      if (hooks.goalFetcher) {
        goal = await hooks.goalFetcher(session.owner, task.goalId);
      } else if (goalStore) {
        goal = await goalStore.getGoal(session.owner, task.goalId);
      }

      if (!goal) {
        console.log(`[cron] goal_step: goal ${task.goalId} not found, skipping`);
        return null;
      }

      if (goal.status === 'completed' || goal.status === 'abandoned') {
        console.log(`[cron] goal_step: goal ${task.goalId} already ${goal.status}, skipping`);
        return null;
      }

      const nextStep = goal.steps?.find(s => !s.done);
      if (!nextStep) {
        console.log(`[cron] goal_step: all steps done for goal ${task.goalId}, skipping`);
        return null;
      }

      const doneCount = goal.steps.filter(s => s.done).length;
      return `[Goal Work] Continue auto-executing goal "${goal.description}" (${doneCount}/${goal.steps.length} steps done). Call goal_work with goal_id "${task.goalId}" to execute the next step.`;
    } catch (err) {
      console.error('[cron] goal_step error:', err.message);
      return null;
    }
  }

  /**
   * Build content for a heartbeat task.
   */
  async function buildHeartbeatContent(task, session) {
    let taskContent = `[Heartbeat] ${task.prompt}`;

    try {
      let goals = [];
      if (hooks.goalsFinder) {
        goals = await hooks.goalsFinder(session.owner, { status: ['pending', 'in_progress'] });
      } else if (goalStore) {
        goals = await goalStore.findGoals(session.owner, { status: ['pending', 'in_progress'] });
      }

      if (goals.length > 0) {
        // Check if any goal is in auto mode with pending steps
        const autoGoal = goals.find(g => g.mode === 'auto' && g.steps?.some(s => !s.done));
        if (autoGoal) {
          const doneCount = autoGoal.steps.filter(s => s.done).length;
          const nextStep = autoGoal.steps.find(s => !s.done);
          taskContent = `[Heartbeat] Auto-mode goal "${autoGoal.description}" has pending steps (${doneCount}/${autoGoal.steps.length} done). Call goal_work with goal_id "${autoGoal._id || autoGoal.id}" to execute: "${nextStep.text}"`;
        } else {
          // List all active goals
          const lines = goals.map(g => {
            let line = `• [${g.priority}] ${g.description}`;
            if (g.mode) line += ` [${g.mode}]`;
            if (g.deadline) line += ` (due: ${g.deadline})`;
            if (g.steps && g.steps.length > 0) {
              const done = g.steps.filter(s => s.done).length;
              line += ` (${done}/${g.steps.length} steps)`;
              for (const step of g.steps) {
                line += `\n  ${step.done ? '[x]' : '[ ]'} ${step.text}`;
              }
            }
            return line;
          });
          taskContent += `\n\nActive goals:\n${lines.join('\n')}`;
        }
      }
    } catch (err) {
      console.error('[cron] failed to fetch goals for heartbeat:', err.message);
    }

    return taskContent;
  }

  // Return handler with setAgent method attached
  handleTaskFire.setAgent = setAgent;
  return handleTaskFire;
}

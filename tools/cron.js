/**
 * Cron Tools
 *
 * Agent tools for scheduling and managing cron tasks.
 * Each tool receives (input, signal, context) where context.cronStore
 * provides the storage backend.
 */

import { parseInterval } from '../storage/cron_constants.js';

/**
 * Agent tools for scheduling and managing cron tasks
 * @type {Array<{name: string, description: string, parameters: Object, execute: Function}>}
 */
export const cronTools = [
  {
    name: "schedule_task",
    description:
      "Schedule a task to run later or on a recurring basis. The task will send a message to you (the agent) at the scheduled time, and you will process it like a normal user message. Use this for reminders, periodic checks, daily summaries, etc.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Short name for the task. e.g. 'daily-news-summary', 'remind-standup'",
        },
        prompt: {
          type: "string",
          description:
            "The message that will be sent to you when the task fires. Write it as if the user is asking you to do something. e.g. 'Give me a summary of today\\'s top tech news' or 'Remind me about the standup meeting in 10 minutes'",
        },
        run_at: {
          type: "string",
          description:
            "When to run. ISO 8601 datetime string. e.g. '2025-01-15T09:00:00' for a specific time.",
        },
        interval: {
          type: "string",
          description:
            "For recurring tasks: interval between runs. e.g. '30m' (30 minutes), '2h' (2 hours), '1d' (daily), '1w' (weekly). Omit for one-shot tasks.",
        },
      },
      required: ["name", "prompt", "run_at"],
    },
    execute: async (input, signal, context) => {
      if (!context?.cronStore) return "Error: cron store not available";
      try {
        const { sessionId, userID } = context || {};
        const intervalMs = input.interval ? parseInterval(input.interval) : null;
        const recurring = !!intervalMs;

        const task = await context.cronStore.createTask({
          name: input.name,
          prompt: input.prompt,
          sessionId: sessionId || 'default',
          userId: userID,
          runAt: input.run_at,
          intervalMs,
          recurring,
        });

        const desc = recurring
          ? `Recurring task "${input.name}" scheduled starting ${input.run_at}, repeating every ${input.interval}`
          : `One-time task "${input.name}" scheduled for ${input.run_at}`;

        return desc;
      } catch (err) {
        return `Error scheduling task: ${err.message}`;
      }
    },
  },

  {
    name: "list_tasks",
    description: "List all scheduled tasks (active and completed).",
    parameters: {
      type: "object",
      properties: {},
    },
    execute: async (input, signal, context) => {
      if (!context?.cronStore) return "Error: cron store not available";
      try {
        const tasks = await context.cronStore.listTasks();

        if (tasks.length === 0) {
          return "No scheduled tasks.";
        }

        return tasks
          .map(
            (t) =>
              `- ${t.name} [${t.enabled ? "active" : "done"}]` +
              `\n  prompt: "${t.prompt}"` +
              `\n  next: ${t.nextRunAt?.toISOString?.() || t.nextRunAt || "n/a"}` +
              (t.recurring ? `\n  repeats every ${t.intervalMs / 60000}m` : "") +
              (t.lastRunAt ? `\n  last ran: ${t.lastRunAt.toISOString?.() || t.lastRunAt}` : "")
          )
          .join("\n\n");
      } catch (err) {
        return `Error listing tasks: ${err.message}`;
      }
    },
  },

  {
    name: "task_toggle",
    description: "Enable or disable a scheduled task without deleting it.",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "The task ID to toggle" },
        enabled: { type: "boolean", description: "true to enable, false to disable" },
      },
      required: ["task_id", "enabled"],
    },
    execute: async (input, signal, context) => {
      if (!context?.cronStore) return "Error: cron store not available";
      try {
        await context.cronStore.toggleTask(input.task_id, input.enabled);
        return `Task ${input.task_id} ${input.enabled ? 'enabled' : 'disabled'}.`;
      } catch (err) {
        return `Error toggling task: ${err.message}`;
      }
    },
  },

  {
    name: "cancel_task",
    description: "Cancel/delete a scheduled task by its ID.",
    parameters: {
      type: "object",
      properties: {
        task_id: {
          type: "string",
          description: "The task ID to cancel",
        },
      },
      required: ["task_id"],
    },
    execute: async (input, signal, context) => {
      if (!context?.cronStore) return "Error: cron store not available";
      try {
        await context.cronStore.deleteTask(input.task_id);
        return `Task ${input.task_id} cancelled.`;
      } catch (err) {
        return `Error cancelling task: ${err.message}`;
      }
    },
  },
];

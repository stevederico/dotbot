/**
 * Job Tools
 *
 * Agent tools for scheduling and managing jobs.
 * Each tool receives (input, signal, context) where context.cronStore
 * provides the storage backend.
 */

import { parseInterval } from '../storage/cron_constants.js';

/**
 * Agent tools for scheduling and managing jobs
 * @type {Array<{name: string, description: string, parameters: Object, execute: Function}>}
 */
export const jobTools = [
  {
    name: "schedule_job",
    description:
      "Schedule a job to run later or on a recurring basis. The job will send a message to you (the agent) at the scheduled time, and you will process it like a normal user message. Use this for reminders, periodic checks, daily summaries, etc.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Short name for the job. e.g. 'daily-news-summary', 'remind-standup'",
        },
        prompt: {
          type: "string",
          description:
            "The message that will be sent to you when the job fires. Write it as if the user is asking you to do something. e.g. 'Give me a summary of today\\'s top tech news' or 'Remind me about the standup meeting in 10 minutes'",
        },
        run_at: {
          type: "string",
          description:
            "When to run. ISO 8601 datetime string. e.g. '2025-01-15T09:00:00' for a specific time.",
        },
        interval: {
          type: "string",
          description:
            "For recurring jobs: interval between runs. e.g. '30m' (30 minutes), '2h' (2 hours), '1d' (daily), '1w' (weekly). Omit for one-shot jobs.",
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
          ? `Recurring job "${input.name}" scheduled starting ${input.run_at}, repeating every ${input.interval}`
          : `One-time job "${input.name}" scheduled for ${input.run_at}`;

        return desc;
      } catch (err) {
        return `Error scheduling job: ${err.message}`;
      }
    },
  },

  {
    name: "list_jobs",
    description: "List all scheduled jobs (active and completed).",
    parameters: {
      type: "object",
      properties: {},
    },
    execute: async (input, signal, context) => {
      if (!context?.cronStore) return "Error: cron store not available";
      try {
        const tasks = await context.cronStore.listTasks();

        if (tasks.length === 0) {
          return "No scheduled jobs.";
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
        return `Error listing jobs: ${err.message}`;
      }
    },
  },

  {
    name: "toggle_job",
    description: "Enable or disable a scheduled job without deleting it.",
    parameters: {
      type: "object",
      properties: {
        job_id: { type: "string", description: "The job ID to toggle" },
        enabled: { type: "boolean", description: "true to enable, false to disable" },
      },
      required: ["job_id", "enabled"],
    },
    execute: async (input, signal, context) => {
      if (!context?.cronStore) return "Error: cron store not available";
      try {
        const task = await context.cronStore.getTask(input.job_id);
        if (!task) return `Error: job ${input.job_id} not found.`;
        if (task.name === 'heartbeat') return "Error: cannot modify system jobs.";
        await context.cronStore.toggleTask(input.job_id, input.enabled);
        return `Job ${input.job_id} ${input.enabled ? 'enabled' : 'disabled'}.`;
      } catch (err) {
        return `Error toggling job: ${err.message}`;
      }
    },
  },

  {
    name: "cancel_job",
    description: "Cancel/delete a scheduled job by its ID.",
    parameters: {
      type: "object",
      properties: {
        job_id: {
          type: "string",
          description: "The job ID to cancel",
        },
      },
      required: ["job_id"],
    },
    execute: async (input, signal, context) => {
      if (!context?.cronStore) return "Error: cron store not available";
      try {
        const task = await context.cronStore.getTask(input.job_id);
        if (!task) return `Error: job ${input.job_id} not found.`;
        if (task.name === 'heartbeat') return "Error: cannot modify system jobs.";
        await context.cronStore.deleteTask(input.job_id);
        return `Job ${input.job_id} cancelled.`;
      } catch (err) {
        return `Error cancelling job: ${err.message}`;
      }
    },
  },
];

// Backwards compatibility aliases
export const taskTools = jobTools;
export const cronTools = jobTools;

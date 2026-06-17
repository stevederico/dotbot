/**
 * Job Tools
 *
 * Agent tools for scheduling and managing jobs (time-triggered scheduled prompts).
 * Each tool receives (input, signal, context) where context.cronStore
 * provides the storage backend.
 */

import { parseInterval } from '../storage/cron_constants.js';
import type {
  AgentContext,
  CronStore,
  JsonObject,
  ToolDefinition,
  ToolResult,
} from "../types.js";

/** Extract a human-readable message from an unknown thrown value. */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A scheduled job record as returned by CronStore.listTasks()/getTask().
 * Modeled structurally from the fields read in this module. Date-ish fields are
 * `unknown` because adapters may store a Date object or an ISO string.
 */
interface CronTaskRecord {
  name?: string;
  enabled?: boolean;
  prompt?: string;
  recurring?: boolean;
  intervalMs?: number;
  nextRunAt?: unknown;
  lastRunAt?: unknown;
}

/**
 * Render a possibly-Date-or-string value via toISOString when available,
 * mirroring the original `value?.toISOString?.() || value` behavior.
 */
function isoOf(value: unknown): string {
  if (value !== null && typeof value === "object" && "toISOString" in value) {
    const fn: unknown = value.toISOString;
    if (typeof fn === "function") {
      const result: unknown = fn.call(value);
      if (typeof result === "string") return result;
    }
  }
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

/**
 * Read a CronTaskRecord view from a loose store row. CronStore returns records
 * with arbitrary-typed (possibly non-JSON, e.g. Date) fields; this reads the
 * fields these tools use with narrowing.
 */
function toCronTask(row: Record<string, unknown>): CronTaskRecord {
  const r: Record<string, unknown> = row;
  return {
    name: typeof r.name === "string" ? r.name : undefined,
    enabled: typeof r.enabled === "boolean" ? r.enabled : undefined,
    prompt: typeof r.prompt === "string" ? r.prompt : undefined,
    recurring: typeof r.recurring === "boolean" ? r.recurring : undefined,
    intervalMs: typeof r.intervalMs === "number" ? r.intervalMs : undefined,
    nextRunAt: r.nextRunAt,
    lastRunAt: r.lastRunAt,
  };
}

/**
 * Agent tools for scheduling and managing jobs
 */
export const jobTools: ToolDefinition[] = [
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
    execute: async (
      input: JsonObject,
      signal: AbortSignal | undefined,
      context: AgentContext,
    ): Promise<ToolResult> => {
      const cronStore: CronStore | null | undefined = context?.cronStore;
      if (!cronStore) return "Error: cron store not available";
      try {
        const { sessionId, userID } = context;
        const intervalMs = typeof input.interval === "string" ? parseInterval(input.interval) : null;
        const recurring = !!intervalMs;

        await cronStore.createTask({
          name: input.name,
          prompt: input.prompt,
          sessionId: typeof sessionId === "string" ? sessionId : 'default',
          userId: userID ?? null,
          runAt: input.run_at,
          intervalMs,
          recurring,
        });

        const desc = recurring
          ? `Recurring job "${input.name}" scheduled starting ${input.run_at}, repeating every ${input.interval}`
          : `One-time job "${input.name}" scheduled for ${input.run_at}`;

        return desc;
      } catch (err) {
        return `Error scheduling job: ${errMessage(err)}`;
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
    execute: async (
      input: JsonObject,
      signal: AbortSignal | undefined,
      context: AgentContext,
    ): Promise<ToolResult> => {
      const cronStore: CronStore | null | undefined = context?.cronStore;
      if (!cronStore) return "Error: cron store not available";
      try {
        const tasks = (await cronStore.listTasks()).map(toCronTask);

        if (tasks.length === 0) {
          return "No scheduled jobs.";
        }

        return tasks
          .map(
            (t) =>
              `- ${t.name} [${t.enabled ? "active" : "done"}]` +
              `\n  prompt: "${t.prompt}"` +
              `\n  next: ${isoOf(t.nextRunAt) || "n/a"}` +
              (t.recurring ? `\n  repeats every ${(t.intervalMs ?? 0) / 60000}m` : "") +
              (t.lastRunAt ? `\n  last ran: ${isoOf(t.lastRunAt)}` : "")
          )
          .join("\n\n");
      } catch (err) {
        return `Error listing jobs: ${errMessage(err)}`;
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
    execute: async (
      input: JsonObject,
      signal: AbortSignal | undefined,
      context: AgentContext,
    ): Promise<ToolResult> => {
      const cronStore: CronStore | null | undefined = context?.cronStore;
      if (!cronStore) return "Error: cron store not available";
      try {
        const jobId = typeof input.job_id === "string" ? input.job_id : String(input.job_id);
        const task = await cronStore.getTask(jobId);
        if (!task) return `Error: job ${input.job_id} not found.`;
        if (task.name === 'heartbeat') return "Error: cannot modify system jobs.";
        const enabled = input.enabled === true;
        await cronStore.toggleTask(jobId, enabled);
        return `Job ${input.job_id} ${enabled ? 'enabled' : 'disabled'}.`;
      } catch (err) {
        return `Error toggling job: ${errMessage(err)}`;
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
    execute: async (
      input: JsonObject,
      signal: AbortSignal | undefined,
      context: AgentContext,
    ): Promise<ToolResult> => {
      const cronStore: CronStore | null | undefined = context?.cronStore;
      if (!cronStore) return "Error: cron store not available";
      try {
        const jobId = typeof input.job_id === "string" ? input.job_id : String(input.job_id);
        const task = await cronStore.getTask(jobId);
        if (!task) return `Error: job ${input.job_id} not found.`;
        if (task.name === 'heartbeat') return "Error: cannot delete system jobs.";
        await cronStore.deleteTask(jobId);
        return `Job ${input.job_id} cancelled.`;
      } catch (err) {
        return `Error cancelling job: ${errMessage(err)}`;
      }
    },
  },
];

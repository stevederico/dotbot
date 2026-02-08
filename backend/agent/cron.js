// agent/cron.js
// Scheduled tasks system. The agent can create tasks that fire at a specific time
// or on a recurring schedule. When a task fires, it injects a synthetic message
// into the agent loop — same as if a user sent it.

let collection = null;
let onTaskFire = null; // callback set by the gateway
let pollInterval = null;

/**
 * Initialize cron system
 *
 * @param {import('mongodb').Db} db - MongoDB database
 * @param {Function} callback - Called when a task fires: (task) => Promise<void>
 */
export async function initCron(db, callback) {
  collection = db.collection("cron_tasks");
  onTaskFire = callback;

  await collection.createIndex({ nextRunAt: 1 }).catch(() => {});
  await collection.createIndex({ sessionId: 1 }).catch(() => {});

  // Start polling every 30 seconds
  pollInterval = setInterval(checkTasks, 30 * 1000);
  // Also check immediately on startup
  await checkTasks();

  console.log("[cron] initialized, polling every 30s");
}

/**
 * Stop the cron polling loop
 */
export function stopCron() {
  if (pollInterval) clearInterval(pollInterval);
}

/**
 * Check for tasks that are due and fire them
 */
async function checkTasks() {
  if (!collection || !onTaskFire) return;

  const now = new Date();

  // Find all tasks that are due
  const dueTasks = await collection
    .find({ nextRunAt: { $lte: now }, enabled: true })
    .toArray();

  for (const task of dueTasks) {
    try {
      // Fire the task
      await onTaskFire(task);

      if (task.recurring && task.intervalMs) {
        // Recurring: schedule the next run
        const nextRun = new Date(now.getTime() + task.intervalMs);
        await collection.updateOne(
          { _id: task._id },
          { $set: { nextRunAt: nextRun, lastRunAt: now } }
        );
      } else {
        // One-shot: disable after firing
        await collection.updateOne(
          { _id: task._id },
          { $set: { enabled: false, lastRunAt: now } }
        );
      }
    } catch (err) {
      console.error(`[cron] error firing task ${task.name}:`, err.message);
    }
  }
}

/**
 * Create a scheduled task
 *
 * @param {Object} params
 * @param {string} params.name - Short task name
 * @param {string} params.prompt - Message to inject when task fires
 * @param {string} [params.sessionId] - Session to inject into (default "default")
 * @param {string} params.runAt - ISO 8601 datetime for first run
 * @param {number} [params.intervalMs] - Repeat interval in milliseconds
 * @param {boolean} [params.recurring] - Whether task repeats
 * @returns {Promise<Object>} Created task document
 */
export async function createTask({ name, prompt, sessionId, runAt, intervalMs, recurring }) {
  const task = {
    name,
    prompt,
    sessionId: sessionId || "default",
    nextRunAt: new Date(runAt),
    intervalMs: intervalMs || null,
    recurring: recurring || false,
    enabled: true,
    createdAt: new Date(),
    lastRunAt: null,
  };

  const result = await collection.insertOne(task);
  return { id: result.insertedId, ...task };
}

/**
 * List tasks for a session
 *
 * @param {string} [sessionId] - Session ID to filter by
 * @returns {Promise<Array>} Task list sorted by next run time
 */
export async function listTasks(sessionId) {
  return await collection
    .find({ sessionId: sessionId || "default" })
    .sort({ nextRunAt: 1 })
    .toArray()
    .then((docs) =>
      docs.map((d) => ({
        id: d._id.toString(),
        name: d.name,
        prompt: d.prompt,
        nextRunAt: d.nextRunAt,
        recurring: d.recurring,
        intervalMs: d.intervalMs,
        enabled: d.enabled,
        lastRunAt: d.lastRunAt,
      }))
    );
}

/**
 * Delete a task by its MongoDB ObjectId
 *
 * @param {string} id - Task document ID
 * @returns {Promise<import('mongodb').DeleteResult>}
 */
export async function deleteTask(id) {
  const { ObjectId } = await import("mongodb");
  return await collection.deleteOne({ _id: new ObjectId(id) });
}

/**
 * Parse a human-friendly interval string to milliseconds
 *
 * @param {string} str - Interval string e.g. "5m", "2h", "1d", "1w"
 * @returns {number|null} Milliseconds or null if invalid
 */
function parseInterval(str) {
  const match = str.match(/^(\d+)\s*(s|m|h|d|w)$/i);
  if (!match) return null;
  const num = parseInt(match[1]);
  const unit = match[2].toLowerCase();
  const multipliers = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 };
  return num * multipliers[unit];
}

// ── Tool definitions for the agent ──

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
    execute: async (input) => {
      try {
        const intervalMs = input.interval ? parseInterval(input.interval) : null;
        const recurring = !!intervalMs;

        const task = await createTask({
          name: input.name,
          prompt: input.prompt,
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
    execute: async () => {
      try {
        const tasks = await listTasks();

        if (tasks.length === 0) {
          return "No scheduled tasks.";
        }

        return tasks
          .map(
            (t) =>
              `• ${t.name} [${t.enabled ? "active" : "done"}]` +
              `\n  prompt: "${t.prompt}"` +
              `\n  next: ${t.nextRunAt?.toISOString() || "n/a"}` +
              (t.recurring ? `\n  repeats every ${t.intervalMs / 60000}m` : "") +
              (t.lastRunAt ? `\n  last ran: ${t.lastRunAt.toISOString()}` : "")
          )
          .join("\n\n");
      } catch (err) {
        return `Error listing tasks: ${err.message}`;
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
    execute: async (input) => {
      try {
        await deleteTask(input.task_id);
        return `Task ${input.task_id} cancelled.`;
      } catch (err) {
        return `Error cancelling task: ${err.message}`;
      }
    },
  },
];

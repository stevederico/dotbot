/**
 * Task Management Tools
 *
 * Multi-step autonomous task execution with progress tracking.
 * Tasks can run in auto mode where steps execute sequentially via cron.
 */

import type {
  AgentContext,
  JsonObject,
  JsonValue,
  ToolDefinition,
  ToolResult,
} from "../types.js";

/** Delay (ms) before scheduling the next auto-mode step via cron. */
const AUTO_STEP_DELAY_MS = 5 * 1000; // 5 seconds between auto steps

/** Extract a human-readable message from an unknown thrown value. */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A normalized step on a task (as stored by task_plan / task_work). */
interface TaskStep {
  text: string;
  action: string;
  done: boolean;
  result: string | null;
  startedAt: string | null;
  completedAt: string | null;
  /** Index signature so a TaskStep is assignable to JsonValue (it is plain JSON). */
  [key: string]: JsonValue;
}

/** A step object as received from the task_plan tool input. */
interface TaskPlanStepInput {
  text: string;
  action?: string;
}

/**
 * A task record as returned by the TaskStore. Modeled structurally from the
 * fields read in this module; the underlying adapter may carry more.
 */
interface TaskRecord {
  id?: string;
  _id?: { toString(): string };
  description?: string;
  steps?: TaskStep[];
  category?: string;
  priority?: string;
  mode?: string;
  status?: string;
  progress?: number;
}

/** Write result shape shared by Mongo-style and SQLite-style adapters. */
interface WriteResult {
  modifiedCount?: number;
  deletedCount?: number;
  changes?: number;
}

/** Aggregate task statistics returned by TaskStore.getTaskStats(). */
interface TaskStats {
  total: number;
  pending: number;
  in_progress: number;
  completed: number;
  overdue: number;
  by_category: Record<string, number>;
}

/**
 * The concrete TaskStore method surface used by these tools. The shared
 * `TaskStore` type in types.js is intentionally loose (index signature), so we
 * narrow it to this richer local view before calling.
 */
interface TaskStoreApi {
  createTask(task: Record<string, unknown>): Promise<TaskRecord>;
  getTasks(userId: string | undefined, filters: JsonObject): Promise<TaskRecord[]>;
  getTask(userId: string | undefined, taskId: unknown): Promise<TaskRecord | null>;
  updateTask(
    userId: string | undefined,
    taskId: unknown,
    updates: Record<string, unknown>,
  ): Promise<WriteResult>;
  deleteTask(userId: string | undefined, taskId: unknown): Promise<WriteResult>;
  searchTasks(userId: string | undefined, query: unknown): Promise<TaskRecord[]>;
  getTaskStats(userId: string | undefined): Promise<TaskStats>;
}

/**
 * Type guard narrowing the loose shared TaskStore to the local TaskStoreApi
 * method surface. The shared `TaskStore` type is intentionally loose, so we
 * verify the methods are callable before treating it as the richer interface.
 */
function isTaskStore(store: unknown): store is TaskStoreApi {
  if (store === null || typeof store !== "object") return false;
  const methods = [
    "createTask",
    "getTasks",
    "getTask",
    "updateTask",
    "deleteTask",
    "searchTasks",
    "getTaskStats",
  ];
  return methods.every((m) => typeof Reflect.get(store, m) === "function");
}

/** Resolve a task's id from either the SQLite `id` or Mongo `_id`. */
function taskIdOf(task: TaskRecord): string | undefined {
  return task.id ?? task._id?.toString();
}

/**
 * Assert an array element looked up by a validated index is present.
 * With noUncheckedIndexedAccess, indexed access is `T | undefined`; callers
 * derive the index from findIndex (already checked !== -1), so this guards an
 * unreachable case and narrows the type. Thrown errors are caught by callers.
 */
function requireStep(step: TaskStep | undefined): TaskStep {
  if (!step) throw new Error("step index out of range");
  return step;
}

export const taskTools: ToolDefinition[] = [
  {
    name: "task_create",
    description:
      "Create a new task with optional steps, priority, deadline, and category. " +
      "Use mode='auto' for autonomous execution where steps run sequentially without user prompting.",
    parameters: {
      type: "object",
      properties: {
        description: {
          type: "string",
          description: "What the user wants to achieve",
        },
        steps: {
          type: "array",
          items: { type: "string" },
          description: "Optional list of step descriptions to break the task into subtasks",
        },
        category: {
          type: "string",
          description: "Category: fitness, learning, productivity, creative, health, financial, personal, work, other. Default: general",
        },
        priority: {
          type: "string",
          description: "Priority level: low, medium, high, critical. Default: medium",
        },
        deadline: {
          type: "string",
          description: "Optional deadline as ISO date string, e.g. '2026-03-01'",
        },
        mode: {
          type: "string",
          enum: ["manual", "auto"],
          description: "Execution mode: 'manual' (user-driven) or 'auto' (autonomous). Default: auto",
        },
      },
      required: ["description"],
    },
    execute: async (
      input: JsonObject,
      signal: AbortSignal | undefined,
      context: AgentContext,
    ): Promise<ToolResult> => {
      const taskStore = context?.taskStore;
      if (!isTaskStore(taskStore)) return "Error: taskStore not available";
      try {
        const task = await taskStore.createTask({
          userId: context.userID,
          description: input.description,
          steps: input.steps || [],
          category: input.category || 'general',
          priority: input.priority || 'medium',
          deadline: input.deadline || null,
          mode: input.mode || 'auto',
        });

        const taskId = taskIdOf(task);
        const steps: TaskStep[] = task.steps ?? [];

        return `Task created: "${input.description}" (ID: ${taskId})\n` +
               `Mode: ${task.mode}, Priority: ${task.priority}, Steps: ${steps.length}` +
               (task.mode === 'auto' && steps.length > 0 ?
                 `\n\nCall task_work with task_id "${taskId}" to start executing steps automatically.` : '');
      } catch (err) {
        return `Error creating task: ${errMessage(err)}`;
      }
    },
  },

  {
    name: "task_list",
    description: "List all tasks for the user, optionally filtered by status or category.",
    parameters: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["pending", "in_progress", "completed"],
          description: "Filter by status (optional)",
        },
        category: {
          type: "string",
          description: "Filter by category (optional)",
        },
      },
    },
    execute: async (
      input: JsonObject,
      signal: AbortSignal | undefined,
      context: AgentContext,
    ): Promise<ToolResult> => {
      const taskStore = context?.taskStore;
      if (!isTaskStore(taskStore)) return "Error: taskStore not available";
      try {
        const filters: JsonObject = {};
        if (input.status) filters.status = input.status;
        if (input.category) filters.category = input.category;

        const tasks = await taskStore.getTasks(context.userID, filters);

        if (tasks.length === 0) {
          return input.status || input.category
            ? `No tasks found matching filters.`
            : `No tasks yet. Create one with task_create.`;
        }

        return tasks.map((g, i) => {
          const taskId = taskIdOf(g);
          const doneCount = g.steps?.filter(s => s.done).length || 0;
          const totalSteps = g.steps?.length || 0;
          const progress = totalSteps > 0 ? `${doneCount}/${totalSteps} steps` : 'No steps';
          const status = g.status === 'completed' ? '✓' : g.status === 'in_progress' ? '▶' : '○';
          return `${status} [${taskId}] ${g.description} [${g.priority}] - ${progress} (${g.progress}%)`;
        }).join('\n');
      } catch (err) {
        return `Error listing tasks: ${errMessage(err)}`;
      }
    },
  },

  {
    name: "task_plan",
    description:
      "Break down a task into detailed steps with action prompts. Use this to add or replace steps on an existing task.",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "The task ID" },
        steps: {
          type: "array",
          items: {
            type: "object",
            properties: {
              text: { type: "string", description: "Human-readable step description" },
              action: { type: "string", description: "Detailed action prompt for the agent" },
            },
            required: ["text"],
          },
          description: "Array of step objects with text and optional action prompts",
        },
      },
      required: ["task_id", "steps"],
    },
    execute: async (
      input: JsonObject,
      signal: AbortSignal | undefined,
      context: AgentContext,
    ): Promise<ToolResult> => {
      const taskStore = context?.taskStore;
      if (!isTaskStore(taskStore)) return "Error: taskStore not available";
      try {
        const task = await taskStore.getTask(context.userID, input.task_id);
        if (!task) return "Task not found.";

        const inputSteps: TaskPlanStepInput[] = Array.isArray(input.steps)
          ? input.steps.flatMap((s) =>
              s && typeof s === "object" && !Array.isArray(s) && typeof s.text === "string"
                ? [{ text: s.text, action: typeof s.action === "string" ? s.action : undefined }]
                : [],
            )
          : [];
        const normalizedSteps: TaskStep[] = inputSteps.map((s) => ({
          text: s.text,
          action: s.action || s.text,
          done: false,
          result: null,
          startedAt: null,
          completedAt: null,
        }));

        await taskStore.updateTask(context.userID, input.task_id, {
          steps: normalizedSteps,
          mode: "auto",
          status: "in_progress",
          currentStep: 0,
        });

        const stepList = normalizedSteps.map((s, i) => `  ${i + 1}. ${s.text}`).join("\n");
        return `Task planned with ${normalizedSteps.length} steps and set to auto mode:\n${stepList}\n\nCall task_work with task_id "${input.task_id}" to start executing the first step.`;
      } catch (err) {
        return `Error planning task: ${errMessage(err)}`;
      }
    },
  },

  {
    name: "task_work",
    description:
      "Start executing the next pending step on a task. Returns the step's action prompt. " +
      "After completing the action, call task_step_done to record the result.",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "The task ID to work on" },
      },
      required: ["task_id"],
    },
    execute: async (
      input: JsonObject,
      signal: AbortSignal | undefined,
      context: AgentContext,
    ): Promise<ToolResult> => {
      const taskStore = context?.taskStore;
      if (!isTaskStore(taskStore)) return "Error: taskStore not available";
      try {
        const task = await taskStore.getTask(context.userID, input.task_id);
        if (!task) return "Task not found.";
        if (!task.steps || task.steps.length === 0) {
          return "Task has no steps. Use task_plan to add steps first.";
        }

        // Find next undone step
        const stepIdx = task.steps.findIndex(s => !s.done);
        if (stepIdx === -1) {
          return "All steps are already complete. Use task_complete to finish the task.";
        }

        const step = requireStep(task.steps[stepIdx]);

        // Mark step as started
        const steps = [...task.steps];
        steps[stepIdx] = { ...step, startedAt: new Date().toISOString() };

        await taskStore.updateTask(context.userID, input.task_id, {
          steps,
          currentStep: stepIdx,
          lastWorkedAt: new Date().toISOString(),
          status: "in_progress",
        });

        const progress = `Step ${stepIdx + 1} of ${task.steps.length}`;
        return (
          `[${progress}] "${step.text}"\n\n` +
          `Action: ${step.action || step.text}\n\n` +
          `Execute this action now, then call task_step_done with task_id "${input.task_id}" and a result summary.`
        );
      } catch (err) {
        return `Error starting work: ${errMessage(err)}`;
      }
    },
  },

  {
    name: "task_step_done",
    description:
      "Mark the current in-progress step as completed and record its result. " +
      "If the task is in auto mode and more steps remain, schedules the next step via cron.",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "The task ID" },
        result: { type: "string", description: "Summary of what was accomplished in this step" },
      },
      required: ["task_id", "result"],
    },
    execute: async (
      input: JsonObject,
      signal: AbortSignal | undefined,
      context: AgentContext,
    ): Promise<ToolResult> => {
      const taskStore = context?.taskStore;
      if (!isTaskStore(taskStore)) return "Error: taskStore not available";
      try {
        const task = await taskStore.getTask(context.userID, input.task_id);
        if (!task) return "Task not found.";

        // Find the current in-progress step
        const currentSteps = task.steps ?? [];
        const stepIdx = currentSteps.findIndex(s => s.startedAt && !s.done);
        if (stepIdx === -1) return "No in-progress step found. Call task_work first.";

        const steps = [...currentSteps];
        steps[stepIdx] = {
          ...requireStep(steps[stepIdx]),
          done: true,
          result: typeof input.result === "string" ? input.result : String(input.result),
          completedAt: new Date().toISOString(),
        };

        const nextStepIdx = steps.findIndex(s => !s.done);
        const allDone = nextStepIdx === -1;

        const updates: JsonObject = {
          steps,
          currentStep: allDone ? steps.length : nextStepIdx,
          lastWorkedAt: new Date().toISOString(),
        };

        if (allDone) {
          updates.status = "completed";
        }

        await taskStore.updateTask(context.userID, input.task_id, updates);

        // In auto mode with remaining steps, schedule next step via cron
        if (!allDone && task.mode === "auto" && context.cronStore) {
          try {
            await context.cronStore.createTask({
              name: "task_step",
              prompt: `Continue working on task ${input.task_id}. Execute the next pending step.`,
              userId: context.userID ?? null,
              sessionId: typeof context.sessionId === "string" ? context.sessionId : null,
              runAt: new Date(Date.now() + AUTO_STEP_DELAY_MS).toISOString(),
              taskId: input.task_id,
            });
          } catch (err) {
            console.error("[tasks] failed to schedule next step:", errMessage(err));
          }
        }

        const doneCount = steps.filter(s => s.done).length;
        if (allDone) {
          return `Step ${stepIdx + 1} completed. All ${steps.length} steps done — task marked as completed!`;
        }
        return (
          `Step ${stepIdx + 1} completed (${doneCount}/${steps.length}).` +
          (task.mode === "auto" ? " Next step scheduled automatically." : " Call task_work to continue.")
        );
      } catch (err) {
        return `Error completing step: ${errMessage(err)}`;
      }
    },
  },

  {
    name: "task_complete",
    description: "Mark a task as completed.",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "The task ID to complete" },
      },
      required: ["task_id"],
    },
    execute: async (
      input: JsonObject,
      signal: AbortSignal | undefined,
      context: AgentContext,
    ): Promise<ToolResult> => {
      const taskStore = context?.taskStore;
      if (!isTaskStore(taskStore)) return "Error: taskStore not available";
      try {
        const result = await taskStore.updateTask(
          context.userID,
          input.task_id,
          { status: "completed" }
        );

        if ((result.modifiedCount ?? 0) > 0 || (result.changes ?? 0) > 0) {
          return `Task ${input.task_id} marked as completed.`;
        }
        return "Task not found.";
      } catch (err) {
        return `Error completing task: ${errMessage(err)}`;
      }
    },
  },

  {
    name: "task_delete",
    description: "Delete a task permanently.",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "The task ID to delete" },
      },
      required: ["task_id"],
    },
    execute: async (
      input: JsonObject,
      signal: AbortSignal | undefined,
      context: AgentContext,
    ): Promise<ToolResult> => {
      const taskStore = context?.taskStore;
      if (!isTaskStore(taskStore)) return "Error: taskStore not available";
      try {
        const result = await taskStore.deleteTask(context.userID, input.task_id);
        return ((result.deletedCount ?? 0) > 0 || (result.changes ?? 0) > 0) ? `Task ${input.task_id} deleted.` : "Task not found.";
      } catch (err) {
        return `Error deleting task: ${errMessage(err)}`;
      }
    },
  },

  {
    name: "task_search",
    description: "Search tasks by text in description or steps.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
      },
      required: ["query"],
    },
    execute: async (
      input: JsonObject,
      signal: AbortSignal | undefined,
      context: AgentContext,
    ): Promise<ToolResult> => {
      const taskStore = context?.taskStore;
      if (!isTaskStore(taskStore)) return "Error: taskStore not available";
      try {
        const tasks = await taskStore.searchTasks(context.userID, input.query);
        if (tasks.length === 0) return `No tasks matching "${input.query}".`;
        return tasks.map((g, i) => {
          const progress = `${g.progress}%`;
          return `${i + 1}. ${g.description} [${g.category}] - ${progress}`;
        }).join('\n');
      } catch (err) {
        return `Error searching tasks: ${errMessage(err)}`;
      }
    },
  },

  {
    name: "task_stats",
    description: "Get task statistics (total, completed, in progress, by category, etc.).",
    parameters: {
      type: "object",
      properties: {},
    },
    execute: async (
      input: JsonObject,
      signal: AbortSignal | undefined,
      context: AgentContext,
    ): Promise<ToolResult> => {
      const taskStore = context?.taskStore;
      if (!isTaskStore(taskStore)) return "Error: taskStore not available";
      try {
        const stats = await taskStore.getTaskStats(context.userID);
        let output = `Total: ${stats.total}, Pending: ${stats.pending}, In Progress: ${stats.in_progress}, Completed: ${stats.completed}`;
        if (stats.overdue > 0) output += `, Overdue: ${stats.overdue}`;
        if (Object.keys(stats.by_category).length > 0) {
          output += `\n\nBy Category:\n`;
          for (const [cat, count] of Object.entries(stats.by_category)) {
            output += `  ${cat}: ${count}\n`;
          }
        }
        return output;
      } catch (err) {
        return `Error getting stats: ${errMessage(err)}`;
      }
    },
  },
];

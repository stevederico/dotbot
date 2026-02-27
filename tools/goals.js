/**
 * Goal Management Tools
 *
 * Multi-step autonomous goal execution with progress tracking.
 * Goals can run in auto mode where steps execute sequentially via cron.
 */

/** Delay (ms) before scheduling the next auto-mode step via cron. */
const AUTO_STEP_DELAY_MS = 5 * 1000; // 5 seconds between auto steps

export const goalTools = [
  {
    name: "goal_create",
    description:
      "Create a new goal with optional steps, priority, deadline, and category. " +
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
          description: "Optional list of step descriptions to break the goal into subtasks",
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
    execute: async (input, signal, context) => {
      if (!context?.goalStore) return "Error: goalStore not available";
      try {
        const goal = await context.goalStore.createGoal({
          userId: context.userID,
          description: input.description,
          steps: input.steps || [],
          category: input.category || 'general',
          priority: input.priority || 'medium',
          deadline: input.deadline || null,
          mode: input.mode || 'auto',
        });

        const goalId = goal.id || goal._id?.toString();

        return `Goal created: "${input.description}" (ID: ${goalId})\n` +
               `Mode: ${goal.mode}, Priority: ${goal.priority}, Steps: ${goal.steps.length}` +
               (goal.mode === 'auto' && goal.steps.length > 0 ?
                 `\n\nCall goal_work with goal_id "${goalId}" to start executing steps automatically.` : '');
      } catch (err) {
        return `Error creating goal: ${err.message}`;
      }
    },
  },

  {
    name: "goal_list",
    description: "List all goals for the user, optionally filtered by status or category.",
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
    execute: async (input, signal, context) => {
      if (!context?.goalStore) return "Error: goalStore not available";
      try {
        const filters = {};
        if (input.status) filters.status = input.status;
        if (input.category) filters.category = input.category;

        const goals = await context.goalStore.getGoals(context.userID, filters);

        if (goals.length === 0) {
          return input.status || input.category
            ? `No goals found matching filters.`
            : `No goals yet. Create one with goal_create.`;
        }

        return goals.map((g, i) => {
          const goalId = g.id || g._id?.toString();
          const doneCount = g.steps?.filter(s => s.done).length || 0;
          const totalSteps = g.steps?.length || 0;
          const progress = totalSteps > 0 ? `${doneCount}/${totalSteps} steps` : 'No steps';
          const status = g.status === 'completed' ? '✓' : g.status === 'in_progress' ? '▶' : '○';
          return `${status} [${goalId}] ${g.description} [${g.priority}] - ${progress} (${g.progress}%)`;
        }).join('\n');
      } catch (err) {
        return `Error listing goals: ${err.message}`;
      }
    },
  },

  {
    name: "goal_plan",
    description:
      "Break down a goal into detailed steps with action prompts. Use this to add or replace steps on an existing goal.",
    parameters: {
      type: "object",
      properties: {
        goal_id: { type: "string", description: "The goal ID" },
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
      required: ["goal_id", "steps"],
    },
    execute: async (input, signal, context) => {
      if (!context?.goalStore) return "Error: goalStore not available";
      try {
        const goal = await context.goalStore.getGoal(context.userID, input.goal_id);
        if (!goal) return "Goal not found.";

        const normalizedSteps = input.steps.map(s => ({
          text: s.text,
          action: s.action || s.text,
          done: false,
          result: null,
          startedAt: null,
          completedAt: null,
        }));

        await context.goalStore.updateGoal(context.userID, input.goal_id, {
          steps: normalizedSteps,
          mode: "auto",
          status: "in_progress",
          currentStep: 0,
        });

        const stepList = normalizedSteps.map((s, i) => `  ${i + 1}. ${s.text}`).join("\n");
        return `Goal planned with ${normalizedSteps.length} steps and set to auto mode:\n${stepList}\n\nCall goal_work with goal_id "${input.goal_id}" to start executing the first step.`;
      } catch (err) {
        return `Error planning goal: ${err.message}`;
      }
    },
  },

  {
    name: "goal_work",
    description:
      "Start executing the next pending step on a goal. Returns the step's action prompt. " +
      "After completing the action, call goal_step_done to record the result.",
    parameters: {
      type: "object",
      properties: {
        goal_id: { type: "string", description: "The goal ID to work on" },
      },
      required: ["goal_id"],
    },
    execute: async (input, signal, context) => {
      if (!context?.goalStore) return "Error: goalStore not available";
      try {
        const goal = await context.goalStore.getGoal(context.userID, input.goal_id);
        if (!goal) return "Goal not found.";
        if (!goal.steps || goal.steps.length === 0) {
          return "Goal has no steps. Use goal_plan to add steps first.";
        }

        // Find next undone step
        const stepIdx = goal.steps.findIndex(s => !s.done);
        if (stepIdx === -1) {
          return "All steps are already complete. Use goal_complete to finish the goal.";
        }

        const step = goal.steps[stepIdx];

        // Mark step as started
        const steps = [...goal.steps];
        steps[stepIdx] = { ...steps[stepIdx], startedAt: new Date().toISOString() };

        await context.goalStore.updateGoal(context.userID, input.goal_id, {
          steps,
          currentStep: stepIdx,
          lastWorkedAt: new Date().toISOString(),
          status: "in_progress",
        });

        const progress = `Step ${stepIdx + 1} of ${goal.steps.length}`;
        return (
          `[${progress}] "${step.text}"\n\n` +
          `Action: ${step.action || step.text}\n\n` +
          `Execute this action now, then call goal_step_done with goal_id "${input.goal_id}" and a result summary.`
        );
      } catch (err) {
        return `Error starting work: ${err.message}`;
      }
    },
  },

  {
    name: "goal_step_done",
    description:
      "Mark the current in-progress step as completed and record its result. " +
      "If the goal is in auto mode and more steps remain, schedules the next step via cron.",
    parameters: {
      type: "object",
      properties: {
        goal_id: { type: "string", description: "The goal ID" },
        result: { type: "string", description: "Summary of what was accomplished in this step" },
      },
      required: ["goal_id", "result"],
    },
    execute: async (input, signal, context) => {
      if (!context?.goalStore) return "Error: goalStore not available";
      try {
        const goal = await context.goalStore.getGoal(context.userID, input.goal_id);
        if (!goal) return "Goal not found.";

        // Find the current in-progress step
        const stepIdx = goal.steps.findIndex(s => s.startedAt && !s.done);
        if (stepIdx === -1) return "No in-progress step found. Call goal_work first.";

        const steps = [...goal.steps];
        steps[stepIdx] = {
          ...steps[stepIdx],
          done: true,
          result: input.result,
          completedAt: new Date().toISOString(),
        };

        const nextStepIdx = steps.findIndex(s => !s.done);
        const allDone = nextStepIdx === -1;

        const updates = {
          steps,
          currentStep: allDone ? steps.length : nextStepIdx,
          lastWorkedAt: new Date().toISOString(),
        };

        if (allDone) {
          updates.status = "completed";
        }

        await context.goalStore.updateGoal(context.userID, input.goal_id, updates);

        // In auto mode with remaining steps, schedule next step via cron
        if (!allDone && goal.mode === "auto" && context.cronStore) {
          try {
            await context.cronStore.createTask({
              name: "goal_step",
              prompt: `Continue working on goal ${input.goal_id}. Execute the next pending step.`,
              userId: context.userID,
              sessionId: context.sessionId,
              runAt: new Date(Date.now() + AUTO_STEP_DELAY_MS).toISOString(),
              goalId: input.goal_id,
            });
          } catch (err) {
            console.error("[goals] failed to schedule next step:", err.message);
          }
        }

        const doneCount = steps.filter(s => s.done).length;
        if (allDone) {
          return `Step ${stepIdx + 1} completed. All ${steps.length} steps done — goal marked as completed!`;
        }
        return (
          `Step ${stepIdx + 1} completed (${doneCount}/${steps.length}).` +
          (goal.mode === "auto" ? " Next step scheduled automatically." : " Call goal_work to continue.")
        );
      } catch (err) {
        return `Error completing step: ${err.message}`;
      }
    },
  },

  {
    name: "goal_complete",
    description: "Mark a goal as completed.",
    parameters: {
      type: "object",
      properties: {
        goal_id: { type: "string", description: "The goal ID to complete" },
      },
      required: ["goal_id"],
    },
    execute: async (input, signal, context) => {
      if (!context?.goalStore) return "Error: goalStore not available";
      try {
        const result = await context.goalStore.updateGoal(
          context.userID,
          input.goal_id,
          { status: "completed" }
        );

        if (result.modifiedCount > 0) {
          return `Goal ${input.goal_id} marked as completed.`;
        }
        return "Goal not found.";
      } catch (err) {
        return `Error completing goal: ${err.message}`;
      }
    },
  },

  {
    name: "goal_delete",
    description: "Delete a goal permanently.",
    parameters: {
      type: "object",
      properties: {
        goal_id: { type: "string", description: "The goal ID to delete" },
      },
      required: ["goal_id"],
    },
    execute: async (input, signal, context) => {
      if (!context?.goalStore) return "Error: goalStore not available";
      try {
        const result = await context.goalStore.deleteGoal(context.userID, input.goal_id);
        return result.deletedCount > 0 ? `Goal ${input.goal_id} deleted.` : "Goal not found.";
      } catch (err) {
        return `Error deleting goal: ${err.message}`;
      }
    },
  },

  {
    name: "goal_search",
    description: "Search goals by text in description or steps.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
      },
      required: ["query"],
    },
    execute: async (input, signal, context) => {
      if (!context?.goalStore) return "Error: goalStore not available";
      try {
        const goals = await context.goalStore.searchGoals(context.userID, input.query);
        if (goals.length === 0) return `No goals matching "${input.query}".`;
        return goals.map((g, i) => {
          const progress = `${g.progress}%`;
          return `${i + 1}. ${g.description} [${g.category}] - ${progress}`;
        }).join('\n');
      } catch (err) {
        return `Error searching goals: ${err.message}`;
      }
    },
  },

  {
    name: "goal_stats",
    description: "Get goal statistics (total, completed, in progress, by category, etc.).",
    parameters: {
      type: "object",
      properties: {},
    },
    execute: async (input, signal, context) => {
      if (!context?.goalStore) return "Error: goalStore not available";
      try {
        const stats = await context.goalStore.getGoalStats(context.userID);
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
        return `Error getting stats: ${err.message}`;
      }
    },
  },
];

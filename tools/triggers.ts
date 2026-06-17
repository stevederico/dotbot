/**
 * Trigger Tools
 *
 * Event-driven agent responses. Triggers fire when specific events occur,
 * injecting prompts into the agent conversation for context-aware assistance.
 */

import type {
  AgentContext,
  JsonObject,
  JsonValue,
  ToolDefinition,
  ToolResult,
} from "../types.js";

/** Extract a human-readable message from an unknown thrown value. */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A trigger record as returned by the TriggerStore. */
interface TriggerRecord {
  id?: string;
  eventType: string;
  prompt: string;
  cooldownMs?: number;
  metadata?: Record<string, JsonValue>;
  enabled?: boolean;
  fireCount?: number;
}

/** Write result shape shared by Mongo-style and SQLite-style adapters. */
interface WriteResult {
  modifiedCount?: number;
  deletedCount?: number;
  changes?: number;
}

/**
 * The concrete TriggerStore method surface used by these tools. The shared
 * `TriggerStore` type in types.js is intentionally loose (index signature), so
 * we narrow it to this richer local view before calling.
 */
interface TriggerStoreApi {
  createTrigger(trigger: Record<string, unknown>): Promise<TriggerRecord>;
  listTriggers(userId: string | undefined, filters: JsonObject): Promise<TriggerRecord[]>;
  toggleTrigger(
    userId: string | undefined,
    triggerId: unknown,
    enabled: unknown,
  ): Promise<WriteResult>;
  deleteTrigger(userId: string | undefined, triggerId: unknown): Promise<WriteResult>;
}

/**
 * Type guard narrowing the loose shared TriggerStore to the local
 * TriggerStoreApi method surface.
 */
function isTriggerStore(store: unknown): store is TriggerStoreApi {
  if (store === null || typeof store !== "object") return false;
  const methods = ["createTrigger", "listTriggers", "toggleTrigger", "deleteTrigger"];
  return methods.every((m) => typeof Reflect.get(store, m) === "function");
}

export const triggerTools: ToolDefinition[] = [
  {
    name: "trigger_create",
    description:
      "Create an event-driven trigger that fires when a specific event occurs. " +
      "Use cooldownMs to prevent spam (e.g., trigger max once per hour). " +
      "Metadata can filter events (e.g., only fire for specific app names).",
    parameters: {
      type: "object",
      properties: {
        eventType: {
          type: "string",
          description: "Event type (user-defined string). Examples: app_opened, goal_completed, error_occurred, data_updated, task_completed, or any custom event",
        },
        prompt: {
          type: "string",
          description: "Prompt to inject into agent conversation when event fires",
        },
        cooldownMs: {
          type: "number",
          description: "Cooldown period in milliseconds (e.g., 3600000 for 1 hour). Default: 0 (no cooldown)",
        },
        metadata: {
          type: "object",
          description: "Optional metadata for filtering events (e.g., { appName: 'Mail' } for app_opened events)",
        },
      },
      required: ["eventType", "prompt"],
    },
    execute: async (
      input: JsonObject,
      signal: AbortSignal | undefined,
      context: AgentContext,
    ): Promise<ToolResult> => {
      const triggerStore = context?.triggerStore;
      if (!isTriggerStore(triggerStore)) return "Error: triggerStore not available";
      try {
        await triggerStore.createTrigger({
          userId: context.userID,
          eventType: input.eventType,
          prompt: input.prompt,
          cooldownMs: input.cooldownMs || 0,
          metadata: input.metadata || {},
          enabled: true,
        });

        const cooldown = typeof input.cooldownMs === "number" && input.cooldownMs
          ? ` (cooldown: ${Math.round(input.cooldownMs / 1000)}s)`
          : '';
        return `Trigger created for event "${input.eventType}"${cooldown}`;
      } catch (err) {
        return `Error creating trigger: ${errMessage(err)}`;
      }
    },
  },

  {
    name: "trigger_list",
    description: "List all triggers, optionally filtered by enabled status or event type.",
    parameters: {
      type: "object",
      properties: {
        enabled: {
          type: "boolean",
          description: "Filter by enabled status (optional)",
        },
        eventType: {
          type: "string",
          description: "Filter by event type (optional)",
        },
      },
    },
    execute: async (
      input: JsonObject,
      signal: AbortSignal | undefined,
      context: AgentContext,
    ): Promise<ToolResult> => {
      const triggerStore = context?.triggerStore;
      if (!isTriggerStore(triggerStore)) return "Error: triggerStore not available";
      try {
        const filters: JsonObject = {};
        if (input.enabled !== undefined) filters.enabled = input.enabled;
        if (input.eventType) filters.eventType = input.eventType;

        const triggers = await triggerStore.listTriggers(context.userID, filters);

        if (triggers.length === 0) {
          return input.enabled !== undefined || input.eventType
            ? "No triggers found matching filters."
            : "No triggers yet. Create one with trigger_create.";
        }

        return triggers.map((t, i) => {
          const status = t.enabled ? '✓' : '✗';
          const cooldown = t.cooldownMs ? ` (cooldown: ${Math.round(t.cooldownMs / 1000)}s)` : '';
          const fires = (t.fireCount ?? 0) > 0 ? ` [fired ${t.fireCount}x]` : '';
          const metadata = t.metadata || {};
          const meta = Object.keys(metadata).length > 0
            ? ` {${Object.entries(metadata).map(([k, v]) => `${k}:${v}`).join(', ')}}`
            : '';
          return `${status} ${t.eventType}${meta}${cooldown}${fires}\n   → "${t.prompt.slice(0, 60)}${t.prompt.length > 60 ? '...' : ''}"`;
        }).join('\n\n');
      } catch (err) {
        return `Error listing triggers: ${errMessage(err)}`;
      }
    },
  },

  {
    name: "trigger_toggle",
    description: "Enable or disable a trigger without deleting it.",
    parameters: {
      type: "object",
      properties: {
        trigger_id: { type: "string", description: "The trigger ID to toggle" },
        enabled: { type: "boolean", description: "true to enable, false to disable" },
      },
      required: ["trigger_id", "enabled"],
    },
    execute: async (
      input: JsonObject,
      signal: AbortSignal | undefined,
      context: AgentContext,
    ): Promise<ToolResult> => {
      const triggerStore = context?.triggerStore;
      if (!isTriggerStore(triggerStore)) return "Error: triggerStore not available";
      try {
        const result = await triggerStore.toggleTrigger(
          context.userID,
          input.trigger_id,
          input.enabled
        );
        if ((result.modifiedCount ?? 0) > 0) {
          return `Trigger ${input.trigger_id} ${input.enabled ? 'enabled' : 'disabled'}.`;
        }
        return "Trigger not found.";
      } catch (err) {
        return `Error toggling trigger: ${errMessage(err)}`;
      }
    },
  },

  {
    name: "trigger_delete",
    description: "Delete a trigger permanently.",
    parameters: {
      type: "object",
      properties: {
        trigger_id: { type: "string", description: "The trigger ID to delete" },
      },
      required: ["trigger_id"],
    },
    execute: async (
      input: JsonObject,
      signal: AbortSignal | undefined,
      context: AgentContext,
    ): Promise<ToolResult> => {
      const triggerStore = context?.triggerStore;
      if (!isTriggerStore(triggerStore)) return "Error: triggerStore not available";
      try {
        const result = await triggerStore.deleteTrigger(
          context.userID,
          input.trigger_id
        );
        return (result.deletedCount ?? 0) > 0
          ? `Trigger ${input.trigger_id} deleted.`
          : "Trigger not found.";
      } catch (err) {
        return `Error deleting trigger: ${errMessage(err)}`;
      }
    },
  },
];

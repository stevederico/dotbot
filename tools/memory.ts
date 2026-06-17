// agent/memory.js
// Agent memory tools that write to the shared Memory collection via memoryStore.
// Uses SQLiteMemoryStore or any compatible store implementation.

import type { ToolDefinition, ToolResult } from "../types.js";

/** Extract a human-readable message from an unknown thrown value. */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The structured value an agent memory stores. */
interface MemoryValue {
  content?: string;
  tags?: string[];
  source?: string;
}

/**
 * A memory record as returned by the MemoryStore. `value` may be a structured
 * object (MemoryValue) or an arbitrary JSON value depending on the writer.
 */
interface MemoryRecord {
  key: string;
  value: MemoryValue | unknown;
  updated_at?: string | number;
  app_id?: string;
}

/** Narrow an unknown memory store row into a MemoryRecord. */
function toMemoryRecord(row: unknown): MemoryRecord | null {
  if (row === null || typeof row !== "object") return null;
  const r: Record<string, unknown> = { ...row };
  if (typeof r.key !== "string") return null;
  return {
    key: r.key,
    value: r.value,
    updated_at:
      typeof r.updated_at === "string" || typeof r.updated_at === "number"
        ? r.updated_at
        : undefined,
    app_id: typeof r.app_id === "string" ? r.app_id : undefined,
  };
}

/** Type guard for a structured MemoryValue object (vs a primitive value). */
function isMemoryValue(value: unknown): value is MemoryValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Render a memory's value as display text (content field or JSON). */
function valueContent(value: unknown): string {
  if (isMemoryValue(value) && typeof value.content === "string") {
    return value.content;
  }
  return JSON.stringify(value);
}

/** Render a memory's tags suffix, if any. */
function tagsSuffix(value: unknown, prefix: string): string {
  if (isMemoryValue(value) && Array.isArray(value.tags) && value.tags.length) {
    return `${prefix}${value.tags.join(", ")}`;
  }
  return "";
}

/**
 * Generate a slug-style key from content text.
 * Takes the first ~50 characters, strips non-alphanumeric chars, and joins with underscores.
 *
 * @param content - Raw content string
 * @returns Cleaned key like "users_favorite_color_is_blue"
 */
function generateMemoryKey(content: string): string {
  return content
    .slice(0, 50)
    .replace(/[^a-zA-Z0-9 ]/g, "")
    .trim()
    .replace(/\s+/g, "_")
    .toLowerCase();
}

// ── Tool definitions for the agent ──

export const memoryTools: ToolDefinition[] = [
  {
    name: "memory_save",
    description:
      "Save an important fact, preference, or piece of information to long-term memory. Use this when the user tells you something worth remembering for future conversations — their name, preferences, projects, goals, important dates, etc. Be selective: only save things that would be useful to recall later.",
    parameters: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description:
            "The information to remember. Write it as a clear, standalone fact. e.g. 'User's name is Steve. He is a full-stack developer based in SF.'",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description:
            "Short tags for categorization. e.g. ['personal', 'name'] or ['project', 'myapp']",
        },
      },
      required: ["content"],
    },
    /** Save a memory via memoryStore.writeMemory. */
    execute: async (input, signal, context): Promise<ToolResult> => {
      try {
        const { userID, memoryStore } = context;
        if (!memoryStore) {
          return "Error: memoryStore not configured. Memory features are disabled.";
        }
        const content = typeof input.content === "string" ? input.content : String(input.content);
        const key = generateMemoryKey(content);
        const value: MemoryValue = {
          content,
          tags: Array.isArray(input.tags) ? input.tags.filter((t): t is string => typeof t === "string") : [],
          source: "agent",
        };
        await memoryStore.writeMemory(userID ?? "", key, value, "agent");
        return `Saved to memory: "${content}"`;
      } catch (err) {
        return `Error saving memory: ${errMessage(err)}`;
      }
    },
  },

  {
    name: "memory_search",
    description:
      "Search long-term memory for previously saved information. Use this when the user references something from a past conversation, asks 'do you remember...', or when context from past interactions would help you give a better answer.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "What to search for in memory. Use keywords related to the topic.",
        },
      },
      required: ["query"],
    },
    /** Search memories via memoryStore.readMemoryPattern and filter by query. */
    execute: async (input, signal, context): Promise<ToolResult> => {
      try {
        const { userID, memoryStore } = context;
        if (!memoryStore) {
          return "Error: memoryStore not configured. Memory features are disabled.";
        }
        const all = (await memoryStore.readMemoryPattern(userID ?? "", ".*"))
          .map(toMemoryRecord)
          .filter((m): m is MemoryRecord => m !== null);

        const query = (typeof input.query === "string" ? input.query : String(input.query)).toLowerCase();
        const matches = all
          .filter((m) => {
            const valStr =
              typeof m.value === "object" && m.value !== null
                ? JSON.stringify(m.value)
                : String(m.value);
            return (
              m.key.toLowerCase().includes(query) ||
              valStr.toLowerCase().includes(query)
            );
          })
          .slice(0, 5);

        if (matches.length === 0) {
          return "No matching memories found.";
        }

        return matches
          .map((m, i) => {
            const content = valueContent(m.value);
            const tags = tagsSuffix(m.value, "\n   tags: ");
            const saved = m.updated_at
              ? `\n   saved: ${new Date(m.updated_at).toISOString()}`
              : "";
            return `${i + 1}. ${content}${tags}${saved}`;
          })
          .join("\n\n");
      } catch (err) {
        return `Error searching memory: ${errMessage(err)}`;
      }
    },
  },

  {
    name: "memory_delete",
    description:
      "Delete a specific memory by its key. Use this when the user asks to forget something or remove outdated information.",
    parameters: {
      type: "object",
      properties: {
        key: {
          type: "string",
          description: "The memory key to delete. Use memory_search first to find the key.",
        },
      },
      required: ["key"],
    },
    /** Delete a memory via memoryStore.deleteMemory. */
    execute: async (input, signal, context): Promise<ToolResult> => {
      try {
        const { userID, memoryStore } = context;
        if (!memoryStore) {
          return "Error: memoryStore not configured. Memory features are disabled.";
        }
        const key = typeof input.key === "string" ? input.key : String(input.key);
        const result = await memoryStore.deleteMemory(userID ?? "", key);
        return (result.deletedCount ?? 0) > 0 ? `Memory "${input.key}" deleted.` : "Memory not found.";
      } catch (err) {
        return `Error deleting memory: ${errMessage(err)}`;
      }
    },
  },

  {
    name: "memory_list",
    description:
      "List all memories saved in the knowledge graph. Returns all memory keys and their content. Use this when you need to see everything that's stored, or when the user asks 'what do you remember about me' or 'show me all my memories'.",
    parameters: {
      type: "object",
      properties: {},
    },
    /** List all memories via memoryStore.readMemoryPattern. */
    execute: async (input, signal, context): Promise<ToolResult> => {
      try {
        const { userID, memoryStore } = context;
        if (!memoryStore) {
          return "Error: memoryStore not configured. Memory features are disabled.";
        }
        const all = (await memoryStore.readMemoryPattern(userID ?? "", ".*"))
          .map(toMemoryRecord)
          .filter((m): m is MemoryRecord => m !== null);

        if (all.length === 0) {
          return "No memories found.";
        }

        return `Found ${all.length} ${all.length === 1 ? 'memory' : 'memories'}:\n\n` +
          all.map((m, i) => {
            const content = valueContent(m.value);
            const tags = tagsSuffix(m.value, "\n   tags: ");
            const saved = m.updated_at
              ? `\n   saved: ${new Date(m.updated_at).toISOString()}`
              : "";
            return `${i + 1}. [${m.key}]\n   ${content}${tags}${saved}`;
          }).join("\n\n");
      } catch (err) {
        return `Error listing memories: ${errMessage(err)}`;
      }
    },
  },

  {
    name: "memory_read",
    description:
      "Read a specific memory by its exact key. Use this when you know the key and want to retrieve its full content.",
    parameters: {
      type: "object",
      properties: {
        key: {
          type: "string",
          description: "The exact memory key to read. Use memory_list or memory_search to find keys.",
        },
      },
      required: ["key"],
    },
    /** Read a specific memory via memoryStore.readMemory. */
    execute: async (input, signal, context): Promise<ToolResult> => {
      try {
        const { userID, memoryStore } = context;
        if (!memoryStore) {
          return "Error: memoryStore not configured. Memory features are disabled.";
        }
        const key = typeof input.key === "string" ? input.key : String(input.key);
        const memory = toMemoryRecord(await memoryStore.readMemory(userID ?? "", key));

        if (!memory || memory.value === undefined || memory.value === null) {
          return `Memory "${input.key}" not found.`;
        }

        const content =
          isMemoryValue(memory.value) && typeof memory.value.content === "string"
            ? memory.value.content
            : JSON.stringify(memory.value, null, 2);
        const tags = tagsSuffix(memory.value, "\ntags: ");
        const saved = memory.updated_at
          ? `\nsaved: ${new Date(memory.updated_at).toISOString()}`
          : "";
        const app = memory.app_id ? `\nwritten by: ${memory.app_id}` : "";

        return `[${input.key}]\n${content}${tags}${saved}${app}`;
      } catch (err) {
        return `Error reading memory: ${errMessage(err)}`;
      }
    },
  },

  {
    name: "memory_update",
    description:
      "Update an existing memory or create a new one with a specific key. Use this when you need to modify existing information or when you want full control over the memory key (unlike memory_save which auto-generates keys).",
    parameters: {
      type: "object",
      properties: {
        key: {
          type: "string",
          description: "The memory key to update or create. Use snake_case like 'user_preferences' or 'project_notes'.",
        },
        content: {
          type: "string",
          description: "The new content to store. Can be plain text, markdown, or any string.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Optional tags for categorization. e.g. ['personal', 'project']",
        },
      },
      required: ["key", "content"],
    },
    /** Update or create a memory via memoryStore.writeMemory. */
    execute: async (input, signal, context): Promise<ToolResult> => {
      try {
        const { userID, memoryStore } = context;
        if (!memoryStore) {
          return "Error: memoryStore not configured. Memory features are disabled.";
        }
        const key = typeof input.key === "string" ? input.key : String(input.key);
        const value: MemoryValue = {
          content: typeof input.content === "string" ? input.content : String(input.content),
          tags: Array.isArray(input.tags) ? input.tags.filter((t): t is string => typeof t === "string") : [],
          source: "agent",
        };
        await memoryStore.writeMemory(userID ?? "", key, value, "agent");
        return `Memory "${input.key}" saved.`;
      } catch (err) {
        return `Error updating memory: ${errMessage(err)}`;
      }
    },
  },
];

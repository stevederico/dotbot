// agent/memory.js
// Agent memory tools that write to the shared Memory collection via databaseManager.
// This ensures memories saved by the agent appear in the Memories App UI.

/**
 * Generate a slug-style key from content text.
 * Takes the first ~50 characters, strips non-alphanumeric chars, and joins with underscores.
 *
 * @param {string} content - Raw content string
 * @returns {string} Cleaned key like "users_favorite_color_is_blue"
 */
function generateMemoryKey(content) {
  return content
    .slice(0, 50)
    .replace(/[^a-zA-Z0-9 ]/g, "")
    .trim()
    .replace(/\s+/g, "_")
    .toLowerCase();
}

// ── Tool definitions for the agent ──

export const memoryTools = [
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
            "Short tags for categorization. e.g. ['personal', 'name'] or ['project', 'dottie']",
        },
      },
      required: ["content"],
    },
    /**
     * Save a memory via databaseManager.writeMemory so it appears in the Memories App.
     *
     * @param {Object} input - Tool input with content and optional tags
     * @param {AbortSignal} signal - Abort signal
     * @param {Object} context - { userID, databaseManager, dbConfig }
     * @returns {Promise<string>} Confirmation message
     */
    execute: async (input, signal, context) => {
      try {
        const { userID, databaseManager, dbConfig } = context;
        const key = generateMemoryKey(input.content);
        const value = {
          content: input.content,
          tags: input.tags || [],
          source: "agent",
        };
        await databaseManager.writeMemory(
          dbConfig.dbType,
          dbConfig.db,
          dbConfig.connectionString,
          userID,
          key,
          value,
          "agent"
        );
        return `Saved to memory: "${input.content}"`;
      } catch (err) {
        return `Error saving memory: ${err.message}`;
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
    /**
     * Search memories via databaseManager.readMemoryPattern and filter by query.
     *
     * @param {Object} input - Tool input with query string
     * @param {AbortSignal} signal - Abort signal
     * @param {Object} context - { userID, databaseManager, dbConfig }
     * @returns {Promise<string>} Formatted search results or "no matches" message
     */
    execute: async (input, signal, context) => {
      try {
        const { userID, databaseManager, dbConfig } = context;
        const all = await databaseManager.readMemoryPattern(
          dbConfig.dbType,
          dbConfig.db,
          dbConfig.connectionString,
          userID,
          ".*"
        );

        const query = input.query.toLowerCase();
        const matches = all
          .filter((m) => {
            const valStr =
              typeof m.value === "object"
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
            const content =
              typeof m.value === "object" && m.value.content
                ? m.value.content
                : JSON.stringify(m.value);
            const tags =
              typeof m.value === "object" && m.value.tags?.length
                ? `\n   tags: ${m.value.tags.join(", ")}`
                : "";
            const saved = m.updated_at
              ? `\n   saved: ${new Date(m.updated_at).toISOString()}`
              : "";
            return `${i + 1}. ${content}${tags}${saved}`;
          })
          .join("\n\n");
      } catch (err) {
        return `Error searching memory: ${err.message}`;
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
    /**
     * Delete a memory via databaseManager.deleteMemory.
     *
     * @param {Object} input - Tool input with key
     * @param {AbortSignal} signal - Abort signal
     * @param {Object} context - { userID, databaseManager, dbConfig }
     * @returns {Promise<string>} Confirmation message
     */
    execute: async (input, signal, context) => {
      try {
        const { userID, databaseManager, dbConfig } = context;
        const result = await databaseManager.deleteMemory(
          dbConfig.dbType, dbConfig.db, dbConfig.connectionString, userID, input.key
        );
        return result.deletedCount > 0 ? `Memory "${input.key}" deleted.` : "Memory not found.";
      } catch (err) {
        return `Error deleting memory: ${err.message}`;
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
    /**
     * List all memories via databaseManager.readMemoryPattern.
     *
     * @param {Object} input - Tool input (empty)
     * @param {AbortSignal} signal - Abort signal
     * @param {Object} context - { userID, databaseManager, dbConfig }
     * @returns {Promise<string>} Formatted list of all memories
     */
    execute: async (input, signal, context) => {
      try {
        const { userID, databaseManager, dbConfig } = context;
        const all = await databaseManager.readMemoryPattern(
          dbConfig.dbType,
          dbConfig.db,
          dbConfig.connectionString,
          userID,
          ".*"
        );

        if (all.length === 0) {
          return "No memories found.";
        }

        return `Found ${all.length} ${all.length === 1 ? 'memory' : 'memories'}:\n\n` +
          all.map((m, i) => {
            const content =
              typeof m.value === "object" && m.value.content
                ? m.value.content
                : JSON.stringify(m.value);
            const tags =
              typeof m.value === "object" && m.value.tags?.length
                ? `\n   tags: ${m.value.tags.join(", ")}`
                : "";
            const saved = m.updated_at
              ? `\n   saved: ${new Date(m.updated_at).toISOString()}`
              : "";
            return `${i + 1}. [${m.key}]\n   ${content}${tags}${saved}`;
          }).join("\n\n");
      } catch (err) {
        return `Error listing memories: ${err.message}`;
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
    /**
     * Read a specific memory via databaseManager.readMemory.
     *
     * @param {Object} input - Tool input with key
     * @param {AbortSignal} signal - Abort signal
     * @param {Object} context - { userID, databaseManager, dbConfig }
     * @returns {Promise<string>} Memory content or not found message
     */
    execute: async (input, signal, context) => {
      try {
        const { userID, databaseManager, dbConfig } = context;
        const memory = await databaseManager.readMemory(
          dbConfig.dbType,
          dbConfig.db,
          dbConfig.connectionString,
          userID,
          input.key
        );

        if (!memory || !memory.value) {
          return `Memory "${input.key}" not found.`;
        }

        const content =
          typeof memory.value === "object" && memory.value.content
            ? memory.value.content
            : JSON.stringify(memory.value, null, 2);
        const tags =
          typeof memory.value === "object" && memory.value.tags?.length
            ? `\ntags: ${memory.value.tags.join(", ")}`
            : "";
        const saved = memory.updated_at
          ? `\nsaved: ${new Date(memory.updated_at).toISOString()}`
          : "";
        const app = memory.app_id ? `\nwritten by: ${memory.app_id}` : "";

        return `[${input.key}]\n${content}${tags}${saved}${app}`;
      } catch (err) {
        return `Error reading memory: ${err.message}`;
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
    /**
     * Update or create a memory via databaseManager.writeMemory.
     *
     * @param {Object} input - Tool input with key, content, and optional tags
     * @param {AbortSignal} signal - Abort signal
     * @param {Object} context - { userID, databaseManager, dbConfig }
     * @returns {Promise<string>} Confirmation message
     */
    execute: async (input, signal, context) => {
      try {
        const { userID, databaseManager, dbConfig } = context;
        const value = {
          content: input.content,
          tags: input.tags || [],
          source: "agent",
        };
        await databaseManager.writeMemory(
          dbConfig.dbType,
          dbConfig.db,
          dbConfig.connectionString,
          userID,
          input.key,
          value,
          "agent"
        );
        return `Memory "${input.key}" saved.`;
      } catch (err) {
        return `Error updating memory: ${err.message}`;
      }
    },
  },
];

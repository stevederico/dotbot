// agent/memory.js
// Simple memory system using MongoDB. The agent decides when to save and search.
// Memories are stored as documents with text content and metadata.
// Search uses MongoDB text index for full-text search.

/**
 * Setup: call initMemory(db) once at startup with your MongoDB db instance.
 *
 *   import { initMemory } from "./memory.js";
 *   const client = new MongoClient(MONGO_URI);
 *   const db = client.db("dotbot");
 *   await initMemory(db);
 */

let collection = null;

/**
 * Initialize memory collection with text index
 *
 * @param {import('mongodb').Db} db - MongoDB database instance
 */
export async function initMemory(db) {
  collection = db.collection("memories");

  // Create text index for search
  await collection.createIndex(
    { content: "text", tags: "text" },
    { name: "memory_text_search" }
  ).catch(() => {
    // Index may already exist, that's fine
  });

  console.log("[memory] initialized with MongoDB");
}

/**
 * Save a memory document
 *
 * @param {Object} params
 * @param {string} params.content - The information to remember
 * @param {string[]} [params.tags] - Short tags for categorization
 * @param {string} [params.source] - Origin of the memory (default "agent")
 * @returns {Promise<Object>} Saved memory with generated ID
 */
export async function saveMemory({ content, tags = [], source = "agent" }) {
  if (!collection) throw new Error("Memory not initialized. Call initMemory(db) first.");

  const doc = {
    content,
    tags,
    source,
    createdAt: new Date(),
  };

  const result = await collection.insertOne(doc);
  return { id: result.insertedId, ...doc };
}

/**
 * Search memories by text query using MongoDB full-text search
 *
 * @param {string} query - Search query string
 * @param {number} [limit=5] - Max results to return
 * @returns {Promise<Array>} Matching memories sorted by relevance score
 */
export async function searchMemory(query, limit = 5) {
  if (!collection) throw new Error("Memory not initialized. Call initMemory(db) first.");

  const results = await collection
    .find(
      { $text: { $search: query } },
      { score: { $meta: "textScore" } }
    )
    .sort({ score: { $meta: "textScore" } })
    .limit(limit)
    .toArray();

  return results.map((r) => ({
    id: r._id,
    content: r.content,
    tags: r.tags,
    source: r.source,
    createdAt: r.createdAt,
    score: r.score,
  }));
}

/**
 * List recent memories sorted by creation date
 *
 * @param {number} [limit=10] - Max results to return
 * @returns {Promise<Array>} Recent memories
 */
export async function recentMemories(limit = 10) {
  if (!collection) throw new Error("Memory not initialized. Call initMemory(db) first.");

  return await collection
    .find({})
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray();
}

/**
 * Delete a memory by its MongoDB ObjectId
 *
 * @param {string} id - Memory document ID
 * @returns {Promise<import('mongodb').DeleteResult>}
 */
export async function deleteMemory(id) {
  if (!collection) throw new Error("Memory not initialized. Call initMemory(db) first.");

  const { ObjectId } = await import("mongodb");
  return await collection.deleteOne({ _id: new ObjectId(id) });
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
    execute: async (input) => {
      try {
        const result = await saveMemory({
          content: input.content,
          tags: input.tags || [],
          source: "agent",
        });
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
          description: "What to search for in memory. Use keywords related to the topic.",
        },
      },
      required: ["query"],
    },
    execute: async (input) => {
      try {
        const results = await searchMemory(input.query, 5);

        if (results.length === 0) {
          return "No matching memories found.";
        }

        return results
          .map(
            (r, i) =>
              `${i + 1}. ${r.content}` +
              (r.tags?.length ? `\n   tags: ${r.tags.join(", ")}` : "") +
              `\n   saved: ${r.createdAt?.toISOString?.() || "unknown"}`
          )
          .join("\n\n");
      } catch (err) {
        return `Error searching memory: ${err.message}`;
      }
    },
  },
];

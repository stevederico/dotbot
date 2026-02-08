// agent/session.js
// Multi-session store backed by MongoDB. Each user can have many conversations.

import crypto from "crypto";

let collection = null;

/**
 * Build the system prompt with current timestamp
 *
 * @returns {string} System prompt for the DotBot agent
 */
function buildSystemPrompt() {
  const now = new Date().toISOString();
  return `You are a helpful personal AI assistant called DotBot.
You have access to tools for searching the web, reading/writing files, fetching URLs, running code, long-term memory, and scheduled tasks.
The current date and time is ${now}.

Use tools when they would help answer the user's question — don't guess when you can look things up.
Keep responses concise and useful. When you use a tool, explain what you found.

Memory guidelines:
- When the user shares personal info (name, preferences, projects, goals), save it with memory_save.
- When the user references past conversations or asks "do you remember", search with memory_search.
- Be selective — only save things worth recalling in future conversations.
- Don't announce every memory save unless the user would want to know.

Scheduling guidelines:
- When the user asks for a reminder, periodic check, or recurring task, use schedule_task.
- Write the prompt as if the user is asking you to do something when the task fires.
- For recurring tasks, suggest a reasonable interval if the user doesn't specify one.

Proactive behavior:
- When you receive a [Heartbeat] message, review your memories and think about what would be useful to the user right now.
- Search for relevant news, check on their projects, or prepare information they might need.
- Only act if you have something genuinely useful. If not, do nothing — don't generate filler.
- When you do act proactively, prefix your response with a robot emoji so the user knows it was self-initiated.`;
}

/**
 * Initialize session store with MongoDB
 *
 * Creates indexes and migrates legacy single-session documents (where id === userID)
 * into the multi-session schema with owner, title, and UUID-based id.
 *
 * @param {import('mongodb').Db} db - MongoDB database instance
 */
export async function initSessions(db) {
  collection = db.collection("sessions");
  await collection.createIndex({ id: 1 }, { unique: true }).catch(() => {});
  await collection.createIndex({ owner: 1, updatedAt: -1 }).catch(() => {});

  // Migrate legacy sessions: documents without an `owner` field
  // are old single-session-per-user docs where id was the userID.
  const legacy = await collection.find({ owner: { $exists: false } }).toArray();
  for (const doc of legacy) {
    const oldId = doc.id;
    const newId = crypto.randomUUID();
    // Derive title from first user message if available
    const firstUserMsg = doc.messages?.find((m) => m.role === "user");
    const title = firstUserMsg ? firstUserMsg.content.slice(0, 60) : "";
    await collection.updateOne(
      { _id: doc._id },
      { $set: { id: newId, owner: oldId, title, updatedAt: doc.updatedAt || new Date() } }
    );
  }

  if (legacy.length > 0) {
    console.log(`[sessions] migrated ${legacy.length} legacy session(s)`);
  }

  console.log("[sessions] initialized with MongoDB (multi-session)");
}

/**
 * Create a new session for a user
 *
 * @param {string} owner - User ID who owns this session
 * @param {string} [model="gpt-oss:20b"] - Initial Ollama model name
 * @returns {Promise<Object>} Newly created session document
 */
export async function createSession(owner, model = "gpt-oss:20b") {
  if (!collection) throw new Error("Sessions not initialized. Call initSessions(db) first.");

  const session = {
    id: crypto.randomUUID(),
    owner,
    title: "",
    messages: [{ role: "system", content: buildSystemPrompt() }],
    model,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  await collection.insertOne(session);
  return session;
}

/**
 * Get the most recent session for a user, or create one if none exist
 *
 * @param {string} owner - User ID
 * @returns {Promise<Object>} Session document
 */
export async function getOrCreateDefaultSession(owner) {
  if (!collection) throw new Error("Sessions not initialized. Call initSessions(db) first.");

  let session = await collection.findOne({ owner }, { sort: { updatedAt: -1 } });
  if (!session) {
    session = await createSession(owner);
  } else {
    // Refresh system prompt timestamp
    session.messages[0] = { role: "system", content: buildSystemPrompt() };
  }
  return session;
}

/**
 * Get a session by its UUID, verifying ownership
 *
 * Always refreshes the system prompt to update the current timestamp.
 *
 * @param {string} sessionId - Session UUID
 * @param {string} owner - User ID (for ownership verification)
 * @returns {Promise<Object|null>} Session document or null if not found/not owned
 */
export async function getSession(sessionId, owner) {
  if (!collection) throw new Error("Sessions not initialized. Call initSessions(db) first.");

  const session = await collection.findOne({ id: sessionId, owner });
  if (!session) return null;

  // Refresh system prompt timestamp
  session.messages[0] = { role: "system", content: buildSystemPrompt() };
  return session;
}

/**
 * Get a session by ID without ownership check (for cron/internal use)
 *
 * @param {string} sessionId - Session UUID
 * @returns {Promise<Object|null>} Session document or null
 */
export async function getSessionInternal(sessionId) {
  if (!collection) throw new Error("Sessions not initialized. Call initSessions(db) first.");

  const session = await collection.findOne({ id: sessionId });
  if (!session) return null;

  session.messages[0] = { role: "system", content: buildSystemPrompt() };
  return session;
}

/**
 * Save messages back to MongoDB after agent loop
 *
 * Auto-sets title from first user message if currently empty.
 *
 * @param {string} sessionId - Session UUID
 * @param {Array} messages - Full conversation history
 * @param {string} model - Current model name
 */
export async function saveSession(sessionId, messages, model) {
  const update = {
    messages,
    model,
    updatedAt: new Date(),
  };

  // Auto-populate title from first user message if empty
  const session = await collection.findOne({ id: sessionId });
  if (session && !session.title) {
    const firstUserMsg = messages.find((m) => m.role === "user");
    if (firstUserMsg) {
      update.title = firstUserMsg.content.slice(0, 60);
    }
  }

  await collection.updateOne({ id: sessionId }, { $set: update });
}

/**
 * Add a single message to a session and persist
 *
 * @param {string} sessionId - Session UUID
 * @param {Object} message - Message object with role and content
 * @returns {Promise<Object>} Updated session
 */
export async function addMessage(sessionId, message) {
  const session = await getSessionInternal(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);
  session.messages.push(message);
  await saveSession(sessionId, session.messages, session.model);
  return session;
}

/**
 * Set the model for a session
 *
 * @param {string} sessionId - Session UUID
 * @param {string} model - Ollama model name
 */
export async function setModel(sessionId, model) {
  await collection.updateOne({ id: sessionId }, { $set: { model, updatedAt: new Date() } });
}

/**
 * Clear a session's conversation history (keeps system prompt)
 *
 * @param {string} sessionId - Session UUID
 */
export async function clearSession(sessionId) {
  const messages = [{ role: "system", content: buildSystemPrompt() }];
  await collection.updateOne(
    { id: sessionId },
    { $set: { messages, updatedAt: new Date() } }
  );
}

/**
 * List all sessions for a user with summary info
 *
 * @param {string} owner - User ID
 * @returns {Promise<Array>} Session summaries sorted by last update (newest first)
 */
export async function listSessions(owner) {
  return await collection
    .find({ owner }, { projection: { id: 1, title: 1, model: 1, createdAt: 1, updatedAt: 1 } })
    .sort({ updatedAt: -1 })
    .limit(50)
    .toArray()
    .then((docs) =>
      docs.map((d) => ({
        id: d.id,
        title: d.title || "",
        model: d.model,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
      }))
    );
}

/**
 * Delete a session by ID, verifying ownership
 *
 * @param {string} sessionId - Session UUID
 * @param {string} owner - User ID (for ownership verification)
 * @returns {Promise<import('mongodb').DeleteResult>}
 */
export async function deleteSession(sessionId, owner) {
  return await collection.deleteOne({ id: sessionId, owner });
}

/**
 * Trim messages if conversation is too long.
 * Keeps system prompt + last N messages.
 *
 * @param {Array} messages - Full message array
 * @param {number} [maxMessages=40] - Maximum messages to keep
 * @returns {Array} Trimmed message array
 */
export function trimMessages(messages, maxMessages = 40) {
  if (messages.length <= maxMessages) return messages;
  const system = messages[0];
  const recent = messages.slice(-(maxMessages - 1));
  return [system, ...recent];
}

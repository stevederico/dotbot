// agent/session.js
// Session store backed by MongoDB. Conversations persist across server restarts.

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
 * @param {import('mongodb').Db} db - MongoDB database instance
 */
export async function initSessions(db) {
  collection = db.collection("sessions");
  await collection.createIndex({ id: 1 }, { unique: true }).catch(() => {});
  console.log("[sessions] initialized with MongoDB");
}

/**
 * Get or create a session by ID
 *
 * Creates a new session with system prompt if none exists.
 * Always refreshes the system prompt to update the current timestamp.
 *
 * @param {string} id - Session identifier (typically user ID)
 * @returns {Promise<Object>} Session document with messages array
 */
export async function getSession(id) {
  if (!collection) throw new Error("Sessions not initialized. Call initSessions(db) first.");

  let session = await collection.findOne({ id });

  if (!session) {
    session = {
      id,
      messages: [{ role: "system", content: buildSystemPrompt() }],
      model: "gpt-oss:20b",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await collection.insertOne(session);
  } else {
    // Always refresh the system prompt (updates current time)
    session.messages[0] = { role: "system", content: buildSystemPrompt() };
  }

  return session;
}

/**
 * Save messages back to MongoDB after agent loop
 *
 * @param {string} id - Session identifier
 * @param {Array} messages - Full conversation history
 * @param {string} model - Current model name
 */
export async function saveSession(id, messages, model) {
  await collection.updateOne(
    { id },
    {
      $set: {
        messages,
        model,
        updatedAt: new Date(),
      },
    }
  );
}

/**
 * Add a single message to a session and persist
 *
 * @param {string} id - Session identifier
 * @param {Object} message - Message object with role and content
 * @returns {Promise<Object>} Updated session
 */
export async function addMessage(id, message) {
  const session = await getSession(id);
  session.messages.push(message);
  await saveSession(id, session.messages, session.model);
  return session;
}

/**
 * Set the model for a session
 *
 * @param {string} id - Session identifier
 * @param {string} model - Ollama model name
 */
export async function setModel(id, model) {
  await collection.updateOne({ id }, { $set: { model, updatedAt: new Date() } });
}

/**
 * Clear a session's conversation history (keeps system prompt)
 *
 * @param {string} id - Session identifier
 */
export async function clearSession(id) {
  const messages = [{ role: "system", content: buildSystemPrompt() }];
  await collection.updateOne(
    { id },
    { $set: { messages, updatedAt: new Date() } },
    { upsert: true }
  );
}

/**
 * List all sessions with summary info
 *
 * @returns {Promise<Array>} Session summaries sorted by last update
 */
export async function listSessions() {
  return await collection
    .find({}, { projection: { id: 1, model: 1, createdAt: 1, updatedAt: 1 } })
    .sort({ updatedAt: -1 })
    .limit(50)
    .toArray()
    .then((docs) =>
      docs.map((d) => ({
        id: d.id,
        model: d.model,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
      }))
    );
}

/**
 * Delete a session by ID
 *
 * @param {string} id - Session identifier
 * @returns {Promise<import('mongodb').DeleteResult>}
 */
export async function deleteSession(id) {
  return await collection.deleteOne({ id });
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

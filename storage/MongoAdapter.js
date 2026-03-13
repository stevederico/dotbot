import crypto from 'crypto';
import { SessionStore } from './SessionStore.js';
import { toStandardFormat } from '../core/normalize.js';

/**
 * Default system prompt builder for DotBot agent
 *
 * @param {Object} options - Agent identity overrides
 * @param {string} [options.agentName='Dottie'] - Display name
 * @param {string} [options.agentPersonality=''] - Personality/tone
 * @returns {string} System prompt
 */
export function defaultSystemPrompt({ agentName = 'Dottie', agentPersonality = '' } = {}) {
  const now = new Date().toISOString();
  return `You are a helpful personal AI assistant called ${agentName}.${agentPersonality ? `\nYour personality and tone: ${agentPersonality}. Embody this in all responses.` : ''}
You have access to tools for searching the web, reading/writing files, fetching URLs, running code, long-term memory, and scheduled tasks.
The current date and time is ${now}.

Use tools when they would help answer the user's question — don't guess when you can look things up.
Keep responses concise and useful. When you use a tool, explain what you found.

Memory guidelines:
- When the user shares personal info (name, preferences, projects, goals), save it with memory_save.
- When the user references past conversations or asks "do you remember", search with memory_search.
- When the user asks to forget something, use memory_search to find the key, then memory_delete to remove it.
- Be selective — only save things worth recalling in future conversations.
- Don't announce every memory save unless the user would want to know.

Scheduling guidelines:
- When the user asks for a reminder, periodic check, or recurring job, use schedule_job.
- Write the prompt as if the user is asking you to do something when the job fires.
- For recurring jobs, suggest a reasonable interval if the user doesn't specify one.

Follow-up suggestions:
- At the end of every response, suggest one natural follow-up question the user might ask next.
- Format: <followup>Your suggested question here</followup>
- Keep it short, specific to the conversation context, and genuinely useful.
- Do not include the followup tag when using tools or in error responses.`;
}

/**
 * MongoDB-backed SessionStore implementation
 */
export class MongoSessionStore extends SessionStore {
  constructor() {
    super();
    this.collection = null;
    this.prefsFetcher = null;
    this.systemPromptBuilder = defaultSystemPrompt;
    this.heartbeatEnsurer = null;
  }

  /**
   * Initialize MongoDB session store
   *
   * @param {import('mongodb').Db} db - MongoDB database instance
   * @param {Object} [options={}] - Initialization options
   * @param {Function} [options.prefsFetcher] - Async function (userId) => { agentName, agentPersonality }
   * @param {Function} [options.systemPromptBuilder] - Function ({ agentName, agentPersonality }) => string
   * @param {Function} [options.heartbeatEnsurer] - Async function (userId) => Promise<Object|null>
   */
  async init(db, options = {}) {
    this.collection = db.collection('sessions');
    this.prefsFetcher = options.prefsFetcher || null;
    this.systemPromptBuilder = options.systemPromptBuilder || defaultSystemPrompt;
    this.heartbeatEnsurer = options.heartbeatEnsurer || null;

    await this.collection.createIndex({ id: 1 }, { unique: true }).catch(() => {});
    await this.collection.createIndex({ owner: 1, updatedAt: -1 }).catch(() => {});

    // Migrate legacy sessions: documents without an `owner` field
    const legacy = await this.collection.find({ owner: { $exists: false } }).toArray();
    for (const doc of legacy) {
      const oldId = doc.id;
      const newId = crypto.randomUUID();
      const firstUserMsg = doc.messages?.find((m) => m.role === 'user');
      const title = firstUserMsg ? firstUserMsg.content.slice(0, 60) : '';
      await this.collection.updateOne(
        { _id: doc._id },
        { $set: { id: newId, owner: oldId, title, updatedAt: doc.updatedAt || new Date() } }
      );
    }

    if (legacy.length > 0) {
      console.log(`[sessions] migrated ${legacy.length} legacy session(s)`);
    }

    // Migrate existing sessions to standard message format.
    // Detects provider-specific messages by checking for Anthropic content arrays
    // or OpenAI tool_calls properties, then normalizes them. Idempotent — already
    // normalized sessions pass through unchanged.
    const allSessions = await this.collection.find({}).toArray();
    let migrated = 0;
    for (const doc of allSessions) {
      if (!Array.isArray(doc.messages) || doc.messages.length === 0) continue;

      const needsNormalization = doc.messages.some(
        (m) => (m.role === 'assistant' && Array.isArray(m.content)) ||
               (m.role === 'assistant' && m.tool_calls) ||
               (m.role === 'tool') ||
               (m.role === 'user' && Array.isArray(m.content) && m.content.some(b => b.type === 'tool_result'))
      );

      if (needsNormalization) {
        const normalized = toStandardFormat(doc.messages);
        await this.collection.updateOne(
          { _id: doc._id },
          { $set: { messages: normalized } }
        );
        migrated++;
      }
    }

    if (migrated > 0) {
      console.log(`[sessions] normalized messages in ${migrated} session(s)`);
    }

    console.log('[sessions] initialized with MongoDB (multi-session)');
  }

  /**
   * Build system prompt with current timestamp
   *
   * @param {string} owner - User ID
   * @returns {Promise<string>} System prompt
   */
  async buildSystemPrompt(owner) {
    const prefs = this.prefsFetcher ? await this.prefsFetcher(owner) : {};
    return this.systemPromptBuilder(prefs);
  }

  async createSession(owner, model = 'gpt-oss:20b', provider = 'ollama') {
    if (!this.collection) throw new Error('Sessions not initialized. Call init() first.');

    const session = {
      id: crypto.randomUUID(),
      owner,
      title: '',
      messages: [{ role: 'system', content: await this.buildSystemPrompt(owner) }],
      model,
      provider,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await this.collection.insertOne(session);
    return session;
  }

  async getOrCreateDefaultSession(owner) {
    if (!this.collection) throw new Error('Sessions not initialized. Call init() first.');

    let session = await this.collection.findOne({ owner }, { sort: { updatedAt: -1 } });
    if (!session) {
      session = await this.createSession(owner);
    } else {
      // Refresh system prompt timestamp
      session.messages[0] = { role: 'system', content: await this.buildSystemPrompt(owner) };
    }
    if (this.heartbeatEnsurer) {
      this.heartbeatEnsurer(owner).catch((err) => {
        console.error(`[session] failed to ensure heartbeat for ${owner}:`, err.message);
      });
    }
    return session;
  }

  async getSession(sessionId, owner) {
    if (!this.collection) throw new Error('Sessions not initialized. Call init() first.');

    const session = await this.collection.findOne({ id: sessionId, owner });
    if (!session) return null;

    // Refresh system prompt timestamp
    session.messages[0] = { role: 'system', content: await this.buildSystemPrompt(owner) };
    return session;
  }

  async getSessionInternal(sessionId) {
    if (!this.collection) throw new Error('Sessions not initialized. Call init() first.');

    const session = await this.collection.findOne({ id: sessionId });
    if (!session) return null;

    session.messages[0] = { role: 'system', content: await this.buildSystemPrompt(session.owner) };
    return session;
  }

  /**
   * Save session with normalized messages.
   * Converts any provider-specific message formats to standard format before persisting.
   *
   * @param {string} sessionId - Session UUID
   * @param {Array} messages - Messages (provider-specific or standard format)
   * @param {string} model - Model identifier
   * @param {string} [provider] - Provider name
   */
  async saveSession(sessionId, messages, model, provider) {
    const update = {
      messages: toStandardFormat(messages),
      model,
      updatedAt: new Date(),
    };

    if (provider) {
      update.provider = provider;
    }

    // Auto-populate title from first user message if empty
    const session = await this.collection.findOne({ id: sessionId });
    if (session && !session.title) {
      const firstUserMsg = update.messages.find((m) => m.role === 'user');
      if (firstUserMsg && typeof firstUserMsg.content === 'string') {
        update.title = firstUserMsg.content.slice(0, 60);
      }
    }

    await this.collection.updateOne({ id: sessionId }, { $set: update });
  }

  /**
   * Add a message to a session, normalizing to standard format before saving.
   *
   * @param {string} sessionId - Session UUID
   * @param {Object} message - Message object (any provider format)
   * @returns {Promise<Object>} Updated session
   */
  async addMessage(sessionId, message) {
    const session = await this.getSessionInternal(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    if (!message._ts) message._ts = Date.now();
    // Normalize the single message by running it through toStandardFormat,
    // then append all resulting messages (may be 0 if it was a bare tool_result)
    const normalized = toStandardFormat([message]);
    session.messages.push(...normalized);
    await this.saveSession(sessionId, session.messages, session.model);
    return session;
  }

  async setModel(sessionId, model) {
    await this.collection.updateOne({ id: sessionId }, { $set: { model, updatedAt: new Date() } });
  }

  async setProvider(sessionId, provider) {
    await this.collection.updateOne({ id: sessionId }, { $set: { provider, updatedAt: new Date() } });
  }

  async clearSession(sessionId) {
    const session = await this.collection.findOne({ id: sessionId });
    const messages = [{ role: 'system', content: await this.buildSystemPrompt(session?.owner) }];
    await this.collection.updateOne(
      { id: sessionId },
      { $set: { messages, updatedAt: new Date() } }
    );
  }

  async listSessions(owner) {
    return await this.collection
      .aggregate([
        { $match: { owner } },
        { $sort: { updatedAt: -1 } },
        { $limit: 50 },
        {
          $project: {
            id: 1,
            title: 1,
            model: 1,
            provider: 1,
            createdAt: 1,
            updatedAt: 1,
            messageCount: { $size: { $ifNull: ['$messages', []] } }
          }
        }
      ])
      .toArray()
      .then((docs) =>
        docs.map((d) => ({
          id: d.id,
          title: d.title || '',
          model: d.model,
          provider: d.provider || 'ollama',
          createdAt: d.createdAt,
          updatedAt: d.updatedAt,
          messageCount: d.messageCount || 0,
        }))
      );
  }

  async deleteSession(sessionId, owner) {
    return await this.collection.deleteOne({ id: sessionId, owner });
  }
}

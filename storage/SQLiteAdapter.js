import crypto from 'crypto';
import { DatabaseSync } from 'node:sqlite';
import { SessionStore } from './SessionStore.js';
import { toStandardFormat } from '../core/normalize.js';

/**
 * Default system prompt builder for the agent.
 *
 * @param {Object} options - Prompt options
 * @param {string} options.agentName - Agent display name
 * @param {string} options.agentPersonality - Personality description
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
 * SQLite-backed SessionStore implementation
 *
 * Uses Node.js 22.5+ built-in sqlite module for zero-dependency session storage.
 * All dates stored as ISO 8601 strings, messages as JSON TEXT column.
 */
export class SQLiteSessionStore extends SessionStore {
  constructor() {
    super();
    this.db = null;
    this.prefsFetcher = null;
    this.systemPromptBuilder = defaultSystemPrompt;
    this.heartbeatEnsurer = null;
  }

  /**
   * Initialize SQLite session store
   *
   * @param {string} dbPath - Path to SQLite database file
   * @param {Object} [options={}] - Initialization options
   * @param {Function} [options.prefsFetcher] - Async function (userId) => { agentName, agentPersonality }
   * @param {Function} [options.systemPromptBuilder] - Function ({ agentName, agentPersonality }) => string
   * @param {Function} [options.heartbeatEnsurer] - Async function (userId) => Promise<Object|null>
   */
  async init(dbPath, options = {}) {
    this.db = new DatabaseSync(dbPath);
    this.prefsFetcher = options.prefsFetcher || null;
    this.systemPromptBuilder = options.systemPromptBuilder || defaultSystemPrompt;
    this.heartbeatEnsurer = options.heartbeatEnsurer || null;

    // Create schema
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        title TEXT DEFAULT '',
        messages TEXT NOT NULL,
        model TEXT NOT NULL,
        provider TEXT DEFAULT 'ollama',
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_owner_updated
        ON sessions(owner, updatedAt DESC);

      CREATE INDEX IF NOT EXISTS idx_sessions_id
        ON sessions(id);
    `);

    console.log('[sessions] initialized with SQLite (multi-session)');
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
    if (!this.db) throw new Error('Sessions not initialized. Call init() first.');

    const now = new Date();
    const session = {
      id: crypto.randomUUID(),
      owner,
      title: '',
      messages: [{ role: 'system', content: await this.buildSystemPrompt(owner) }],
      model,
      provider,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    const stmt = this.db.prepare(`
      INSERT INTO sessions (id, owner, title, messages, model, provider, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      session.id,
      session.owner,
      session.title,
      JSON.stringify(session.messages),
      session.model,
      session.provider,
      session.createdAt,
      session.updatedAt
    );

    return session;
  }

  async getOrCreateDefaultSession(owner) {
    if (!this.db) throw new Error('Sessions not initialized. Call init() first.');

    const stmt = this.db.prepare(`
      SELECT * FROM sessions WHERE owner = ? ORDER BY updatedAt DESC LIMIT 1
    `);

    const row = stmt.get(owner);

    let session;
    if (!row) {
      session = await this.createSession(owner);
    } else {
      session = this._rowToSession(row);
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
    if (!this.db) throw new Error('Sessions not initialized. Call init() first.');

    const stmt = this.db.prepare(`
      SELECT * FROM sessions WHERE id = ? AND owner = ?
    `);

    const row = stmt.get(sessionId, owner);
    if (!row) return null;

    const session = this._rowToSession(row);
    // Refresh system prompt timestamp
    session.messages[0] = { role: 'system', content: await this.buildSystemPrompt(owner) };
    return session;
  }

  async getSessionInternal(sessionId) {
    if (!this.db) throw new Error('Sessions not initialized. Call init() first.');

    const stmt = this.db.prepare(`
      SELECT * FROM sessions WHERE id = ?
    `);

    const row = stmt.get(sessionId);
    if (!row) return null;

    const session = this._rowToSession(row);
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
    const normalized = toStandardFormat(messages);
    const updateFields = {
      messages: JSON.stringify(normalized),
      model,
      updatedAt: new Date().toISOString(),
    };

    if (provider) {
      updateFields.provider = provider;
    }

    // Auto-populate title from first user message if empty
    const titleStmt = this.db.prepare('SELECT title FROM sessions WHERE id = ?');
    const titleRow = titleStmt.get(sessionId);

    if (titleRow && !titleRow.title) {
      const firstUserMsg = normalized.find((m) => m.role === 'user');
      if (firstUserMsg && typeof firstUserMsg.content === 'string') {
        const rawTitle = firstUserMsg.content.slice(0, 60).trim();
        // Skip generic/short titles
        if (rawTitle.length >= 5 && !/^(msg|test|hi|hey|hello|ok|yo|sup)\d*$/i.test(rawTitle)) {
          updateFields.title = rawTitle;
        }
      }
    }

    // Build dynamic UPDATE query
    const setClause = Object.keys(updateFields).map(key => `${key} = ?`).join(', ');
    const values = Object.values(updateFields);

    const stmt = this.db.prepare(`
      UPDATE sessions SET ${setClause} WHERE id = ?
    `);

    stmt.run(...values, sessionId);
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
    const normalized = toStandardFormat([message]);
    session.messages.push(...normalized);
    await this.saveSession(sessionId, session.messages, session.model);
    return session;
  }

  async setModel(sessionId, model) {
    const stmt = this.db.prepare(`
      UPDATE sessions SET model = ?, updatedAt = ? WHERE id = ?
    `);
    stmt.run(model, new Date().toISOString(), sessionId);
  }

  async setProvider(sessionId, provider) {
    const stmt = this.db.prepare(`
      UPDATE sessions SET provider = ?, updatedAt = ? WHERE id = ?
    `);
    stmt.run(provider, new Date().toISOString(), sessionId);
  }

  /**
   * Update session title.
   *
   * @param {string} sessionId - Session UUID
   * @param {string} title - New title
   */
  async updateTitle(sessionId, title) {
    const stmt = this.db.prepare(`
      UPDATE sessions SET title = ?, updatedAt = ? WHERE id = ?
    `);
    stmt.run(title, new Date().toISOString(), sessionId);
  }

  async clearSession(sessionId) {
    const ownerStmt = this.db.prepare('SELECT owner FROM sessions WHERE id = ?');
    const ownerRow = ownerStmt.get(sessionId);

    const messages = [{ role: 'system', content: await this.buildSystemPrompt(ownerRow?.owner) }];

    const stmt = this.db.prepare(`
      UPDATE sessions SET messages = ?, updatedAt = ? WHERE id = ?
    `);

    stmt.run(JSON.stringify(messages), new Date().toISOString(), sessionId);
  }

  async listSessions(owner) {
    const stmt = this.db.prepare(`
      SELECT id, title, model, provider, messages, createdAt, updatedAt
      FROM sessions
      WHERE owner = ?
      ORDER BY updatedAt DESC
      LIMIT 50
    `);

    const rows = stmt.all(owner);

    return rows.map((row) => {
      let parsedMessages = [];
      try {
        parsedMessages = JSON.parse(row.messages || '[]');
      } catch {
        parsedMessages = [];
      }
      return {
        id: row.id,
        owner: owner,
        title: row.title || '',
        model: row.model,
        provider: row.provider || 'ollama',
        messages: parsedMessages,
        createdAt: new Date(row.createdAt).toISOString(),
        updatedAt: new Date(row.updatedAt).toISOString(),
        messageCount: parsedMessages.length,
      };
    });
  }

  async deleteSession(sessionId, owner) {
    const stmt = this.db.prepare(`
      DELETE FROM sessions WHERE id = ? AND owner = ?
    `);

    const result = stmt.run(sessionId, owner);
    return { deletedCount: result.changes };
  }

  /**
   * Upsert a session by Swift's conversation ID.
   * Creates a new session or updates an existing one with the given messages.
   * Used to sync Swift conversations to the agent SQLite store.
   *
   * @param {string} sessionId - Swift conversation UUID (used as session ID)
   * @param {string} owner - User ID
   * @param {Array} messages - Full message array from Swift (already normalized)
   * @param {string} model - Model identifier
   * @param {string} [provider='ollama'] - Provider name
   */
  async upsertSession(sessionId, owner, messages, model, provider = 'ollama') {
    if (!this.db) throw new Error('Sessions not initialized. Call init() first.');

    const now = new Date().toISOString();
    const messagesJson = JSON.stringify(messages);

    // Auto-title from first user message (only if descriptive enough)
    const firstUser = messages.find((m) => m.role === 'user');
    const rawTitle = (firstUser?.content || '').slice(0, 60).trim();
    // Skip generic/short titles - require at least 5 chars and not look like test input
    const title = rawTitle.length >= 5 && !/^(msg|test|hi|hey|hello|ok|yo|sup)\d*$/i.test(rawTitle) ? rawTitle : '';

    // Try UPDATE first
    const updateStmt = this.db.prepare(`
      UPDATE sessions SET messages=?, model=?, provider=?, title=?, updatedAt=? WHERE id=?
    `);
    const result = updateStmt.run(messagesJson, model, provider, title, now, sessionId);

    // If no row updated, INSERT
    if (result.changes === 0) {
      const insertStmt = this.db.prepare(`
        INSERT INTO sessions (id, owner, title, messages, model, provider, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insertStmt.run(sessionId, owner, title, messagesJson, model, provider, now, now);
    }
  }

  /**
   * Convert SQLite row to session object
   *
   * @private
   * @param {Object} row - Raw SQLite row
   * @returns {Object} Session object with parsed dates and messages
   */
  _rowToSession(row) {
    return {
      id: row.id,
      owner: row.owner,
      title: row.title,
      messages: JSON.parse(row.messages),
      model: row.model,
      provider: row.provider,
      createdAt: new Date(row.createdAt).toISOString(),
      updatedAt: new Date(row.updatedAt).toISOString(),
    };
  }

  /**
   * Close the database connection and checkpoint WAL.
   */
  close() {
    if (this.db) {
      try {
        this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        this.db.close();
        this.db = null;
        console.log('[session] SQLiteSessionStore closed');
      } catch (err) {
        console.error('[session] Error closing database:', err.message);
      }
    }
  }
}

import crypto from 'crypto';
import { DatabaseSync } from 'node:sqlite';
import { SessionStore } from './SessionStore.js';
import { defaultSystemPrompt } from './MongoAdapter.js';
import { toStandardFormat } from '../core/normalize.js';

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
      session.createdAt.toISOString(),
      session.updatedAt.toISOString()
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
        updateFields.title = firstUserMsg.content.slice(0, 60);
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
      SELECT id, title, model, provider, createdAt, updatedAt,
             json_array_length(messages) as messageCount
      FROM sessions
      WHERE owner = ?
      ORDER BY updatedAt DESC
      LIMIT 50
    `);

    const rows = stmt.all(owner);

    return rows.map((row) => ({
      id: row.id,
      title: row.title || '',
      model: row.model,
      provider: row.provider || 'ollama',
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt),
      messageCount: row.messageCount || 0,
    }));
  }

  async deleteSession(sessionId, owner) {
    const stmt = this.db.prepare(`
      DELETE FROM sessions WHERE id = ? AND owner = ?
    `);

    const result = stmt.run(sessionId, owner);
    return { deletedCount: result.changes };
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
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt),
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

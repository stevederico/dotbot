import crypto from 'crypto';
import { SessionStore } from './SessionStore.js';
import { defaultSystemPrompt } from './MongoAdapter.js';
import { toStandardFormat } from '../core/normalize.js';

/**
 * In-memory SessionStore implementation for testing
 */
export class MemorySessionStore extends SessionStore {
  constructor() {
    super();
    this.sessions = new Map();
    this.prefsFetcher = null;
    this.systemPromptBuilder = defaultSystemPrompt;
    this.heartbeatEnsurer = null;
  }

  async init(options = {}) {
    this.prefsFetcher = options.prefsFetcher || null;
    this.systemPromptBuilder = options.systemPromptBuilder || defaultSystemPrompt;
    this.heartbeatEnsurer = options.heartbeatEnsurer || null;
    console.log('[sessions] initialized with in-memory store');
  }

  async buildSystemPrompt(owner) {
    const prefs = this.prefsFetcher ? await this.prefsFetcher(owner) : {};
    return this.systemPromptBuilder(prefs);
  }

  async createSession(owner, model = 'gpt-oss:20b', provider = 'ollama') {
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
    this.sessions.set(session.id, session);
    return session;
  }

  async getOrCreateDefaultSession(owner) {
    // Find most recent session for this owner
    const userSessions = Array.from(this.sessions.values())
      .filter(s => s.owner === owner)
      .sort((a, b) => b.updatedAt - a.updatedAt);

    let session = userSessions[0];
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
    const session = this.sessions.get(sessionId);
    if (!session || session.owner !== owner) return null;

    // Refresh system prompt timestamp
    session.messages[0] = { role: 'system', content: await this.buildSystemPrompt(owner) };
    return session;
  }

  async getSessionInternal(sessionId) {
    const session = this.sessions.get(sessionId);
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
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    session.messages = toStandardFormat(messages);
    session.model = model;
    session.updatedAt = new Date();
    if (provider) session.provider = provider;

    // Auto-populate title from first user message if empty
    if (!session.title) {
      const firstUserMsg = messages.find((m) => m.role === 'user');
      if (firstUserMsg) {
        session.title = firstUserMsg.content.slice(0, 60);
      }
    }
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
    const session = this.sessions.get(sessionId);
    if (session) {
      session.model = model;
      session.updatedAt = new Date();
    }
  }

  async setProvider(sessionId, provider) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.provider = provider;
      session.updatedAt = new Date();
    }
  }

  async clearSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.messages = [{ role: 'system', content: await this.buildSystemPrompt(session.owner) }];
      session.updatedAt = new Date();
    }
  }

  async listSessions(owner) {
    return Array.from(this.sessions.values())
      .filter(s => s.owner === owner)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 50)
      .map(s => ({
        id: s.id,
        title: s.title || '',
        model: s.model,
        provider: s.provider || 'ollama',
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        messageCount: s.messages.length,
      }));
  }

  async deleteSession(sessionId, owner) {
    const session = this.sessions.get(sessionId);
    if (session && session.owner === owner) {
      this.sessions.delete(sessionId);
      return { deletedCount: 1 };
    }
    return { deletedCount: 0 };
  }
}

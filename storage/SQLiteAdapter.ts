import crypto from 'crypto';
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue, SQLOutputValue } from 'node:sqlite';
import { SessionStore } from './SessionStore.js';
import { toStandardFormat } from '../core/normalize.js';
import type {
  Message,
  MessageToolCall,
  ToolCallStatus,
  SessionStoreInitOptions,
  Session,
  SessionSummary,
} from '../types.js';

/** Coerce a raw SQLite cell to a string. */
function asString(value: SQLOutputValue | undefined): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  return String(value);
}

/** Standard-format messages as produced by toStandardFormat(). */
type StdMessages = ReturnType<typeof toStandardFormat>;

/**
 * Faithfully convert standard-format messages back into the shared Message[]
 * shape. toStandardFormat() widens tool-call result/name; at runtime stored
 * messages always carry a string result and a present name, so this rebuild
 * is lossless for persisted data.
 */
export function coerceMessages(messages: StdMessages): Message[] {
  return messages.map((msg) => {
    const out: Message = {
      role: msg.role,
      content: msg.content,
    };
    if (msg.thinking !== undefined) out.thinking = msg.thinking;
    if (msg.images !== undefined) out.images = msg.images;
    if (msg.tool_calls !== undefined) out.tool_calls = msg.tool_calls;
    if (msg.tool_call_id !== undefined) out.tool_call_id = msg.tool_call_id;
    if (msg._ts !== undefined) out._ts = msg._ts;
    if (msg.toolCalls !== undefined) {
      out.toolCalls = msg.toolCalls.map((tc): MessageToolCall => {
        const status: ToolCallStatus = tc.status;
        const call: MessageToolCall = {
          id: tc.id,
          name: tc.name ?? '',
          input: tc.input,
          status,
        };
        if (typeof tc.result === 'string') call.result = tc.result;
        return call;
      });
    }
    return out;
  });
}

/** A session document persisted by this store. */
export interface StoredSession extends Session {
  id: string;
  owner: string;
  title: string;
  messages: Message[];
  model: string;
  provider: string;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

/** A session summary row returned by listSessions(). */
export interface StoredSessionSummary extends SessionSummary {
  id: string;
  owner: string;
  title: string;
  model: string;
  provider: string;
  messages: Message[];
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  [key: string]: unknown;
}

/** Agent preferences fetched for system-prompt building. */
export interface AgentPrefs {
  agentName?: string;
  agentPersonality?: string;
}

/**
 * Default system prompt builder for the agent.
 *
 * @param options - Prompt options
 * @returns System prompt
 */
export function defaultSystemPrompt({ agentName = 'Assistant', agentPersonality = '' }: AgentPrefs = {}): string {
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

type PrefsFetcher = NonNullable<SessionStoreInitOptions['prefsFetcher']>;
type SystemPromptBuilder = NonNullable<SessionStoreInitOptions['systemPromptBuilder']>;
type HeartbeatEnsurer = NonNullable<SessionStoreInitOptions['heartbeatEnsurer']>;

/**
 * SQLite-backed SessionStore implementation
 *
 * Uses Node.js 22.5+ built-in sqlite module for zero-dependency session storage.
 * All dates stored as ISO 8601 strings, messages as JSON TEXT column.
 */
export class SQLiteSessionStore extends SessionStore {
  db: DatabaseSync | null;
  prefsFetcher: PrefsFetcher | null;
  systemPromptBuilder: SystemPromptBuilder;
  heartbeatEnsurer: HeartbeatEnsurer | null;

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
   * @param dbPath - Path to SQLite database file
   * @param options - Initialization options
   */
  async init(dbPath: string, options: SessionStoreInitOptions = {}): Promise<void> {
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
   * @param owner - User ID
   * @returns System prompt
   */
  async buildSystemPrompt(owner: string): Promise<string> {
    const prefs = this.prefsFetcher ? await this.prefsFetcher(owner) : {};
    return this.systemPromptBuilder(prefs);
  }

  async createSession(owner: string, model = 'gpt-oss:20b', provider = 'ollama'): Promise<StoredSession> {
    if (!this.db) throw new Error('Sessions not initialized. Call init() first.');

    const now = new Date();
    const session: StoredSession = {
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

  async getOrCreateDefaultSession(owner: string): Promise<StoredSession> {
    if (!this.db) throw new Error('Sessions not initialized. Call init() first.');

    const stmt = this.db.prepare(`
      SELECT * FROM sessions WHERE owner = ? ORDER BY updatedAt DESC LIMIT 1
    `);

    const row = stmt.get(owner);

    let session: StoredSession;
    if (!row) {
      session = await this.createSession(owner);
    } else {
      session = this._rowToSession(row);
      // Refresh system prompt timestamp
      session.messages[0] = { role: 'system', content: await this.buildSystemPrompt(owner) };
    }

    if (this.heartbeatEnsurer) {
      this.heartbeatEnsurer(owner).catch((err: unknown) => {
        console.error(`[session] failed to ensure heartbeat for ${owner}:`, err instanceof Error ? err.message : err);
      });
    }

    return session;
  }

  async getSession(sessionId: string, owner: string): Promise<StoredSession | null> {
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

  async getSessionInternal(sessionId: string): Promise<StoredSession | null> {
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
   * @param sessionId - Session UUID
   * @param messages - Messages (provider-specific or standard format)
   * @param model - Model identifier
   * @param provider - Provider name
   */
  async saveSession(sessionId: string, messages: Message[], model: string, provider?: string): Promise<void> {
    if (!this.db) throw new Error('Sessions not initialized. Call init() first.');

    const normalized = toStandardFormat(messages);
    const updateFields: Record<string, SQLInputValue> = {
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
   * @param sessionId - Session UUID
   * @param message - Message object (any provider format)
   * @returns Updated session
   */
  async addMessage(sessionId: string, message: Message): Promise<StoredSession> {
    const session = await this.getSessionInternal(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    if (!message._ts) message._ts = Date.now();
    const normalized = coerceMessages(toStandardFormat([message]));
    session.messages.push(...normalized);
    await this.saveSession(sessionId, session.messages, session.model);
    return session;
  }

  async setModel(sessionId: string, model: string): Promise<void> {
    if (!this.db) throw new Error('Sessions not initialized. Call init() first.');
    const stmt = this.db.prepare(`
      UPDATE sessions SET model = ?, updatedAt = ? WHERE id = ?
    `);
    stmt.run(model, new Date().toISOString(), sessionId);
  }

  async setProvider(sessionId: string, provider: string): Promise<void> {
    if (!this.db) throw new Error('Sessions not initialized. Call init() first.');
    const stmt = this.db.prepare(`
      UPDATE sessions SET provider = ?, updatedAt = ? WHERE id = ?
    `);
    stmt.run(provider, new Date().toISOString(), sessionId);
  }

  /**
   * Update session title.
   *
   * @param sessionId - Session UUID
   * @param title - New title
   */
  async updateTitle(sessionId: string, title: string): Promise<void> {
    if (!this.db) throw new Error('Sessions not initialized. Call init() first.');
    const stmt = this.db.prepare(`
      UPDATE sessions SET title = ?, updatedAt = ? WHERE id = ?
    `);
    stmt.run(title, new Date().toISOString(), sessionId);
  }

  async clearSession(sessionId: string): Promise<void> {
    if (!this.db) throw new Error('Sessions not initialized. Call init() first.');
    const ownerStmt = this.db.prepare('SELECT owner FROM sessions WHERE id = ?');
    const ownerRow = ownerStmt.get(sessionId);

    const messages: Message[] = [{ role: 'system', content: await this.buildSystemPrompt(asString(ownerRow?.owner)) }];

    const stmt = this.db.prepare(`
      UPDATE sessions SET messages = ?, updatedAt = ? WHERE id = ?
    `);

    stmt.run(JSON.stringify(messages), new Date().toISOString(), sessionId);
  }

  async listSessions(owner: string): Promise<StoredSessionSummary[]> {
    if (!this.db) throw new Error('Sessions not initialized. Call init() first.');
    const stmt = this.db.prepare(`
      SELECT id, title, model, provider, messages, createdAt, updatedAt
      FROM sessions
      WHERE owner = ?
      ORDER BY updatedAt DESC
      LIMIT 50
    `);

    const rows = stmt.all(owner);

    return rows.map((row: Record<string, SQLOutputValue>) => {
      const parsedMessages = this._parseMessages(asString(row.messages) || '[]');
      return {
        id: asString(row.id),
        owner: owner,
        title: asString(row.title) || '',
        model: asString(row.model),
        provider: asString(row.provider) || 'ollama',
        messages: parsedMessages,
        createdAt: new Date(asString(row.createdAt)).toISOString(),
        updatedAt: new Date(asString(row.updatedAt)).toISOString(),
        messageCount: parsedMessages.length,
      };
    });
  }

  async deleteSession(sessionId: string, owner: string): Promise<{ deletedCount: number | bigint }> {
    if (!this.db) throw new Error('Sessions not initialized. Call init() first.');
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
   * @param sessionId - Swift conversation UUID (used as session ID)
   * @param owner - User ID
   * @param messages - Full message array from Swift (already normalized)
   * @param model - Model identifier
   * @param provider - Provider name
   */
  async upsertSession(sessionId: string, owner: string, messages: Message[], model: string, provider = 'ollama'): Promise<void> {
    if (!this.db) throw new Error('Sessions not initialized. Call init() first.');

    const now = new Date().toISOString();
    const messagesJson = JSON.stringify(messages);

    // Auto-title from first user message (only if descriptive enough)
    const firstUser = messages.find((m) => m.role === 'user');
    const firstUserContent = firstUser && typeof firstUser.content === 'string' ? firstUser.content : '';
    const rawTitle = firstUserContent.slice(0, 60).trim();
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
   */
  _rowToSession(row: Record<string, SQLOutputValue>): StoredSession {
    return {
      id: asString(row.id),
      owner: asString(row.owner),
      title: asString(row.title),
      messages: this._parseMessages(asString(row.messages)),
      model: asString(row.model),
      provider: asString(row.provider),
      createdAt: new Date(asString(row.createdAt)).toISOString(),
      updatedAt: new Date(asString(row.updatedAt)).toISOString(),
    };
  }

  /**
   * Parse a JSON messages column into a Message[] (empty array on failure).
   *
   * @private
   */
  _parseMessages(text: string): Message[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((m): m is Message => typeof m === 'object' && m !== null && 'role' in m);
  }

  /**
   * Close the database connection and checkpoint WAL.
   */
  close(): void {
    if (this.db) {
      try {
        this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        this.db.close();
        this.db = null;
        console.log('[session] SQLiteSessionStore closed');
      } catch (err) {
        console.error('[session] Error closing database:', err instanceof Error ? err.message : err);
      }
    }
  }
}

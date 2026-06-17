/**
 * SessionStore Interface
 *
 * Abstract interface for session storage backends. Implementations must provide
 * all methods defined here.
 */
import type {
  Message,
  Session,
  SessionSummary,
} from "../types.js";

export class SessionStore {
  /**
   * Initialize the session store.
   *
   * Concrete adapters take varying arguments (the SQLite store needs a dbPath,
   * the in-memory store takes only options), so the base accepts arbitrary
   * arguments and delegates the real signature to the subclass.
   */
  async init(...args: unknown[]): Promise<void> {
    throw new Error('SessionStore.init() must be implemented');
  }

  /**
   * Create a new session for a user
   */
  async createSession(
    owner: string,
    model?: string,
    provider?: string,
  ): Promise<Session> {
    throw new Error('SessionStore.createSession() must be implemented');
  }

  /**
   * Get a session by its UUID, verifying ownership
   */
  async getSession(sessionId: string, owner: string): Promise<Session | null> {
    throw new Error('SessionStore.getSession() must be implemented');
  }

  /**
   * Get a session by ID without ownership check (for internal/cron use)
   */
  async getSessionInternal(sessionId: string): Promise<Session | null> {
    throw new Error('SessionStore.getSessionInternal() must be implemented');
  }

  /**
   * Get the most recent session for a user, or create one if none exist
   */
  async getOrCreateDefaultSession(owner: string): Promise<Session> {
    throw new Error('SessionStore.getOrCreateDefaultSession() must be implemented');
  }

  /**
   * Save messages back to storage after agent loop
   */
  async saveSession(
    sessionId: string,
    messages: Message[],
    model: string,
    provider?: string,
  ): Promise<void> {
    throw new Error('SessionStore.saveSession() must be implemented');
  }

  /**
   * Add a single message to a session and persist
   */
  async addMessage(sessionId: string, message: Message): Promise<Session> {
    throw new Error('SessionStore.addMessage() must be implemented');
  }

  /**
   * Set the model for a session
   */
  async setModel(sessionId: string, model: string): Promise<void> {
    throw new Error('SessionStore.setModel() must be implemented');
  }

  /**
   * Set the AI provider for a session
   */
  async setProvider(sessionId: string, provider: string): Promise<void> {
    throw new Error('SessionStore.setProvider() must be implemented');
  }

  /**
   * Clear a session's conversation history (keeps system prompt)
   */
  async clearSession(sessionId: string): Promise<void> {
    throw new Error('SessionStore.clearSession() must be implemented');
  }

  /**
   * List all sessions for a user with summary info
   */
  async listSessions(owner: string): Promise<SessionSummary[]> {
    throw new Error('SessionStore.listSessions() must be implemented');
  }

  /**
   * Delete a session by ID, verifying ownership
   */
  async deleteSession(sessionId: string, owner: string): Promise<unknown> {
    throw new Error('SessionStore.deleteSession() must be implemented');
  }

  /**
   * Trim messages if conversation is too long
   */
  trimMessages(messages: Message[], maxMessages: number = 40): Message[] {
    if (messages.length <= maxMessages) return messages;
    const system = messages[0];
    if (system === undefined) return messages;
    const recent = messages.slice(-(maxMessages - 1));
    return [system, ...recent];
  }
}

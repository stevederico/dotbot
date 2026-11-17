import type {
  Message,
  Session,
  SessionSummary,
} from "../types.js";

export class SessionStore {
  async init(...args: unknown[]): Promise<void> {
    throw new Error('SessionStore.init() must be implemented');
  }

  async createSession(
    owner: string,
    model?: string,
    provider?: string,
  ): Promise<Session> {
    throw new Error('SessionStore.createSession() must be implemented');
  }

  async getSession(sessionId: string, owner: string): Promise<Session | null> {
    throw new Error('SessionStore.getSession() must be implemented');
  }

  async getSessionInternal(sessionId: string): Promise<Session | null> {
    throw new Error('SessionStore.getSessionInternal() must be implemented');
  }

  async getOrCreateDefaultSession(owner: string): Promise<Session> {
    throw new Error('SessionStore.getOrCreateDefaultSession() must be implemented');
  }

  async saveSession(
    sessionId: string,
    messages: Message[],
    model: string,
    provider?: string,
  ): Promise<void> {
    throw new Error('SessionStore.saveSession() must be implemented');
  }

  async addMessage(sessionId: string, message: Message): Promise<Session> {
    throw new Error('SessionStore.addMessage() must be implemented');
  }

  async setModel(sessionId: string, model: string): Promise<void> {
    throw new Error('SessionStore.setModel() must be implemented');
  }

  async setProvider(sessionId: string, provider: string): Promise<void> {
    throw new Error('SessionStore.setProvider() must be implemented');
  }

  async clearSession(sessionId: string): Promise<void> {
    throw new Error('SessionStore.clearSession() must be implemented');
  }

  async listSessions(owner: string): Promise<SessionSummary[]> {
    throw new Error('SessionStore.listSessions() must be implemented');
  }

  async deleteSession(sessionId: string, owner: string): Promise<unknown> {
    throw new Error('SessionStore.deleteSession() must be implemented');
  }

  trimMessages(messages: Message[], maxMessages: number = 40): Message[] {
    if (messages.length <= maxMessages) return messages;
    const system = messages[0];
    if (system === undefined) return messages;
    const recent = messages.slice(-(maxMessages - 1));
    return [system, ...recent];
  }
}

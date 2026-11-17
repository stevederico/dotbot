import { randomUUID } from 'node:crypto';
import { SessionStore } from './SessionStore.js';
import { defaultSystemPrompt, coerceMessages } from './SQLiteAdapter.js';
import { toStandardFormat } from '../core/normalize.js';
import type {
  Message,
  Session,
  SessionSummary,
  SessionStoreInitOptions,
} from "../types.js";

interface SessionPrefs {
  agentName?: string;
  agentPersonality?: string;
}

type PrefsFetcher = (userId: string) => Promise<SessionPrefs>;
type SystemPromptBuilder = (prefs: SessionPrefs) => string;
type HeartbeatEnsurer = (userId: string) => Promise<unknown | null>;

interface MemorySession extends Session {
  id: string;
  owner: string;
  title: string;
  messages: Message[];
  model: string;
  provider: string;
  createdAt: Date;
  updatedAt: Date;
}

export class MemorySessionStore extends SessionStore {
  sessions: Map<string, MemorySession>;
  prefsFetcher: PrefsFetcher | null;
  systemPromptBuilder: SystemPromptBuilder;
  heartbeatEnsurer: HeartbeatEnsurer | null;

  constructor() {
    super();
    this.sessions = new Map();
    this.prefsFetcher = null;
    this.systemPromptBuilder = defaultSystemPrompt;
    this.heartbeatEnsurer = null;
  }

  async init(options: SessionStoreInitOptions = {}): Promise<void> {
    this.prefsFetcher = options.prefsFetcher || null;
    this.systemPromptBuilder = options.systemPromptBuilder || defaultSystemPrompt;
    this.heartbeatEnsurer = options.heartbeatEnsurer || null;
    console.log('[sessions] initialized with in-memory store');
  }

  async buildSystemPrompt(owner: string): Promise<string> {
    const prefs = this.prefsFetcher ? await this.prefsFetcher(owner) : {};
    return this.systemPromptBuilder(prefs);
  }

  async createSession(owner: string, model: string = 'gpt-oss:20b', provider: string = 'ollama'): Promise<MemorySession> {
    const session: MemorySession = {
      id: randomUUID(),
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

  async getOrCreateDefaultSession(owner: string): Promise<MemorySession> {
    const userSessions = Array.from(this.sessions.values())
      .filter(s => s.owner === owner)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

    let session = userSessions[0];
    if (!session) {
      session = await this.createSession(owner);
    } else {
      session.messages[0] = { role: 'system', content: await this.buildSystemPrompt(owner) };
    }
    if (this.heartbeatEnsurer) {
      this.heartbeatEnsurer(owner).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[session] failed to ensure heartbeat for ${owner}:`, message);
      });
    }
    return session;
  }

  async getSession(sessionId: string, owner: string): Promise<MemorySession | null> {
    const session = this.sessions.get(sessionId);
    if (!session || session.owner !== owner) return null;

    session.messages[0] = { role: 'system', content: await this.buildSystemPrompt(owner) };
    return session;
  }

  async getSessionInternal(sessionId: string): Promise<MemorySession | null> {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    session.messages[0] = { role: 'system', content: await this.buildSystemPrompt(session.owner) };
    return session;
  }

  async saveSession(sessionId: string, messages: Message[], model: string, provider?: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    session.messages = coerceMessages(toStandardFormat(messages));
    session.model = model;
    session.updatedAt = new Date();
    if (provider) session.provider = provider;

    if (!session.title) {
      const firstUserMsg = messages.find((m) => m.role === 'user');
      if (firstUserMsg) {
        const content = firstUserMsg.content;
        if (typeof content === 'string') {
          session.title = content.slice(0, 60);
        }
      }
    }
  }

  async addMessage(sessionId: string, message: Message): Promise<MemorySession> {
    const session = await this.getSessionInternal(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    if (!message._ts) message._ts = Date.now();
    const normalized = coerceMessages(toStandardFormat([message]));
    session.messages.push(...normalized);
    await this.saveSession(sessionId, session.messages, session.model);
    return session;
  }

  async setModel(sessionId: string, model: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.model = model;
      session.updatedAt = new Date();
    }
  }

  async setProvider(sessionId: string, provider: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.provider = provider;
      session.updatedAt = new Date();
    }
  }

  async clearSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.messages = [{ role: 'system', content: await this.buildSystemPrompt(session.owner) }];
      session.updatedAt = new Date();
    }
  }

  async listSessions(owner: string): Promise<SessionSummary[]> {
    return Array.from(this.sessions.values())
      .filter(s => s.owner === owner)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
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

  async deleteSession(sessionId: string, owner: string): Promise<{ deletedCount: number }> {
    const session = this.sessions.get(sessionId);
    if (session && session.owner === owner) {
      this.sessions.delete(sessionId);
      return { deletedCount: 1 };
    }
    return { deletedCount: 0 };
  }
}

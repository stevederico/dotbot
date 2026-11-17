/// <reference types="node" />
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createCronHandler } from '../core/cron_handler.js';
import type { AgentChatOptions } from '../core/cron_handler.js';
import type { AgentEvent, CronStore, Session, SessionStore } from '../types.js';

interface AgentSpy {
  calls: AgentChatOptions[];
  chat(opts: AgentChatOptions): AsyncGenerator<AgentEvent>;
}

function unimplemented(name: string): never {
  throw new Error(`SessionStore.${name} not implemented in test stub`);
}

function makeSessionStore(owner = 'user-1'): SessionStore {
  return {
    async getOrCreateDefaultSession(): Promise<Session> {
      return { id: 'session-1', owner, messages: [] };
    },
    async getSessionInternal(id: string): Promise<Session> {
      return { id, owner, messages: [], provider: 'ollama', model: 'test' };
    },
    async addMessage(): Promise<Session> {
      return { messages: [] };
    },
    init: async () => unimplemented('init'),
    createSession: async () => unimplemented('createSession'),
    getSession: async () => unimplemented('getSession'),
    saveSession: async () => unimplemented('saveSession'),
    setModel: async () => unimplemented('setModel'),
    setProvider: async () => unimplemented('setProvider'),
    clearSession: async () => unimplemented('clearSession'),
    listSessions: async () => unimplemented('listSessions'),
    deleteSession: async () => unimplemented('deleteSession'),
    trimMessages: () => unimplemented('trimMessages'),
  };
}

function makeUnusedCronStore(): CronStore {
  return {
    createTask: async () => unimplemented('cron createTask'),
    listTasks: async () => unimplemented('cron listTasks'),
    getTask: async () => unimplemented('cron getTask'),
    toggleTask: async () => unimplemented('cron toggleTask'),
    deleteTask: async () => unimplemented('cron deleteTask'),
  };
}

function makeAgentSpy(): AgentSpy {
  const calls: AgentChatOptions[] = [];
  return {
    calls,
    async *chat(opts: AgentChatOptions): AsyncGenerator<AgentEvent> {
      calls.push(opts);
      yield { type: 'done', content: '' };
    },
  };
}

describe('cron_handler — heartbeat skip optimization', () => {
  test('skips the agent call entirely when there are no active tasks', async () => {
    const sessionStore = makeSessionStore();
    const agent = makeAgentSpy();

    const handleTask = createCronHandler({
      sessionStore,
      cronStore: makeUnusedCronStore(),
      providers: {},
      hooks: {
        tasksFinder: async () => [],
      },
    });
    handleTask.setAgent(agent);

    await handleTask({ name: 'heartbeat', userId: 'user-1', prompt: 'Any updates?' });

    assert.strictEqual(agent.calls.length, 0,
      'agent.chat must not be invoked when tasksFinder returns []');
  });

  test('still calls the agent when there is at least one active task', async () => {
    const sessionStore = makeSessionStore();
    const agent = makeAgentSpy();

    const handleTask = createCronHandler({
      sessionStore,
      cronStore: makeUnusedCronStore(),
      providers: {},
      hooks: {
        tasksFinder: async () => [
          { id: 't1', description: 'Ship the scrub', priority: 'high' },
        ],
      },
    });
    handleTask.setAgent(agent);

    await handleTask({ name: 'heartbeat', userId: 'user-1', prompt: 'Any updates?' });

    assert.strictEqual(agent.calls.length, 1,
      'agent.chat should be invoked when at least one active task exists');
  });

  test('skips the agent call if tasksFinder throws', async () => {
    const sessionStore = makeSessionStore();
    const agent = makeAgentSpy();

    const handleTask = createCronHandler({
      sessionStore,
      cronStore: makeUnusedCronStore(),
      providers: {},
      hooks: {
        tasksFinder: async () => { throw new Error('db unreachable'); },
      },
    });
    handleTask.setAgent(agent);

    await handleTask({ name: 'heartbeat', userId: 'user-1', prompt: 'Any updates?' });

    assert.strictEqual(agent.calls.length, 0,
      'agent.chat must not be invoked when tasksFinder throws');
  });
});

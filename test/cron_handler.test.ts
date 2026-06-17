/// <reference types="node" />
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createCronHandler } from '../core/cron_handler.js';
import type { AgentChatOptions } from '../core/cron_handler.js';
import type { AgentEvent, Session, SessionStore } from '../types.js';

/** A spy capturing the options each agent.chat() call receives. */
interface AgentSpy {
  calls: AgentChatOptions[];
  chat(opts: AgentChatOptions): AsyncGenerator<AgentEvent>;
}

/**
 * Mock SessionStore: only the three methods the heartbeat path touches do real
 * work; the rest throw to flag accidental use. Returning a full SessionStore
 * keeps the createCronHandler() call site fully typed.
 */
function unimplemented(name: string): never {
  throw new Error(`SessionStore.${name} not implemented in test stub`);
}

/**
 * Regression tests for the cron heartbeat path.
 *
 * These cover the skip-when-no-tasks optimization added in 0.30: a heartbeat
 * firing with zero active tasks used to send a pointless "[Heartbeat] ..."
 * message to the LLM on every tick. Now it returns null from
 * buildHeartbeatContent before the agent is ever called, saving a round trip
 * on every provider (and real dollars on cloud providers).
 */

/**
 * Build a minimal sessionStore stub that returns a fixed session. The session
 * has no `updatedAt` so the stale-user check is skipped.
 */
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

/**
 * Track whether agent.chat was invoked, without any real streaming.
 */
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
      // @ts-expect-error - heartbeat path never touches cronStore; stub it empty
      cronStore: {},
      // @ts-expect-error - test passes null to assert the no-store code path
      taskStore: null,
      // @ts-expect-error - test passes null to assert the no-store code path
      memoryStore: null,
      providers: {},
      hooks: {
        tasksFinder: async () => [], // the key condition — zero tasks
      },
    });
    handleTask.setAgent(agent);

    await handleTask({ name: 'heartbeat', userId: 'user-1', prompt: 'Any updates?' });

    // Agent must NOT have been called since there's nothing to discuss.
    assert.strictEqual(agent.calls.length, 0,
      'agent.chat must not be invoked when tasksFinder returns []');
  });

  test('still calls the agent when there is at least one active task', async () => {
    const sessionStore = makeSessionStore();
    const agent = makeAgentSpy();

    const handleTask = createCronHandler({
      sessionStore,
      // @ts-expect-error - heartbeat path never touches cronStore; stub it empty
      cronStore: {},
      // @ts-expect-error - test passes null to assert the no-store code path
      taskStore: null,
      // @ts-expect-error - test passes null to assert the no-store code path
      memoryStore: null,
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
    // Fail-closed guard: if the task store is down, a heartbeat should not
    // degrade to a meaningless default prompt sent to the LLM.
    const sessionStore = makeSessionStore();
    const agent = makeAgentSpy();

    const handleTask = createCronHandler({
      sessionStore,
      // @ts-expect-error - heartbeat path never touches cronStore; stub it empty
      cronStore: {},
      // @ts-expect-error - test passes null to assert the no-store code path
      taskStore: null,
      // @ts-expect-error - test passes null to assert the no-store code path
      memoryStore: null,
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

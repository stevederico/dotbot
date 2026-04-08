import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createCronHandler } from '../core/cron_handler.js';

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
function makeSessionStore(owner = 'user-1') {
  return {
    async getOrCreateDefaultSession() {
      return { id: 'session-1', owner, messages: [] };
    },
    async getSessionInternal(id) {
      return { id, owner, messages: [], provider: 'ollama', model: 'test' };
    },
    async addMessage() {},
  };
}

/**
 * Track whether agent.chat was invoked, without any real streaming.
 */
function makeAgentSpy() {
  const calls = [];
  return {
    calls,
    async *chat(opts) {
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
      cronStore: {},
      taskStore: null,
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
      cronStore: {},
      taskStore: null,
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
      cronStore: {},
      taskStore: null,
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

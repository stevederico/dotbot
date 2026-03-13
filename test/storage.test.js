import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { unlink } from 'node:fs/promises';
import { SQLiteSessionStore } from '../storage/SQLiteAdapter.js';
import { SQLiteMemoryStore } from '../storage/SQLiteMemoryAdapter.js';

const TEST_DB = './test/test.db';

describe('SQLiteSessionStore', () => {
  let store;

  before(async () => {
    store = new SQLiteSessionStore();
    await store.init(TEST_DB);
  });

  after(async () => {
    if (store?.db) store.db.close();
    await unlink(TEST_DB).catch(() => {});
  });

  test('creates a session', async () => {
    const session = await store.createSession('user1', 'grok-4-1-fast-reasoning', 'xai');
    assert.ok(session.id);
    assert.strictEqual(session.owner, 'user1');
    assert.strictEqual(session.model, 'grok-4-1-fast-reasoning');
    assert.strictEqual(session.provider, 'xai');
  });

  test('retrieves session by id', async () => {
    const created = await store.createSession('user2', 'gpt-4o', 'openai');
    const fetched = await store.getSessionInternal(created.id);
    assert.strictEqual(fetched.id, created.id);
    assert.strictEqual(fetched.owner, 'user2');
  });

  test('lists sessions for user', async () => {
    await store.createSession('user3', 'grok-4-1-fast-reasoning', 'xai');
    await store.createSession('user3', 'grok-4-1-fast-reasoning', 'xai');
    const sessions = await store.listSessions('user3');
    assert.ok(sessions.length >= 2);
  });

  test('adds message to session', async () => {
    const session = await store.createSession('user4', 'grok-4-1-fast-reasoning', 'xai');
    await store.addMessage(session.id, { role: 'user', content: 'hello' });
    const fetched = await store.getSessionInternal(session.id);
    const userMsg = fetched.messages.find(m => m.role === 'user' && m.content === 'hello');
    assert.ok(userMsg);
  });

  test('deletes session', async () => {
    const session = await store.createSession('user5', 'grok-4-1-fast-reasoning', 'xai');
    await store.deleteSession(session.id, 'user5');
    const fetched = await store.getSessionInternal(session.id);
    assert.strictEqual(fetched, null);
  });
});

describe('SQLiteMemoryStore', () => {
  let store;

  before(async () => {
    store = new SQLiteMemoryStore();
    await store.init(TEST_DB);
  });

  after(async () => {
    if (store?.db) store.db.close();
    await unlink(TEST_DB).catch(() => {});
  });

  test('saves and retrieves memory', async () => {
    await store.writeMemory('memuser1', 'favorite_color', 'blue');
    const memories = await store.getAllMemories('memuser1');
    const found = memories.find(m => m.key === 'favorite_color');
    assert.ok(found);
    assert.strictEqual(found.value, 'blue');
  });

  test('reads memory by key', async () => {
    await store.writeMemory('memuser2', 'pet', 'dog named Max');
    const result = await store.readMemory('memuser2', 'pet');
    assert.strictEqual(result.value, 'dog named Max');
  });

  test('deletes memory', async () => {
    await store.writeMemory('memuser3', 'temp', 'delete me');
    await store.deleteMemory('memuser3', 'temp');
    const result = await store.readMemory('memuser3', 'temp');
    assert.strictEqual(result, null);
  });
});

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { toStandardFormat, toProviderFormat } from '../core/normalize.js';

describe('toStandardFormat', () => {
  test('normalizes simple user message', () => {
    const messages = [{ role: 'user', content: 'hello' }];
    const result = toStandardFormat(messages);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].role, 'user');
    assert.strictEqual(result[0].content, 'hello');
  });

  test('normalizes system message', () => {
    const messages = [{ role: 'system', content: 'You are helpful' }];
    const result = toStandardFormat(messages);
    assert.strictEqual(result[0].role, 'system');
    assert.strictEqual(result[0].content, 'You are helpful');
  });

  test('normalizes assistant message with text', () => {
    const messages = [{ role: 'assistant', content: 'Hi there' }];
    const result = toStandardFormat(messages);
    assert.strictEqual(result[0].role, 'assistant');
    assert.strictEqual(result[0].content, 'Hi there');
  });

  test('handles Anthropic tool_use blocks', () => {
    const messages = [{
      role: 'assistant',
      content: [
        { type: 'text', text: 'Let me search' },
        { type: 'tool_use', id: 'tool1', name: 'web_search', input: { query: 'test' } }
      ]
    }];
    const result = toStandardFormat(messages);
    assert.strictEqual(result[0].role, 'assistant');
    assert.strictEqual(result[0].content, 'Let me search');
    assert.ok(result[0].toolCalls);
    assert.strictEqual(result[0].toolCalls[0].name, 'web_search');
  });

  test('skips tool-result-only messages', () => {
    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'result' }] }
    ];
    const result = toStandardFormat(messages);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].content, 'hello');
  });
});

describe('toProviderFormat', () => {
  test('converts standard user message to Anthropic', () => {
    const messages = [{ role: 'user', content: 'hello' }];
    const result = toProviderFormat(messages, 'anthropic');
    assert.strictEqual(result[0].role, 'user');
    assert.strictEqual(result[0].content, 'hello');
  });

  test('converts standard user message to OpenAI', () => {
    const messages = [{ role: 'user', content: 'hello' }];
    const result = toProviderFormat(messages, 'openai');
    assert.strictEqual(result[0].role, 'user');
    assert.strictEqual(result[0].content, 'hello');
  });

  test('converts assistant with toolCalls to Anthropic format', () => {
    const messages = [{
      role: 'assistant',
      content: 'Searching...',
      toolCalls: [{ id: 't1', name: 'web_search', input: { q: 'test' }, result: 'found', status: 'done' }]
    }];
    const result = toProviderFormat(messages, 'anthropic');
    assert.strictEqual(result[0].role, 'assistant');
    assert.ok(Array.isArray(result[0].content));
  });
});

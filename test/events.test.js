import { test, describe } from 'node:test';
import assert from 'node:assert';
import { validateEvent } from '../core/events.js';

describe('validateEvent', () => {
  test('rejects non-object events', () => {
    assert.throws(() => validateEvent(null), /must be an object/);
    assert.throws(() => validateEvent('string'), /must be an object/);
  });

  test('rejects events without type', () => {
    assert.throws(() => validateEvent({}), /must have a type/);
  });

  test('validates text_delta event', () => {
    assert.ok(validateEvent({ type: 'text_delta', text: 'hello' }));
    assert.throws(
      () => validateEvent({ type: 'text_delta', text: 123 }),
      /must have text string/
    );
  });

  test('validates thinking event', () => {
    assert.ok(validateEvent({ type: 'thinking', text: 'reasoning', hasNativeThinking: true }));
    assert.throws(
      () => validateEvent({ type: 'thinking', text: 'hi' }),
      /must have hasNativeThinking/
    );
  });

  test('validates tool_start event', () => {
    assert.ok(validateEvent({ type: 'tool_start', name: 'web_search', input: { query: 'test' } }));
    assert.throws(
      () => validateEvent({ type: 'tool_start', name: 'test' }),
      /must have input object/
    );
  });

  test('validates tool_result event', () => {
    assert.ok(validateEvent({
      type: 'tool_result',
      name: 'web_search',
      input: { query: 'test' },
      result: 'found it'
    }));
    assert.throws(
      () => validateEvent({ type: 'tool_result', name: 'test', input: {} }),
      /must have result string/
    );
  });

  test('validates tool_error event', () => {
    assert.ok(validateEvent({ type: 'tool_error', name: 'test', error: 'failed' }));
    assert.throws(
      () => validateEvent({ type: 'tool_error', name: 'test' }),
      /must have error string/
    );
  });

  test('validates done event', () => {
    assert.ok(validateEvent({ type: 'done', content: 'finished' }));
    assert.throws(
      () => validateEvent({ type: 'done' }),
      /must have content string/
    );
  });

  test('validates error event', () => {
    assert.ok(validateEvent({ type: 'error', error: 'something broke' }));
    assert.throws(
      () => validateEvent({ type: 'error' }),
      /must have error string/
    );
  });
});

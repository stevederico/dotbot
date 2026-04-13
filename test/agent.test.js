import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { agentLoop } from '../core/agent.js';

/**
 * Regression tests for the local provider branch of agentLoop.
 *
 * These cover the flush branch added in 0.30 that handles short plain-text
 * responses from local models that never emit gpt-oss channel tokens
 * (Gemma 4 E2B, LFM2.5, SmolLM). Without the flush, the rawBuffer was
 * silently discarded on stream end and the downstream consumer received
 * zero text_delta events — empty assistant bubbles in the UI.
 */

/**
 * Build a minimal local-style provider for agentLoop tests.
 * The `id` must be "local" to hit the buffered-parsing branch,
 * and `local: true` skips the failover path for a direct fetch.
 */
function makeLocalProvider() {
  return {
    id: 'local',
    name: 'Test Local',
    apiUrl: 'http://127.0.0.1:1316/v1',
    endpoint: '/chat/completions',
    local: true,
    headers: () => ({ 'Content-Type': 'application/json' }),
  };
}

/**
 * Mock a fetch Response carrying an OpenAI-style SSE stream.
 * Accepts an array of {content?, finish_reason?} deltas. Each becomes one
 * SSE data line. A final "data: [DONE]" terminator is appended automatically.
 */
function mockSSEResponse(deltas) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const delta of deltas) {
        const chunk = { choices: [{ delta }] };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

/**
 * Replace globalThis.fetch with a mock that returns the given Response
 * for every call. Returns a restore function to put the original back.
 */
function stubFetch(response) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => response;
  return () => { globalThis.fetch = original; };
}

describe('agentLoop — local short plain-text response flush', () => {
  let restoreFetch;

  afterEach(() => {
    if (restoreFetch) {
      restoreFetch();
      restoreFetch = null;
    }
  });

  test('yields text_delta for a <200-char greeting that never hits passthrough threshold', async () => {
    // Gemma 4 E2B greetings are 30-150 chars and emit no <|channel|> markers.
    // Pre-0.30: rawBuffer accumulated silently, never yielded, full response 0 chars.
    // Post-0.30: the stream-done handler flushes the buffer to a text_delta.
    restoreFetch = stubFetch(mockSSEResponse([
      { content: 'Hi' },
      { content: ' there!' },
      { content: ' How can I help?' },
      { finish_reason: 'stop' },
    ]));

    const gen = agentLoop({
      model: 'test-model',
      messages: [
        { role: 'system', content: 'test' },
        { role: 'user', content: 'hi' },
      ],
      tools: [],
      provider: makeLocalProvider(),
    });

    const events = [];
    let fullResponse = '';
    for await (const event of gen) {
      events.push(event);
      if (event.type === 'text_delta' && event.text) {
        fullResponse += event.text;
      }
      if (event.type === 'done') break;
    }

    assert.strictEqual(fullResponse, 'Hi there! How can I help?');
    const textDeltas = events.filter((e) => e.type === 'text_delta');
    assert.ok(textDeltas.length >= 1, 'expected at least one text_delta event');
    const doneEvents = events.filter((e) => e.type === 'done');
    assert.strictEqual(doneEvents.length, 1);
  });

  test('does not flush when the buffer contains tool call markers', async () => {
    // Guards against false-positive text emission when the model emits a
    // text-based tool call — those are handled by the post-loop parseToolCalls()
    // branch, not the flush path.
    restoreFetch = stubFetch(mockSSEResponse([
      { content: '<tool_call>' },
      { content: '{"name":"web_search","arguments":{"query":"weather"}}' },
      { content: '</tool_call>' },
      { finish_reason: 'stop' },
    ]));

    const gen = agentLoop({
      model: 'test-model',
      messages: [
        { role: 'system', content: 'test' },
        { role: 'user', content: 'weather?' },
      ],
      tools: [
        {
          name: 'web_search',
          description: 'Search',
          parameters: { type: 'object' },
          execute: async () => 'sunny',
        },
      ],
      provider: makeLocalProvider(),
      maxTurns: 1, // Cap after the first iteration so the loop exits
    });

    const events = [];
    for await (const event of gen) {
      events.push(event);
      if (events.length > 20) break; // Safety cap in case tool loop misbehaves
    }

    // Critical assertion: no text_delta should carry the raw <tool_call> markup.
    // If the flush branch fires unguarded, the user would see literal
    // "<tool_call>..." in their chat bubble.
    const textWithMarkers = events
      .filter((e) => e.type === 'text_delta')
      .filter((e) => e.text && e.text.includes('<tool_call>'));
    assert.strictEqual(textWithMarkers.length, 0,
      'tool_call markup must not leak through the flush branch');
  });

  test('end-to-end text accumulation matches the realtime consumer pattern', async () => {
    // Simulates a streaming consumer (e.g. a WebSocket bridge): accumulate
    // text from text_delta events, break on done. Pre-0.30 the accumulated
    // string was empty. Post-0.30 it matches the model's full utterance.
    restoreFetch = stubFetch(mockSSEResponse([
      { content: 'Hello' },
      { content: '!' },
      { finish_reason: 'stop' },
    ]));

    const gen = agentLoop({
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      provider: makeLocalProvider(),
    });

    let fullResponse = '';
    let textDeltaCount = 0;
    let sawDone = false;
    for await (const event of gen) {
      if (event.type === 'text_delta') {
        fullResponse += event.text;
        textDeltaCount++;
      }
      if (event.type === 'done') {
        sawDone = true;
        break;
      }
    }

    assert.strictEqual(fullResponse, 'Hello!');
    assert.ok(textDeltaCount > 0, 'expected at least one text_delta');
    assert.strictEqual(sawDone, true);
  });
});

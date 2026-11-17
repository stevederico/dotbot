import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert';
import { ReadableStream } from 'node:stream/web';
import { TextEncoder } from 'node:util';
import { agentLoop, estimateMessageTokens } from '../core/agent.js';
import type { AgentEvent, Provider } from '../types.js';

interface SSEDelta {
  content?: string;
  finish_reason?: string;
}

type RestoreFetch = () => void;

function makeLocalProvider(): Provider {
  return {
    id: 'local',
    name: 'Test Local',
    apiUrl: 'http://127.0.0.1:1316/v1',
    endpoint: '/chat/completions',
    local: true,
    headers: () => ({ 'Content-Type': 'application/json' }),
    defaultModel: 'test-model',
    models: [{ id: 'test-model', name: 'Test Model' }],
    formatRequest: (messages, model) => ({ model, messages: [] }),
    formatResponse: () => undefined,
  };
}

function mockSSEResponse(deltas: SSEDelta[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
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

function stubFetch(response: Response): RestoreFetch {
  const original = globalThis.fetch;
  globalThis.fetch = async () => response;
  return () => { globalThis.fetch = original; };
}

describe('agentLoop — local short plain-text response flush', () => {
  let restoreFetch: RestoreFetch | null;

  afterEach(() => {
    if (restoreFetch) {
      restoreFetch();
      restoreFetch = null;
    }
  });

  test('yields text_delta for a <200-char greeting that never hits passthrough threshold', async () => {
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

    const events: AgentEvent[] = [];
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
    restoreFetch = stubFetch(mockSSEResponse([
      { content: '<tool_call>' },
      { content: '{"name":"dot_web_search","arguments":{"query":"weather"}}' },
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
          name: 'dot_web_search',
          description: 'Search',
          parameters: { type: 'object' },
          execute: async () => 'sunny',
        },
      ],
      provider: makeLocalProvider(),
      maxTurns: 1,
    });

    const events: AgentEvent[] = [];
    for await (const event of gen) {
      events.push(event);
      if (events.length > 20) break;
    }

    const textWithMarkers = events
      .filter((e): e is Extract<AgentEvent, { type: 'text_delta' }> => e.type === 'text_delta')
      .filter((e) => e.text && e.text.includes('<tool_call>'));
    assert.strictEqual(textWithMarkers.length, 0,
      'tool_call markup must not leak through the flush branch');
  });

  test('end-to-end text accumulation matches the realtime consumer pattern', async () => {
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

describe('estimateMessageTokens', () => {
  test('counts plain text messages at chars/4', () => {
    const messages = [{ role: 'user', content: 'x'.repeat(400) }];
    const estimate = estimateMessageTokens(messages);
    assert.ok(estimate >= 100 && estimate < 120, `got ${estimate}`);
  });

  test('counts an image_url part flat instead of chars/4 over its base64', () => {
    const base64 = 'A'.repeat(120_000);
    const messages = [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } },
        { type: 'text', text: 'what is on my screen?' },
      ],
    }];
    const estimate = estimateMessageTokens(messages);
    assert.ok(estimate < 300, `image should count flat, got ${estimate}`);
    assert.ok(estimate >= 256, `flat image cost missing, got ${estimate}`);
  });

  test('two images cost twice the flat budget', () => {
    const part = { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${'B'.repeat(50_000)}` } };
    const one = estimateMessageTokens([{ role: 'user', content: [part] }]);
    const two = estimateMessageTokens([{ role: 'user', content: [part, part] }]);
    assert.strictEqual(two - one, 256);
  });

  test('tolerates malformed entries without throwing', () => {
    assert.ok(estimateMessageTokens([null, 'plain', { role: 'user', content: [null, 42] }]) >= 0);
  });
});

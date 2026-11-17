import { test, describe } from 'node:test';
import assert from 'node:assert';
import { ReadableStream } from 'node:stream/web';
import { TextEncoder } from 'node:util';
import { agentLoop } from '../core/agent.js';
import type { AgentEvent, Provider } from '../types.js';

interface SSEDelta {
  content?: string;
  reasoning_content?: string;
  finish_reason?: string;
}

const localProvider: Provider = {
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

function sseResponse(deltas: SSEDelta[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const delta of deltas) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`));
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

async function runAgent(response: Response, provider: Provider): Promise<AgentEvent[]> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => response;
  const events: AgentEvent[] = [];
  try {
    const gen = agentLoop({ model: 'test-model', messages: [{ role: 'user', content: 'hi' }], tools: [], provider });
    for await (const event of gen) {
      events.push(event);
      if (event.type === 'done' || events.length > 50) break;
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  return events;
}

function textDeltas(events: AgentEvent[]): string[] {
  return events.flatMap((e) => (e.type === 'text_delta' ? [e.text] : []));
}

function thinkingText(events: AgentEvent[]): string {
  return events.flatMap((e) => (e.type === 'thinking' ? [e.text] : [])).join('');
}

describe('agentLoop local output format detection', () => {
  test('a plain reply past the detect threshold streams through as separate text_deltas', async () => {
    const chunk = 'word '.repeat(30);
    const events = await runAgent(sseResponse([
      { content: chunk },
      { content: chunk },
      { content: 'tail one' },
      { content: 'tail two' },
      { finish_reason: 'stop' },
    ]), localProvider);
    const deltas = textDeltas(events);
    assert.strictEqual(deltas.join(''), `${chunk}${chunk}tail onetail two`);
    assert.deepStrictEqual(deltas.slice(-2), ['tail one', 'tail two']);
  });

  test('gpt-oss channel tokens split analysis into thinking and final into text', async () => {
    const events = await runAgent(sseResponse([
      { content: '<|channel|>analysis<|message|>' },
      { content: 'user says hi' },
      { content: '<|end|>' },
      { content: '<|start|>assistant<|channel|>final<|message|>' },
      { content: 'Hello!' },
      { finish_reason: 'stop' },
    ]), localProvider);
    assert.strictEqual(thinkingText(events), 'user says hi');
    assert.strictEqual(textDeltas(events).join(''), 'Hello!');
  });

  test('native reasoning streams thinking and every content delta without buffering', async () => {
    const events = await runAgent(sseResponse([
      { reasoning_content: 'pondering' },
      { content: 'Hi' },
      { content: ' there' },
      { finish_reason: 'stop' },
    ]), localProvider);
    assert.strictEqual(thinkingText(events), 'pondering');
    assert.deepStrictEqual(textDeltas(events), ['Hi', ' there']);
  });
});

describe('agentLoop provider failure message', () => {
  test('error event keeps the provider body hint instead of only the status', async () => {
    const remoteProvider: Provider = { ...localProvider, id: 'dottiepro', name: 'Dottie Pro', local: false };
    const response = new Response(
      JSON.stringify({ error: 'free credit used', paid_required: true }),
      { status: 402, headers: { 'Content-Type': 'application/json' } },
    );
    const originalError = console.error;
    console.error = () => {};
    try {
      const events = await runAgent(response, remoteProvider);
      const errors = events.flatMap((e) => (e.type === 'error' ? [e.error] : []));
      assert.strictEqual(errors.length, 1);
      assert.match(errors[0] ?? '', /free credit used/);
    } finally {
      console.error = originalError;
    }
  });
});

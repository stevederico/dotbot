# dotbot-sdk

**The AI agent engine for Node.js applications.**

dotbot-sdk is a framework-agnostic SDK that provides the core primitives for building AI agent systems: a streaming agent loop, pluggable storage, a composable tool registry, and orchestration for goals, triggers, and scheduled tasks.

It is the engine — not the application. You bring the server, the auth, the HTTP routes. dotbot-sdk handles everything below that.

**Repository:** [github.com/stevederico/dotbot](https://github.com/stevederico/dotbot)
**Package:** `@dottie/agent`

---

## Why an SDK?

Most AI agent libraries are all-in-one applications — they make decisions about your deployment target, your chat platform, your provider, and your storage. dotbot-sdk makes none of those decisions. It gives you clean primitives and gets out of the way.

```
Your Application (Hono, Express, Fastify, Deno, etc.)
        │
        ▼
   createAgent()          ← dotbot-sdk
   ┌────────────────────────────────────────────┐
   │  Agent Loop          streaming async gen   │
   │  Tool Registry       45 built-in tools     │
   │  SessionStore        pluggable adapters     │
   │  CronStore           scheduled tasks        │
   │  GoalStore           multi-step execution   │
   │  TriggerStore        event-driven triggers  │
   └────────────────────────────────────────────┘
        │
        ▼
   AI Providers (Anthropic, OpenAI, xAI, Ollama)
```

---

## Features

- **Framework-agnostic** — Works with any Node.js web framework (Hono, Express, Fastify, Deno)
- **Provider-agnostic** — Runtime-injected API keys; switch providers per-request. Supports Anthropic, OpenAI, xAI, Ollama
- **Provider failover** — Automatic retry on alternate provider if primary fails
- **Database-agnostic** — Abstract store interfaces with MongoDB and SQLite adapters included
- **Streaming-first** — `agent.chat()` is an async generator yielding typed SSE events (`text_delta`, `tool_start`, `tool_result`, `thinking`, `done`, `stats`)
- **45 built-in tools** — Memory, web search, browser automation, file I/O, image generation, weather, goals, triggers, cron, and more
- **Custom tools** — Register any tool with a simple `{ name, description, parameters, execute }` object
- **Goal system** — Multi-step autonomous workflows with priority, deadline, and auto-execution mode
- **Event-driven triggers** — React to application events with agent responses, with cooldown control
- **Scheduled tasks** — Agent-callable cron with interval strings (`1d`, `30m`) and recurring heartbeats
- **Message normalization** — Canonical message format stored once, converted to provider wire format just-in-time
- **Context compaction** — Token estimation and automatic message summarization near context limits
- **Session management** — Multi-session per user, with full conversation history

---

## Installation

```bash
# npm
npm install @dottie/agent

# From local path (development)
npm install file:/path/to/dotbot
```

---

## Quick Start

```javascript
import {
  createAgent,
  SQLiteSessionStore,
  coreTools
} from '@dottie/agent';

// Initialize storage
const sessionStore = new SQLiteSessionStore();
await sessionStore.init('./sessions.db', {
  prefsFetcher: async (userId) => ({ agentName: 'Dottie', agentPersonality: '' }),
});

// Create agent
const agent = createAgent({
  sessionStore,
  providers: {
    anthropic: { apiKey: process.env.ANTHROPIC_API_KEY },
    openai:    { apiKey: process.env.OPENAI_API_KEY },
    xai:       { apiKey: process.env.XAI_API_KEY },
    ollama:    { baseUrl: 'http://localhost:11434' },
  },
  tools: coreTools,
});

// Create a session
const session = await agent.createSession('user123', 'claude-sonnet-4-5', 'anthropic');

// Stream a response
for await (const event of agent.chat({
  sessionId: session.id,
  message:   'Search for the latest AI news and summarize it',
  provider:  'anthropic',
  model:     'claude-sonnet-4-5',
  context:   { userID: 'user123' },
})) {
  switch (event.type) {
    case 'text_delta':  process.stdout.write(event.text); break;
    case 'tool_start':  console.log(`[${event.name}]`, event.input); break;
    case 'done':        console.log('\nDone'); break;
  }
}
```

---

## Package Structure

```
@dottie/agent/
├── index.js              # Main exports — createAgent() and all public APIs
├── core/
│   ├── agent.js          # Agent loop (async generator, streams SSE events)
│   ├── events.js         # SSE event schemas and validation
│   ├── compaction.js     # Message compaction and token estimation
│   ├── normalize.js      # Message normalization (provider ↔ standard format)
│   ├── failover.js       # Provider failover logic
│   ├── init.js           # Unified initialization helper
│   ├── cron_handler.js   # Cron task execution factory
│   └── trigger_handler.js# Trigger event factory
├── storage/
│   ├── SessionStore.js   # Abstract session interface
│   ├── SQLiteAdapter.js  # SQLite session adapter (Node.js 22.5+, zero deps)
│   ├── MemoryStore.js    # In-memory adapter (dev/testing)
│   ├── CronStore.js      # Abstract cron interface
│   ├── GoalStore.js      # Abstract goal interface
│   ├── TriggerStore.js   # Abstract trigger interface
│   └── Mongo*.js         # MongoDB adapters for all stores
├── tools/                # 45 built-in tools across 12 categories
│   ├── memory.js         # Long-term memory (save, search, update, delete)
│   ├── web.js            # Web search and fetch
│   ├── browser.js        # Playwright browser automation
│   ├── goals.js          # Multi-step goal execution
│   ├── triggers.js       # Event-driven trigger management
│   ├── cron.js           # Scheduled task management
│   └── ...
└── utils/
    └── providers.js      # Provider configurations (Anthropic, OpenAI, xAI, Ollama)
```

### Importing from Subpaths

When importing from subpaths, omit the `.js` extension:

```javascript
// ✅ Correct
import { agentLoop } from '@dottie/agent/core/agent';
import { toProviderFormat } from '@dottie/agent/core/normalize';

// ❌ Wrong (causes "module not found")
import { agentLoop } from '@dottie/agent/core/agent.js';
```

---

## MongoDB Setup

For multi-user production deployments with full-text search:

```javascript
import {
  createAgent,
  MongoSessionStore,
  MongoCronStore,
  MongoGoalStore,
  MongoTriggerStore,
  coreTools
} from '@dottie/agent';
import { MongoClient } from 'mongodb';

const client = await MongoClient.connect(process.env.MONGODB_URL);
const db = client.db('myapp');

const sessionStore = new MongoSessionStore();
await sessionStore.init(db, {
  prefsFetcher: async (userId) => ({ agentName: 'Dottie', agentPersonality: '' }),
});

const cronStore = new MongoCronStore();
await cronStore.init(db, {
  onTaskFire: async (task) => {
    for await (const event of agent.chat({
      sessionId: task.sessionId,
      message:   task.prompt,
      provider:  'anthropic',
      model:     'claude-sonnet-4-5',
    })) { /* handle events */ }
  },
});

const goalStore = new MongoGoalStore();
await goalStore.init(db);

const triggerStore = new MongoTriggerStore();
await triggerStore.init(db);

const agent = createAgent({
  sessionStore,
  cronStore,
  goalStore,
  triggerStore,
  providers: {
    anthropic: { apiKey: process.env.ANTHROPIC_API_KEY },
    openai:    { apiKey: process.env.OPENAI_API_KEY },
  },
  tools: coreTools,
});
```

---

## API Reference

### `createAgent(options)`

Create an agent instance.

```typescript
createAgent({
  sessionStore:        SessionStore,             // required
  providers: {
    anthropic?:        { apiKey: string },
    openai?:           { apiKey: string },
    xai?:              { apiKey: string },
    ollama?:           { baseUrl: string },
  },
  tools?:              Tool[],                   // defaults to coreTools (45 tools)
  systemPrompt?:       (name, personality, timestamp) => string,
  cronStore?:          CronStore,
  goalStore?:          GoalStore,
  triggerStore?:       TriggerStore,
  memoryStore?:        SQLiteMemoryStore,
  screenshotUrlPattern?: (filename: string) => string,
  compaction?:         { enabled: boolean, threshold: number, targetLength: number },
})
```

Returns an agent API object:

```typescript
{
  async *chat(options): AsyncGenerator<Event>,
  async createSession(owner, model, provider): Promise<Session>,
  async getSession(sessionId, owner): Promise<Session>,
  async listSessions(owner): Promise<Session[]>,
  async deleteSession(sessionId, owner): Promise<void>,
  async clearSession(sessionId): Promise<void>,
  getTools(): Tool[],
  getCronStore(): CronStore | null,
  getGoalStore(): GoalStore | null,
  getTriggerStore(): TriggerStore | null,
  getMemoryStore(): SQLiteMemoryStore | null,
}
```

---

### `agent.chat(options)`

Streams a response as an async generator of typed SSE events.

```typescript
agent.chat({
  sessionId: string,      // required
  message:   string,      // required
  provider:  string,      // 'anthropic' | 'openai' | 'xai' | 'ollama'
  model:     string,      // provider-specific model ID
  signal?:   AbortSignal,
  context?:  object,      // passed to all tool execute() calls
})
```

#### SSE Event Types

| Event | Schema | Description |
|---|---|---|
| `text_delta` | `{ type, text }` | Incremental text from model |
| `thinking` | `{ type, text, hasNativeThinking }` | Model reasoning process |
| `tool_start` | `{ type, name, input }` | Tool execution begins |
| `tool_result` | `{ type, name, input, result }` | Tool completed successfully |
| `tool_error` | `{ type, name, error }` | Tool execution failed |
| `done` | `{ type, content }` | Agent loop complete |
| `stats` | `{ type, model, inputTokens, outputTokens }` | Token usage (normalized field names) |
| `followup` | `{ type, text }` | Suggested follow-up question |
| `max_iterations` | `{ type, message }` | Iteration limit reached |
| `error` | `{ type, error }` | Fatal error |

All providers emit the same event schema — Anthropic/OpenAI differences are normalized internally.

---

### SessionStore Interface

All adapters implement:

```typescript
class SessionStore {
  async init(db, options?)
  async createSession(owner, model, provider): Promise<Session>
  async getSession(sessionId, owner): Promise<Session | null>
  async getSessionInternal(sessionId): Promise<Session | null>
  async getOrCreateDefaultSession(owner): Promise<Session>
  async saveSession(sessionId, messages, model, provider)
  async addMessage(sessionId, message)
  async setModel(sessionId, model)
  async setProvider(sessionId, provider)
  async clearSession(sessionId)
  async listSessions(owner): Promise<Session[]>
  async deleteSession(sessionId, owner)
  trimMessages(messages, maxMessages): Message[]
}
```

**Included adapters:**
- `SQLiteSessionStore` — SQLite via Node.js 22.5+ built-in sqlite module (zero extra dependencies)
- `MongoSessionStore` — MongoDB with full-text search support
- `MemorySessionStore` — In-memory Map (dev and testing)

**Session object:**
```typescript
{
  id:        string,   // 'sess_abc123'
  owner:     string,   // user ID
  title:     string,
  model:     string,   // 'claude-sonnet-4-5'
  provider:  string,   // 'anthropic'
  messages:  Message[],
  createdAt: string,   // ISO timestamp
  updatedAt: string,
}
```

---

## Built-in Tools (45)

### Memory (6)
`memory_save`, `memory_search`, `memory_delete`, `memory_list`, `memory_read`, `memory_update`

### Web (3)
`web_search` (Grok Responses API or DuckDuckGo fallback), `web_fetch`, `grokipedia_search`

### Code (1)
`run_code` — Execute JavaScript in a sandboxed subprocess

### Files (6)
`file_read`, `file_write`, `file_list`, `file_delete`, `file_move`, `folder_create`

### Messages (4)
`message_list`, `message_send`, `message_read`, `message_delete`

### Images (3)
`image_generate` (xAI Grok Imagine), `image_list`, `image_search`

### Weather (1)
`weather_get` — Open-Meteo API (no key required)

### Notify (1)
`notify_user`

### Browser (7)
`browser_navigate`, `browser_read_page`, `browser_click`, `browser_type`, `browser_screenshot`, `browser_extract`, `browser_close`

### Goals (9)
`goal_create`, `goal_list`, `goal_plan`, `goal_work`, `goal_step_done`, `goal_complete`, `goal_delete`, `goal_search`, `goal_stats`

### Triggers (4)
`trigger_create`, `trigger_list`, `trigger_toggle`, `trigger_delete`

### Cron (1+)
`schedule_task` — Agent-callable scheduled task creation

---

## Custom Tools

```javascript
const myTools = [
  {
    name: 'get_inventory',
    description: 'Get current inventory for a product SKU',
    parameters: {
      type: 'object',
      properties: {
        sku: { type: 'string', description: 'Product SKU' },
      },
      required: ['sku'],
    },
    execute: async ({ sku }, signal, context) => {
      const db = context.databaseManager;
      return await db.inventory.findOne({ sku });
    },
  },
];

const agent = createAgent({
  sessionStore,
  providers,
  tools: [...coreTools, ...myTools],
});
```

The `context` object passed to `execute()` is the same object you pass to `agent.chat()` — use it to inject databases, user state, or any request-scoped data.

---

## Goal System

Goals enable multi-step autonomous workflows. In `auto` mode the agent executes steps sequentially, scheduling each next step via CronStore automatically.

```javascript
// The agent creates the goal and drives execution
for await (const event of agent.chat({
  sessionId,
  message: `Create a goal to audit our API endpoints and produce a security report.
            Use 5 steps, auto mode.`,
  provider: 'anthropic',
  model:    'claude-sonnet-4-5',
  context:  { userID: 'user-123' },
})) {
  console.log(event);
}
// Step 1 runs → schedules Step 2 → ... → goal marked complete
```

**Requires:** `goalStore` and `cronStore` passed to `createAgent()`.

---

## Event-Driven Triggers

Triggers let the agent react to application events. You define what events mean; the library fires the agent when they occur.

```javascript
// Agent creates a trigger via chat
for await (const event of agent.chat({
  sessionId,
  message: `Create a trigger for "order_placed" events.
            Prompt: "A new order was placed. Check inventory and notify the fulfillment team."
            Cooldown: 5 minutes.`,
  ...
})) {}

// Later, from your application code:
const triggers = await triggerStore.findMatchingTriggers(userId, 'order_placed');
for (const trigger of triggers) {
  for await (const event of agent.chat({
    sessionId,
    message: trigger.prompt,
    ...
  })) { /* stream to user */ }

  await triggerStore.markTriggerFired(trigger._id.toString());
}
```

**Requires:** `triggerStore` passed to `createAgent()`.

---

## Message Normalization

Messages are stored in a canonical standard format and converted to provider-specific wire format just-in-time before each API call. This means you can switch providers without reformatting stored history.

```javascript
import { toStandardFormat, toProviderFormat } from '@dottie/agent/core/normalize';

// Normalize any provider's raw messages to standard format
const standard = toStandardFormat(rawMessages);

// Convert standard format to a specific provider's wire format
const forAnthropic = toProviderFormat(standard, 'anthropic');
const forOpenAI    = toProviderFormat(standard, 'openai');
```

**Standard assistant message:**
```javascript
{
  role:       'assistant',
  content:    'Here are the results.',
  toolCalls:  [{ id, name, input, result, status: 'done' }],
  thinking:   'I should search for recent data...',
  images:     [{ url, prompt }],
  _ts:        1700000000000,
}
```

---

## Provider Support

| Provider | Config Key | Auth | Notes |
|---|---|---|---|
| Anthropic Claude | `anthropic` | `apiKey` | Native thinking, 200k context |
| OpenAI GPT | `openai` | `apiKey` | Function calling, JSON mode |
| xAI Grok | `xai` | `apiKey` | Real-time web search, image generation |
| Ollama | `ollama` | `baseUrl` | Local inference, no API cost |

Provider failover is automatic — if the primary fails (rate limit, error, timeout), the agent retries or switches.

---

## Hono Server Example

```javascript
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { createAgent, SQLiteSessionStore, coreTools } from '@dottie/agent';

const app = new Hono();

const sessionStore = new SQLiteSessionStore();
await sessionStore.init('./sessions.db');

const agent = createAgent({
  sessionStore,
  providers: {
    anthropic: { apiKey: process.env.ANTHROPIC_API_KEY },
    openai:    { apiKey: process.env.OPENAI_API_KEY },
  },
  tools: coreTools,
});

app.post('/api/chat', async (c) => {
  const { sessionId, message, provider, model } = await c.req.json();
  const userId = c.get('userId'); // from auth middleware

  return streamSSE(c, async (stream) => {
    for await (const event of agent.chat({
      sessionId, message, provider, model,
      context: { userID: userId },
    })) {
      await stream.writeSSE({ data: JSON.stringify(event), event: event.type });
    }
  });
});

app.get('/api/sessions',        async (c) => c.json(await agent.listSessions(c.get('userId'))));
app.post('/api/sessions',       async (c) => { const { model, provider } = await c.req.json(); return c.json(await agent.createSession(c.get('userId'), model, provider)); });
app.delete('/api/sessions/:id', async (c) => { await agent.deleteSession(c.req.param('id'), c.get('userId')); return c.json({ success: true }); });
```

---

## React Hook Example

```javascript
import { useState, useCallback } from 'react';

function useAgentChat(sessionId) {
  const [messages, setMessages]       = useState([]);
  const [isStreaming, setIsStreaming]  = useState(false);
  const [activeTool, setActiveTool]   = useState(null);

  const sendMessage = useCallback(async (message, provider = 'anthropic', model = 'claude-sonnet-4-5') => {
    setIsStreaming(true);
    setMessages(prev => [...prev, { role: 'user', content: message }]);

    let assistantText = '';

    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, message, provider, model }),
    });

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer    = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const event = JSON.parse(line.slice(6));

          if (event.type === 'text_delta') {
            assistantText += event.text;
            setMessages(prev => {
              const updated = [...prev];
              const last = updated[updated.length - 1];
              if (last?.role === 'assistant') {
                updated[updated.length - 1] = { ...last, content: assistantText };
              } else {
                updated.push({ role: 'assistant', content: assistantText });
              }
              return updated;
            });
          } else if (event.type === 'tool_start') {
            setActiveTool({ name: event.name, input: event.input });
          } else if (event.type === 'tool_result') {
            setActiveTool(null);
          }
        }
      }
    } finally {
      setIsStreaming(false);
      setActiveTool(null);
    }
  }, [sessionId]);

  return { messages, sendMessage, isStreaming, activeTool };
}
```

---

## Custom SessionStore

Implement the `SessionStore` interface for any database:

```javascript
import { SessionStore } from '@dottie/agent';

class PostgresSessionStore extends SessionStore {
  constructor(pool) {
    super();
    this.pool = pool;
  }

  async init(options = {}) {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        id UUID PRIMARY KEY, owner TEXT NOT NULL, title TEXT,
        messages JSONB, model TEXT, provider TEXT,
        created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
  }

  async createSession(owner, model, provider) {
    const id = crypto.randomUUID();
    await this.pool.query(
      'INSERT INTO sessions (id, owner, messages, model, provider) VALUES ($1, $2, $3, $4, $5)',
      [id, owner, JSON.stringify([]), model, provider]
    );
    return { id, owner, messages: [], model, provider };
  }

  // ... implement remaining SessionStore methods
}
```

---

## Best Practices

**Choose the right SessionStore:**
```javascript
const sessionStore = new MemorySessionStore();     // dev/testing
const sessionStore = new SQLiteSessionStore();     // single-process production
const sessionStore = new MongoSessionStore();      // multi-process / scalable
```

**Handle errors in the stream:**
```javascript
try {
  for await (const event of agent.chat({ ... })) {
    if (event.type === 'error') { showError(event.error); break; }
    handleEvent(event);
  }
} catch (err) {
  console.error('Stream error:', err);
}
```

**Cancel in-flight requests:**
```javascript
const controller = new AbortController();
for await (const event of agent.chat({ ..., signal: controller.signal })) { ... }
cancelButton.onclick = () => controller.abort();
```

**Enable compaction for long conversations:**
```javascript
const agent = createAgent({
  ...,
  compaction: { enabled: true, threshold: 50, targetLength: 20 },
});
```

---

## Troubleshooting

**`sessionStore is not defined`** — Call `await sessionStore.init(...)` before `createAgent()`.

**`Provider not configured`** — Ensure the provider key is in the `providers` object passed to `createAgent()`.

**`Tool execution failed`** — Many tools require `userID` and `databaseManager` in `context`. Check that your `agent.chat()` call passes them.

**SSE stream stops prematurely** — Ensure your HTTP server supports streaming. For Hono, use `streamSSE()`. For Express, set `Content-Type: text/event-stream` and `Connection: keep-alive`.

---

## License

MIT

## Links

- **Issues:** https://github.com/stevederico/dotbot/issues
- **Example app (dottie-os):** https://github.com/stevederico/dottie-os

# @dottie/agent

Framework-agnostic AI agent system with tool execution, session management, and scheduled tasks.

**Repository:** [github.com/stevederico/dotbot](https://github.com/stevederico/dotbot)
**Package:** `@dottie/agent` (not yet published to npm)

## Features

- **Framework-agnostic** - Works with any Node.js web framework (Hono, Express, Fastify, Deno)
- **Database-agnostic** - SessionStore interface supports any backend (MongoDB, SQLite, PostgreSQL, in-memory, etc.)
- **Provider-agnostic** - Runtime-injected API keys work with any provider (Anthropic, OpenAI, xAI, Ollama)
- **Tool system** - 45 built-in tools + extensible registry for custom tools
- **Session management** - Multi-session support with conversation history
- **Auto-compaction** - Intelligent message summarization when context limits approach
- **Scheduled tasks** - CronStore interface for recurring agent actions
- **Goal-oriented execution** - Multi-step autonomous workflows with progress tracking
- **Event-driven triggers** - Context-aware responses that fire on specific events

## Installation

```bash
# From npm (after publishing)
npm install @dottie/agent

# From local path (during development)
npm install file:/path/to/dotbot
# or in package.json:
# "@dottie/agent": "file:/Users/sd/Dropbox/BixbyApps/Apps/Other/dotbot"
```

## Package Structure

```
@dottie/agent/
├── index.js              # Main exports
├── core/
│   ├── agent.js          # Agent loop
│   ├── compaction.js     # Message compaction
│   └── failover.js       # Provider failover
├── storage/
│   ├── SessionStore.js   # Session interface
│   ├── SQLiteAdapter.js  # SQLite session adapter (default)
│   ├── MemoryStore.js    # In-memory session adapter
│   ├── CronStore.js      # Cron interface
│   ├── GoalStore.js      # Goal interface
│   ├── TriggerStore.js   # Trigger interface
│   └── Mongo*.js         # MongoDB adapters
├── tools/                # 41 built-in tools
│   ├── memory.js
│   ├── web.js
│   ├── browser.js
│   ├── goals.js
│   ├── triggers.js
│   └── ...
└── utils/
    └── providers.js      # Provider configs
```

### Importing from Subpaths

**Important:** When importing from subpaths, omit the `.js` extension:

```javascript
// ✅ Correct
import { agentLoop } from '@dottie/agent/core/agent';
import { sessionManager } from '@dottie/agent/tools/browser';

// ❌ Wrong (will cause "module not found" errors)
import { agentLoop } from '@dottie/agent/core/agent.js';
```

## Quick Start

```javascript
import {
  createAgent,
  SQLiteSessionStore,
  coreTools
} from '@dottie/agent';

// Initialize SQLite session store (zero dependencies, Node.js 22.5+)
const sessionStore = new SQLiteSessionStore();
await sessionStore.init('./sessions.db', {
  prefsFetcher: async (userId) => ({ agentName: 'Dottie', agentPersonality: '' }),
});

// Create agent
const agent = createAgent({
  sessionStore,
  providers: {
    anthropic: { apiKey: process.env.ANTHROPIC_API_KEY },
    openai: { apiKey: process.env.OPENAI_API_KEY },
    xai: { apiKey: process.env.XAI_API_KEY },
    ollama: { baseUrl: 'http://localhost:11434' },
  },
  tools: coreTools,
  screenshotUrlPattern: (filename) => `/api/screenshots/${filename}`,
});

// Create session
const session = await agent.createSession('user123', 'claude-sonnet-4-5', 'anthropic');

// Chat with agent (SSE stream)
for await (const event of agent.chat({
  sessionId: session.id,
  message: 'What is 2+2?',
  provider: 'anthropic',
  model: 'claude-sonnet-4-5',
  context: {
    userID: 'user123',
  },
})) {
  console.log(event);
  // { type: 'text_delta', delta: '2+2 equals 4.' }
  // { type: 'done', messages: [...] }
}
```

### Alternative: MongoDB for Scalable Deployments

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

// Connect to MongoDB
const client = await MongoClient.connect(process.env.MONGODB_URL);
const db = client.db('myapp');

// Initialize session store
const sessionStore = new MongoSessionStore();
await sessionStore.init(db, {
  prefsFetcher: async (userId) => ({ agentName: 'Dottie', agentPersonality: '' }),
});

// Initialize cron store (optional - for scheduled tasks)
const cronStore = new MongoCronStore();
await cronStore.init(db, {
  onTaskFire: async (task) => {
    console.log('[cron] Task fired:', task.name);
    // Execute task...
  },
});

// Initialize goal store (optional - for autonomous multi-step execution)
const goalStore = new MongoGoalStore();
await goalStore.init(db);

// Initialize trigger store (optional - for event-driven responses)
const triggerStore = new MongoTriggerStore();
await triggerStore.init(db);

// Create agent
const agent = createAgent({
  sessionStore,
  cronStore,
  goalStore,
  triggerStore,
  providers: {
    anthropic: { apiKey: process.env.ANTHROPIC_API_KEY },
    openai: { apiKey: process.env.OPENAI_API_KEY },
    xai: { apiKey: process.env.XAI_API_KEY },
    ollama: { baseUrl: 'http://localhost:11434' },
  },
  tools: coreTools,
});
```

## API Reference

### `createAgent(options)`

Create an agent instance with configurable stores, providers, and tools.

**Parameters:**
```typescript
{
  // Required: Session storage implementation
  sessionStore: SessionStore,

  // Required: AI provider configurations
  providers: {
    anthropic?: { apiKey: string },
    openai?: { apiKey: string },
    xai?: { apiKey: string },
    ollama?: { baseUrl: string },
  },

  // Optional: System prompt template function
  systemPrompt?: (agentName: string, agentPersonality: string, timestamp: string) => string,

  // Optional: Tool array (defaults to coreTools - 45 tools)
  tools?: Tool[],

  // Optional: Scheduled task store (for recurring tasks)
  cronStore?: CronStore,

  // Optional: Goal store (for autonomous multi-step execution)
  goalStore?: GoalStore,

  // Optional: Trigger store (for event-driven responses)
  triggerStore?: TriggerStore,

  // Optional: Screenshot URL pattern for browser tools
  screenshotUrlPattern?: (filename: string) => string,

  // Optional: Message compaction settings
  compaction?: {
    enabled: boolean,
    threshold: number,
    targetLength: number,
  },
}
```

**Returns:** Agent API object with methods:
```typescript
{
  // Stream chat with async generator (yields SSE events)
  async *chat(options: ChatOptions): AsyncGenerator<Event>,

  // Session management
  async createSession(owner: string, model: string, provider: string): Promise<Session>,
  async getSession(sessionId: string, owner: string): Promise<Session>,
  async listSessions(owner: string): Promise<Session[]>,
  async deleteSession(sessionId: string, owner: string): Promise<void>,
  async clearSession(sessionId: string): Promise<void>,

  // Tool inspection
  getTools(): Tool[],

  // Store access (if configured)
  getCronStore(): CronStore | null,
  getGoalStore(): GoalStore | null,
  getTriggerStore(): TriggerStore | null,
}
```

### `agent.chat(options)`

Streams a chat response as an async generator yielding Server-Sent Events (SSE).

#### Input Parameters

```typescript
{
  sessionId: string,        // Session ID (required)
  message: string,          // User message (required)
  provider: string,         // Provider name: 'anthropic' | 'openai' | 'xai' | 'ollama'
  model: string,            // Model ID (provider-specific)
  signal?: AbortSignal,     // Optional abort signal for cancellation
  context?: object,         // Optional context object passed to tools
}
```

#### Output: SSE Event Stream

The generator yields Server-Sent Events with the following types:

**1. Text Delta Event** - Streaming text response chunks
```javascript
{
  type: 'text_delta',
  text: 'Hello! I can help you with that.',  // Text chunk
  index: 0                                    // Content block index
}
```

**2. Thinking Event** - Model's reasoning process (when available)
```javascript
{
  type: 'thinking',
  thinking: 'The user wants to search for AI news. I should use web_search tool with a recent query.'
}
```

**3. Tool Start Event** - Tool execution begins
```javascript
{
  type: 'tool_start',
  tool: 'web_search',                        // Tool name
  input: {                                   // Tool input parameters
    query: 'latest AI news',
    maxResults: 5
  },
  toolCallId: 'call_abc123'                  // Unique call ID
}
```

**4. Tool Result Event** - Tool execution completes
```javascript
{
  type: 'tool_result',
  tool: 'web_search',                        // Tool name
  result: [                                  // Tool output
    { title: 'OpenAI releases GPT-5', url: 'https://...' },
    { title: 'Google launches Gemini 3.0', url: 'https://...' }
  ],
  toolCallId: 'call_abc123'                  // Matching call ID
}
```

**5. Done Event** - Conversation turn complete
```javascript
{
  type: 'done',
  stopReason: 'end_turn',                    // 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use'
  usage: {                                   // Token usage stats
    input_tokens: 1234,
    output_tokens: 567
  }
}
```

**6. Error Event** - Error occurred during processing
```javascript
{
  type: 'error',
  error: 'Rate limit exceeded',              // Error message
  code: 'rate_limit_error'                   // Error code
}
```

#### Example: Processing Events

```javascript
for await (const event of agent.chat({
  sessionId: 'sess_123',
  message: 'Search for AI news and summarize',
  provider: 'anthropic',
  model: 'claude-sonnet-4-5',
  context: { userID: 'user-456' }
})) {
  switch (event.type) {
    case 'text_delta':
      process.stdout.write(event.text);
      break;

    case 'thinking':
      console.log('\n[Thinking]', event.thinking);
      break;

    case 'tool_start':
      console.log(`\n[Tool: ${event.tool}]`, event.input);
      break;

    case 'tool_result':
      console.log(`[Result]`, event.result);
      break;

    case 'done':
      console.log('\n[Complete]', event.usage);
      break;

    case 'error':
      console.error('[Error]', event.error);
      break;
  }
}
```

### SessionStore Interface

Abstract interface for session storage. Implementations must provide these methods:

```typescript
class SessionStore {
  async init(db: any, options?: { prefsFetcher?: (userId: string) => Promise<UserPrefs> }): Promise<void>
  async createSession(owner: string, model: string, provider: string): Promise<Session>
  async getSession(sessionId: string, owner: string): Promise<Session | null>
  async getSessionInternal(sessionId: string): Promise<Session | null>
  async getOrCreateDefaultSession(owner: string): Promise<Session>
  async saveSession(sessionId: string, messages: Message[], model: string, provider: string): Promise<void>
  async addMessage(sessionId: string, message: Message): Promise<void>
  async setModel(sessionId: string, model: string): Promise<void>
  async setProvider(sessionId: string, provider: string): Promise<void>
  async clearSession(sessionId: string): Promise<void>
  async listSessions(owner: string): Promise<Session[]>
  async deleteSession(sessionId: string, owner: string): Promise<void>
  trimMessages(messages: Message[], maxMessages: number): Message[]
}
```

**Included implementations:**
- `MongoSessionStore` - MongoDB backend with full-text search
- `SQLiteSessionStore` - SQLite backend using Node.js 22.5+ built-in sqlite module (zero dependencies)
- `MemorySessionStore` - In-memory Map-based storage (for testing/development)

#### Session Object Format

```typescript
{
  id: string,              // Unique session ID (e.g., 'sess_abc123')
  owner: string,           // User ID who owns this session
  title: string,           // Optional session title
  model: string,           // Current model (e.g., 'claude-sonnet-4-5')
  provider: string,        // Current provider (e.g., 'anthropic')
  messages: Message[],     // Conversation history
  createdAt: string,       // ISO timestamp
  updatedAt: string,       // ISO timestamp
}
```

#### Message Object Format

```typescript
{
  role: 'user' | 'assistant',
  content: string | Array<ContentBlock>,
  // For assistant messages with tool use:
  tool_calls?: [
    {
      id: string,
      type: 'function',
      function: {
        name: string,
        arguments: string,  // JSON string
      }
    }
  ],
  // For tool results:
  tool_call_id?: string,
  name?: string,         // Tool name
}

### CronStore Interface

Abstract interface for scheduled task storage. Implementations must provide:

- `init(options)` - Initialize store
- `stop()` - Stop polling loop
- `createTask({ name, prompt, sessionId, userId, runAt, intervalMs, recurring, goalId })` - Create task
- `listTasks(sessionId)` - List tasks for session
- `listTasksBySessionIds(sessionIds, userId)` - List tasks for multiple sessions
- `getTask(id)` - Get task by ID
- `deleteTask(id)` - Delete task
- `toggleTask(id, enabled)` - Enable/disable task
- `updateTask(id, updates)` - Update task details
- `ensureHeartbeat(userId)` - Ensure recurring heartbeat exists
- `getHeartbeatStatus(userId)` - Get heartbeat status
- `resetHeartbeat(userId)` - Reset heartbeat with latest prompt
- `triggerHeartbeatNow(userId)` - Manually trigger heartbeat

**Included implementations:**
- `MongoCronStore` - MongoDB backend with 30s polling loop

### Core Tools

45 built-in tools included by default:

**Memory (6 tools):**
- `memory_save(content, tags)` - Save to long-term memory
- `memory_search(query)` - Search memory by query
- `memory_delete(key)` - Delete memory entry
- `memory_list()` - List all memories
- `memory_read(key)` - Read a specific memory by key
- `memory_update(key, content, tags)` - Update or create a memory with a specific key

**Web (3 tools):**
- `web_search(query)` - Search web (Grok Responses API or DuckDuckGo fallback)
- `web_fetch(url, method, body, headers)` - HTTP requests
- `grokipedia_search(query)` - Look up topics on Grokipedia

**Code (1 tool):**
- `run_code(code)` - Execute JavaScript in sandboxed subprocess

**Files (6 tools):**
- `file_read(path)` - Read file from virtual filesystem
- `file_write(path, content)` - Write file to virtual filesystem
- `file_list(path)` - List directory contents
- `file_delete(path)` - Delete file or folder
- `file_move(path, new_name, new_parent)` - Move/rename file
- `folder_create(path, name)` - Create folder

**Messages (4 tools):**
- `message_list()` - List conversations
- `message_send(recipient, content)` - Send message
- `message_read(recipient, limit)` - Read messages in conversation
- `message_delete(recipient)` - Delete conversation

**Images (3 tools):**
- `image_generate(prompt)` - Generate AI image (xAI Grok Imagine)
- `image_list(limit)` - List generated images
- `image_search(query)` - Search images by prompt

**Weather (1 tool):**
- `weather_get(location)` - Get current weather (Open-Meteo API)

**Notify (1 tool):**
- `notify_user(title, body, type)` - Send notification to user

**Browser (7 tools):**
- `browser_navigate(url)` - Navigate to URL
- `browser_read_page(mode)` - Read page content or structure
- `browser_click(selector)` - Click element
- `browser_type(selector, text)` - Type into element
- `browser_screenshot(selector, full_page)` - Take screenshot
- `browser_extract(selector)` - Extract element content
- `browser_close()` - Close browser session

**Goal (9 tools):**
- `goal_create(description, steps, category, priority, deadline, mode)` - Create goal with auto/manual execution
- `goal_list(status, category)` - List all goals with filters
- `goal_plan(goal_id, steps)` - Break goal into detailed action steps
- `goal_work(goal_id)` - Start executing next pending step
- `goal_step_done(goal_id, result)` - Mark step complete, auto-schedule next
- `goal_complete(goal_id)` - Mark goal as completed
- `goal_delete(goal_id)` - Delete goal permanently
- `goal_search(query)` - Search goals by text
- `goal_stats()` - Get goal statistics

**Trigger (4 tools):**
- `trigger_create(eventType, prompt, cooldownMs, metadata)` - Create event-driven trigger
- `trigger_list(enabled, eventType)` - List all triggers
- `trigger_toggle(trigger_id, enabled)` - Enable/disable trigger
- `trigger_delete(trigger_id)` - Delete trigger permanently

## Goals & Triggers

### Goal-Oriented Execution

Goals enable autonomous multi-step workflows. The agent breaks complex tasks into steps and works through them automatically.

**Example: Build QuickBooks Alternative**
```javascript
import { createAgent, MongoSessionStore, MongoCronStore, MongoGoalStore, goalTools } from '@dottie/agent';

// Initialize stores
const sessionStore = new MongoSessionStore();
await sessionStore.init(db);

const cronStore = new MongoCronStore();
await cronStore.init(db, { onTaskFire });

const goalStore = new MongoGoalStore();
await goalStore.init(db);

// Create agent with goals
const agent = createAgent({
  sessionStore,
  cronStore,
  goalStore,  // Enable goal-oriented execution
  providers: { ... },
  tools: [...coreTools, ...goalTools],
});

// Create a goal (agent will execute autonomously)
for await (const event of agent.chat({
  sessionId,
  message: 'Create a goal to build a QuickBooks alternative with 12 steps in auto mode',
  provider: 'anthropic',
  model: 'claude-sonnet-4-5',
  context: { userID: 'user-123' }
})) {
  console.log(event);
}

// Agent breaks into steps and executes each one:
// Step 1: Research → Complete ✓ → Schedule Step 2 (5 sec)
// Step 2: Design → Complete ✓ → Schedule Step 3 (5 sec)
// ...
// Step 12: Deploy → Complete ✓ → Goal DONE ✓
```

**How it works:**
1. Goal created with steps array
2. In `auto` mode, agent executes first step via `goal_work`
3. When step completes (`goal_step_done`), next step is scheduled via CronStore (5 sec delay)
4. Process repeats until all steps complete
5. Goal marked as `completed`, scheduling stops

### Event-Driven Triggers

Triggers enable context-aware responses. The agent reacts to events in real-time.

**Example: Email Summarization**
```javascript
import { createAgent, MongoTriggerStore, triggerTools } from '@dottie/agent';

// Initialize trigger store
const triggerStore = new MongoTriggerStore();
await triggerStore.init(db);

// Create agent with triggers
const agent = createAgent({
  sessionStore,
  triggerStore,  // Enable event-driven responses
  providers: { ... },
  tools: [...coreTools, ...triggerTools],
});

// Create trigger
for await (const event of agent.chat({
  sessionId,
  message: `Create a trigger for user_login events.
            Prompt: "User just logged in. Check for urgent tasks and provide a brief summary."
            Cooldown: 1 hour`,
  provider: 'anthropic',
  model: 'claude-sonnet-4-5',
  context: { userID: 'user-123' }
})) {
  console.log(event);
}

// Later, emit event from your application code:
// (e.g., when user successfully logs in)
const triggers = await triggerStore.findMatchingTriggers('user-123', 'user_login');
for (const trigger of triggers) {
  // Inject trigger prompt into agent conversation
  for await (const event of agent.chat({
    sessionId,
    message: trigger.prompt,
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    context: { userID: 'user-123' }
  })) {
    console.log(event);
  }

  // Mark trigger as fired (updates cooldown)
  await triggerStore.markTriggerFired(trigger._id.toString());
}
```

**Event types:**

Triggers use string-based event types. The library doesn't enforce specific types - you define what makes sense for your app.

**Generic examples:**
- `session_start` - New session started
- `session_end` - Session ended
- `goal_completed` - Goal was completed (library event)
- `error_occurred` - Error happened
- `data_updated` - Data changed
- `task_completed` - Task finished
- `custom` - Any event you define

**Application-specific examples:**

Each application defines events that make sense for its domain. The library doesn't prescribe event types - you choose what to emit:

```javascript
// E-commerce app
eventType: 'order_placed'
eventType: 'payment_received'
eventType: 'shipping_updated'

// Monitoring system
eventType: 'alert_triggered'
eventType: 'metric_exceeded'
eventType: 'service_down'

// Desktop OS (dottie-os)
eventType: 'app_opened'
eventType: 'reminder_due'
eventType: 'file_uploaded'
```

The trigger system is event-agnostic - **you emit events from your application code**, and triggers respond to them.

## Custom Tools

Create custom tools by defining tool objects:

```javascript
const customTools = [
  {
    name: "my_tool",
    description: "What this tool does",
    parameters: {
      type: "object",
      properties: {
        param1: { type: "string", description: "Parameter description" },
      },
      required: ["param1"],
    },
    execute: async (input, signal, context) => {
      // Tool logic here
      return "Result";
    },
  },
];

const agent = createAgent({
  sessionStore,
  tools: [...coreTools, ...customTools],
});
```

## Tool Registry

Dynamic tool registration:

```javascript
import { createToolRegistry } from '@dottie/agent';

const registry = createToolRegistry();
registry.register(...coreTools);
registry.register(myCustomTool);

const tools = registry.getAll();
```

## Context Object

Tools receive a `context` object with:
- `userID` - Current user ID
- `sessionId` - Current session ID
- `databaseManager` - Database manager instance
- `dbConfig` - Database configuration
- `providers` - Provider API keys (injected by library)

Pass additional context when calling `agent.chat()`:

```javascript
for await (const event of agent.chat({
  sessionId,
  message,
  provider,
  model,
  context: {
    userID: 'user123',
    databaseManager: myDatabaseManager,
    dbConfig: { dbType: 'mongodb', db: 'myapp', connectionString: process.env.MONGODB_URL },
    // Custom context for your tools
    customData: { ... },
  },
})) {
  // ...
}
```

## AI Provider Support

The library supports multiple AI providers with automatic failover and provider-specific optimizations.

### Provider Configuration

Providers are injected at runtime (not tied to `process.env`):

```javascript
const agent = createAgent({
  sessionStore,
  providers: {
    anthropic: { apiKey: process.env.ANTHROPIC_API_KEY },
    openai: { apiKey: process.env.OPENAI_API_KEY },
    xai: { apiKey: process.env.XAI_API_KEY },
    ollama: { baseUrl: 'http://localhost:11434' },
  },
});
```

### Anthropic (Claude)

**Configuration:**
```javascript
providers: {
  anthropic: { apiKey: 'sk-ant-...' }
}
```

**Supported Models:**
- `claude-sonnet-4-5` - Latest Sonnet (best balance of speed/quality)
- `claude-opus-4-1` - Most capable Claude model
- `claude-sonnet-4` - Previous Sonnet version
- `claude-sonnet-3-7` - Claude 3.7 Sonnet
- `claude-haiku-3-5` - Fastest Claude model

**Features:**
- Native tool use support
- Thinking mode (exposes reasoning)
- System prompts
- Extended context (200k tokens)

**Example:**
```javascript
for await (const event of agent.chat({
  sessionId: 'sess_123',
  message: 'Analyze this data',
  provider: 'anthropic',
  model: 'claude-sonnet-4-5',
})) {
  console.log(event);
}
```

### OpenAI (GPT)

**Configuration:**
```javascript
providers: {
  openai: { apiKey: 'sk-...' }
}
```

**Supported Models:**
- `gpt-5` - Latest GPT-5 (most capable)
- `gpt-5-mini` - Faster GPT-5 variant
- `gpt-5-nano` - Smallest GPT-5
- `gpt-4-1` - GPT-4.1 (previous generation)
- `gpt-4-1-nano` - Smaller GPT-4.1
- `gpt-4o` - GPT-4 Optimized

**Features:**
- Function calling (tool use)
- JSON mode
- Vision support (gpt-4o)
- Structured outputs

**Example:**
```javascript
for await (const event of agent.chat({
  sessionId: 'sess_123',
  message: 'Write a poem',
  provider: 'openai',
  model: 'gpt-5',
})) {
  console.log(event);
}
```

### xAI (Grok)

**Configuration:**
```javascript
providers: {
  xai: { apiKey: 'xai-...' }
}
```

**Supported Models:**
- `grok-4-1-fast` - Latest Grok with best speed
- `grok-4-fast` - Fast Grok 4
- `grok-4` - Standard Grok 4
- `grok-code-fast` - Optimized for code generation
- `grok-3` - Previous generation
- `grok-2-vision` - Vision-enabled Grok 2

**Features:**
- Real-time web search integration
- Grok Imagine (image generation via `image_generate` tool)
- Code execution
- Fast inference

**Example:**
```javascript
for await (const event of agent.chat({
  sessionId: 'sess_123',
  message: 'Search for latest news on AI',
  provider: 'xai',
  model: 'grok-4-1-fast',
})) {
  console.log(event);
}
```

### Ollama (Local)

**Configuration:**
```javascript
providers: {
  ollama: { baseUrl: 'http://localhost:11434' }
}
```

**Dynamic Model List:**
Ollama models are fetched at runtime from the local instance. Any model pulled via `ollama pull` is available.

**Popular Models:**
- `llama3.3` - Meta's Llama 3.3
- `mistral` - Mistral 7B
- `codellama` - Code-specialized Llama
- `phi3` - Microsoft Phi-3
- `gemma2` - Google Gemma 2

**Features:**
- Local inference (no API costs)
- Privacy (data never leaves your machine)
- Custom models
- Fine-tuned models

**Example:**
```javascript
for await (const event of agent.chat({
  sessionId: 'sess_123',
  message: 'Explain quantum computing',
  provider: 'ollama',
  model: 'llama3.3',
})) {
  console.log(event);
}
```

### Provider Failover

The library includes automatic failover logic. If a provider fails (rate limit, API error, timeout), it will attempt to retry with the same provider or switch to an alternative if configured.

```javascript
// Failover is handled automatically by the agent loop
// You can monitor failover events in the SSE stream
for await (const event of agent.chat({ ... })) {
  if (event.type === 'error' && event.code === 'rate_limit_error') {
    console.log('Rate limited, failover attempted');
  }
}
```

## Frontend Integration

### JavaScript Fetch + SSE Parsing

```javascript
async function chat(sessionId, message, provider = 'anthropic', model = 'claude-sonnet-4-5') {
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, message, provider, model }),
  });

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');

    // Keep incomplete line in buffer
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = JSON.parse(line.slice(6));
        handleEvent(data);
      }
    }
  }
}

function handleEvent(event) {
  switch (event.type) {
    case 'text_delta':
      appendToChat(event.text);
      break;
    case 'tool_start':
      showToolIndicator(event.tool, event.input);
      break;
    case 'tool_result':
      hideToolIndicator(event.toolCallId);
      break;
    case 'done':
      console.log('Complete', event.usage);
      break;
    case 'error':
      showError(event.error);
      break;
  }
}
```

### React Hook Example

```javascript
import { useState, useCallback } from 'react';

function useAgentChat(sessionId) {
  const [messages, setMessages] = useState([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [currentToolCall, setCurrentToolCall] = useState(null);

  const sendMessage = useCallback(async (message, provider = 'anthropic', model = 'claude-sonnet-4-5') => {
    setIsStreaming(true);

    // Add user message
    setMessages(prev => [...prev, { role: 'user', content: message }]);

    let assistantMessage = '';
    let currentMessageIndex = messages.length + 1;

    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, message, provider, model }),
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const event = JSON.parse(line.slice(6));

            if (event.type === 'text_delta') {
              assistantMessage += event.text;
              setMessages(prev => {
                const updated = [...prev];
                if (updated[currentMessageIndex]?.role === 'assistant') {
                  updated[currentMessageIndex].content = assistantMessage;
                } else {
                  updated.push({ role: 'assistant', content: assistantMessage });
                }
                return updated;
              });
            } else if (event.type === 'tool_start') {
              setCurrentToolCall({ tool: event.tool, input: event.input, id: event.toolCallId });
            } else if (event.type === 'tool_result') {
              setCurrentToolCall(null);
            } else if (event.type === 'error') {
              console.error('Agent error:', event.error);
            }
          }
        }
      }
    } finally {
      setIsStreaming(false);
      setCurrentToolCall(null);
    }
  }, [sessionId, messages.length]);

  return { messages, sendMessage, isStreaming, currentToolCall };
}

// Usage in component:
function ChatComponent({ sessionId }) {
  const { messages, sendMessage, isStreaming, currentToolCall } = useAgentChat(sessionId);

  return (
    <div>
      {messages.map((msg, i) => (
        <div key={i} className={msg.role}>
          {msg.content}
        </div>
      ))}
      {currentToolCall && (
        <div className="tool-indicator">
          Running {currentToolCall.tool}...
        </div>
      )}
      <button
        onClick={() => sendMessage('Tell me a joke')}
        disabled={isStreaming}
      >
        Send
      </button>
    </div>
  );
}
```

### Server Route Example (Hono)

```javascript
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { createAgent, MongoSessionStore, coreTools } from '@dottie/agent';

const app = new Hono();

// Initialize agent (once at startup)
const sessionStore = new MongoSessionStore();
await sessionStore.init(db);

const agent = createAgent({
  sessionStore,
  providers: {
    anthropic: { apiKey: process.env.ANTHROPIC_API_KEY },
    openai: { apiKey: process.env.OPENAI_API_KEY },
  },
  tools: coreTools,
});

// Chat endpoint with SSE streaming
app.post('/api/chat', async (c) => {
  const { sessionId, message, provider, model } = await c.req.json();
  const userId = c.get('userId'); // From auth middleware

  return streamSSE(c, async (stream) => {
    try {
      for await (const event of agent.chat({
        sessionId,
        message,
        provider,
        model,
        context: { userID: userId },
      })) {
        await stream.writeSSE({
          data: JSON.stringify(event),
          event: event.type,
        });
      }
    } catch (err) {
      await stream.writeSSE({
        data: JSON.stringify({ type: 'error', error: err.message }),
        event: 'error',
      });
    }
  });
});

// Session management endpoints
app.get('/api/sessions', async (c) => {
  const userId = c.get('userId');
  const sessions = await agent.listSessions(userId);
  return c.json(sessions);
});

app.post('/api/sessions', async (c) => {
  const userId = c.get('userId');
  const { model, provider } = await c.req.json();
  const session = await agent.createSession(userId, model, provider);
  return c.json(session);
});

app.delete('/api/sessions/:id', async (c) => {
  const userId = c.get('userId');
  const sessionId = c.req.param('id');
  await agent.deleteSession(sessionId, userId);
  return c.json({ success: true });
});
```

## Custom SessionStore Example

Implement SessionStore interface for your database:

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
        id UUID PRIMARY KEY,
        owner TEXT NOT NULL,
        title TEXT,
        messages JSONB,
        model TEXT,
        provider TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
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

  // ... implement other SessionStore methods
}
```

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                Your Application                         │
│        (Hono, Express, Fastify, Deno, etc.)             │
└────────────────────────┬────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│                  createAgent()                          │
│  ┌─────────────────────────────────────────────────┐   │
│  │  Agent Loop (agent.js)                          │   │
│  │  • Message streaming (async generator)          │   │
│  │  • Tool execution orchestration                 │   │
│  │  • Provider failover logic                      │   │
│  │  • Thinking mode support                        │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │  Tool Registry                                  │   │
│  │  • 45 core tools (memory, web, files, etc.)    │   │
│  │  • Custom tool registration                     │   │
│  │  • Dynamic execution context                    │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │  SessionStore Interface                         │   │
│  │  • MongoDB adapter (production)                 │   │
│  │  • Memory adapter (dev/testing)                 │   │
│  │  • Custom adapters (PostgreSQL, SQLite, etc.)   │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │  CronStore Interface (optional)                 │   │
│  │  • Scheduled task management                    │   │
│  │  • Recurring heartbeats                         │   │
│  │  • One-shot delayed execution                   │   │
│  └─────────────────────────────────────────────────┘   │
└────────────────────────┬────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│           AI Providers (HTTP/REST)                      │
│  • Anthropic Claude (Messages API)                      │
│  • OpenAI GPT (Chat Completions)                        │
│  • xAI Grok (OpenAI-compatible)                         │
│  • Ollama (Local, OpenAI-compatible)                    │
└─────────────────────────────────────────────────────────┘
```

## Best Practices

### 1. Use Appropriate SessionStore for Your Environment

```javascript
// Development: In-memory store (fast, no persistence)
import { MemorySessionStore } from '@dottie/agent';
const sessionStore = new MemorySessionStore();

// Production: SQLite (single-file, zero dependencies, Node.js 22.5+)
import { SQLiteSessionStore } from '@dottie/agent';
const sessionStore = new SQLiteSessionStore();
await sessionStore.init('./sessions.db');

// Production: MongoDB (scalable, full-text search)
import { MongoSessionStore } from '@dottie/agent';
const sessionStore = new MongoSessionStore();
await sessionStore.init(mongoDb);
```

### 2. Handle Stream Errors Gracefully

```javascript
try {
  for await (const event of agent.chat({ ... })) {
    if (event.type === 'error') {
      // Show user-friendly error message
      showNotification('Something went wrong. Please try again.');
      break;
    }
    handleEvent(event);
  }
} catch (err) {
  // Network error, parse error, etc.
  console.error('Stream error:', err);
  showNotification('Connection lost. Please refresh.');
}
```

### 3. Implement Abort/Cancel Support

```javascript
const abortController = new AbortController();

// Start chat with abort signal
const chatPromise = (async () => {
  for await (const event of agent.chat({
    sessionId,
    message,
    provider,
    model,
    signal: abortController.signal,  // Pass abort signal
  })) {
    handleEvent(event);
  }
})();

// Cancel on user action
cancelButton.onclick = () => {
  abortController.abort();
};
```

### 4. Pass Context for Custom Tools

```javascript
// Context is available to all tool execute() functions
for await (const event of agent.chat({
  sessionId,
  message,
  provider,
  model,
  context: {
    userID: 'user-123',
    databaseManager: dbManager,
    dbConfig: { dbType: 'mongodb', db: 'myapp' },
    // Custom context for your tools:
    currentLocation: { lat: 37.7749, lon: -122.4194 },
    userPreferences: { theme: 'dark', notifications: true },
  },
})) {
  // ...
}
```

### 5. Monitor Token Usage

```javascript
let totalInputTokens = 0;
let totalOutputTokens = 0;

for await (const event of agent.chat({ ... })) {
  if (event.type === 'done') {
    totalInputTokens += event.usage.input_tokens;
    totalOutputTokens += event.usage.output_tokens;
    console.log(`Session usage: ${totalInputTokens} in, ${totalOutputTokens} out`);
  }
}
```

### 6. Use Compaction for Long Conversations

```javascript
const agent = createAgent({
  sessionStore,
  providers,
  compaction: {
    enabled: true,
    threshold: 50,      // Compact after 50 messages
    targetLength: 20,   // Keep most recent 20 messages + summary
  },
});
```

### 7. Register Custom Tools Cleanly

```javascript
import { coreTools } from '@dottie/agent';

// Define your custom tools
const myTools = [
  {
    name: 'get_weather',
    description: 'Get current weather',
    parameters: {
      type: 'object',
      properties: {
        location: { type: 'string' }
      },
      required: ['location']
    },
    execute: async ({ location }, signal, context) => {
      const apiKey = context.weatherApiKey;
      const response = await fetch(`https://api.weather.com/${location}?key=${apiKey}`);
      return await response.json();
    }
  }
];

// Combine with core tools
const agent = createAgent({
  sessionStore,
  providers,
  tools: [...coreTools, ...myTools],
});
```

### 8. Use Scheduled Tasks for Recurring Actions

```javascript
const cronStore = new MongoCronStore();
await cronStore.init(db, {
  onTaskFire: async (task) => {
    console.log(`[cron] Running task: ${task.name}`);

    // Execute agent with task prompt
    if (agent) {
      for await (const event of agent.chat({
        sessionId: task.sessionId,
        message: task.prompt,
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
      })) {
        // Process events...
      }
    }
  }
});

// Create recurring task
await cronStore.createTask({
  name: 'daily-summary',
  prompt: 'Generate a daily summary of user activity',
  sessionId: 'sess_123',
  userId: 'user-456',
  runAt: new Date(Date.now() + 3600000),  // 1 hour from now
  intervalMs: 86400000,  // 24 hours
  recurring: true,
});
```

## Troubleshooting

### "sessionStore is not defined"

Make sure you're initializing the SessionStore before passing it to `createAgent()`:

```javascript
const sessionStore = new MongoSessionStore();
await sessionStore.init(db);  // Don't forget to await!

const agent = createAgent({ sessionStore, ... });
```

### "Provider not configured"

Ensure the provider is included in the `providers` object:

```javascript
const agent = createAgent({
  sessionStore,
  providers: {
    anthropic: { apiKey: process.env.ANTHROPIC_API_KEY },
    // Add all providers you plan to use
  },
});
```

### "Tool execution failed"

Check that tools have access to required context:

```javascript
for await (const event of agent.chat({
  sessionId,
  message,
  provider,
  model,
  context: {
    userID: 'user-123',  // Required by many tools
    databaseManager: dbManager,  // Required by memory tools
    dbConfig: { ... },  // Required by memory tools
  },
})) {
  // ...
}
```

### SSE Stream Stops Prematurely

Make sure your HTTP server supports streaming responses:

```javascript
// Hono: Use streamSSE()
return streamSSE(c, async (stream) => { ... });

// Express: Set headers correctly
res.setHeader('Content-Type', 'text/event-stream');
res.setHeader('Cache-Control', 'no-cache');
res.setHeader('Connection', 'keep-alive');
```

## Examples

Full working examples are available in the [dottie-os repository](https://github.com/stevederico/dottie-os):

- **Production Integration**: [`backend/server.js`](../../server.js) - Complete Hono server with agent system
- **Frontend Client**: [`src/hooks/useAgentChat.js`](../../../src/hooks/useAgentChat.js) - React hook for SSE streaming
- **Custom Tools**: [`backend/agent/os-tools.js`](../../agent/os-tools.js) - 57 OS-specific tools
- **MongoDB Store**: [`backend/lib/agent/storage/MongoAdapter.js`](./storage/MongoAdapter.js) - Full SessionStore implementation

## License

MIT

## Contributing

This library is extracted from [dottie-os](https://github.com/stevederico/dottie-os) and designed to be reusable across platforms.

Pull requests welcome! Please:
1. Add tests for new features
2. Update documentation
3. Follow existing code style
4. Ensure all tests pass

## Support

- **Issues**: https://github.com/stevederico/dottie-os/issues
- **Documentation**: https://github.com/stevederico/dottie-os/tree/master/backend/lib/agent
- **Dottie OS**: https://github.com/stevederico/dottie-os

<div align="center">
  <img src="https://media4.giphy.com/media/v1.Y2lkPTc5MGI3NjExaGNjeWoweGx4bGYxZXNvYmtsYW80MjlxODFmeTN0cHE3cHN6emFoNiZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/gYWeVOiMmbg3kzCTq5/giphy.gif" alt="dotbot" width="200">
  <h1 align="center" style="border-bottom: none; margin-bottom: 0;">dotbot</h1>
  <h3 align="center" style="margin-top: 0; font-weight: normal;">
    The ultra-lean AI agent.<br>
    11k lines. 53 tools. 0 dependencies.
  </h3>
</div>

<br />

## Why dotbot?

**90% smaller than [OpenClaw](https://github.com/openclaw/openclaw). Half the size of [nanobot](https://github.com/HKUDS/nanobot). 4x the tools.**

| | dotbot | nanobot | OpenClaw |
|---|:---:|:---:|:---:|
| **Lines of Code** | **~11k** | 22k | 1M+ |
| **Tools** | **53** | ~10 | ~50 |
| **Dependencies** | **0** | Heavy | Heavy |
| **Sandbox Mode** | **Built-in** | No | Requires NemoClaw |

Everything you need for AI agents. Nothing you don't. No bloated abstractions. No dependency hell. Just a clean, focused agent that works.

<br />

## What is dotbot?

A **streaming AI agent** with tool execution, autonomous tasks, and scheduled jobs. Use it as a CLI or as a library.

**As a CLI:**
```bash
dotbot "What's the weather in San Francisco?"
dotbot                  # Interactive mode
dotbot --sandbox        # Sandbox mode (restricted tools)
dotbot serve --port 3000
dotbot models           # List available models
dotbot tools            # List all 53 tools
```

**As a library:**
```javascript
import { createAgent, SQLiteSessionStore, coreTools } from '@stevederico/dotbot';
```

<br />

## Quick Start

### CLI Usage

```bash
# Install globally
npm install -g @stevederico/dotbot

# Set your API key
export XAI_API_KEY=xai-...

# Chat
dotbot "Summarize the top 3 AI news stories today"

# Interactive mode
dotbot

# Start HTTP server
dotbot serve --port 3000

# Inspect data
dotbot tools
dotbot stats
dotbot memory
```

### Sandbox Mode

Run dotbot with restricted tool access — deny-by-default.

```bash
# Full lockdown — safe tools only (memory, search, weather, tasks)
dotbot --sandbox "What is 2+2?"

# Allow specific domains for web_fetch and browser_navigate
dotbot --sandbox --allow github
dotbot --sandbox --allow github --allow slack

# Allow specific tool groups
dotbot --sandbox --allow messages
dotbot --sandbox --allow images

# Mix domains and tool groups
dotbot --sandbox --allow github --allow messages --allow npm

# Custom domain
dotbot --sandbox --allow api.mycompany.com

# Persistent config in ~/.dotbotrc
# { "sandbox": true, "sandboxAllow": ["github", "slack", "messages"] }
```

**What's blocked by default:**

| Category | Tools | How to unlock |
|----------|-------|---------------|
| Filesystem writes | `file_write`, `file_delete`, `file_move`, `folder_create` | Cannot unlock |
| Arbitrary HTTP | `web_fetch` | `--allow <domain>` |
| Browser | `browser_navigate` | `--allow <domain>` |
| Code execution | `run_code` | Always allowed (Node.js permission model) |
| Messaging | `message_*` | `--allow messages` |
| Images | `image_*` | `--allow images` |
| Notifications | `notify_user` | `--allow notifications` |
| App generation | `app_generate`, `app_validate` | Cannot unlock |

**What's always allowed:** `memory_*`, `web_search`, `grokipedia_search`, `file_read`, `file_list`, `weather_get`, `event_*`, `task_*`, `trigger_*`, `schedule_job`, `list_jobs`, `toggle_job`, `cancel_job`

**Domain presets:** `github`, `slack`, `discord`, `npm`, `pypi`, `jira`, `huggingface`, `docker`, `telegram`

### Library Usage

```bash
npm install @stevederico/dotbot
```

```javascript
import { createAgent, SQLiteSessionStore, coreTools } from '@stevederico/dotbot';

const sessionStore = new SQLiteSessionStore();
await sessionStore.init('./sessions.db');

const agent = createAgent({
  sessionStore,
  providers: {
    xai: { apiKey: process.env.XAI_API_KEY },
  },
  tools: coreTools,
});

const session = await agent.createSession('user123');

for await (const event of agent.chat({
  sessionId: session.id,
  message: 'Search for the latest AI news',
  provider: 'xai',
  model: 'grok-4-1-fast-reasoning',
})) {
  if (event.type === 'text_delta') process.stdout.write(event.text);
}
```

<br />

## What's Included

### 🤖 **Streaming Agent Loop**
- **Async generator** yields typed SSE events
- **Multi-turn** conversations with tool execution
- **Abort support** via AbortSignal
- **Automatic retries** with provider failover

### 🔧 **53 Built-in Tools**
- **Memory** — save, search, update, delete long-term memory
- **Web** — search, fetch, browser automation with Playwright
- **Files** — read, write, list, delete, move files
- **Images** — generate images via xAI Grok
- **Tasks** — multi-step autonomous workflows
- **Jobs** — scheduled prompts with cron-like intervals
- **Triggers** — event-driven agent responses
- **Weather** — Open-Meteo API (no key required)

### 🔌 **Multi-Provider Support**
- **xAI Grok** — grok-4-1-fast-reasoning, with real-time web search and image generation
- **Anthropic Claude** — claude-sonnet-4-5, claude-opus-4, etc.
- **OpenAI** — gpt-4o, gpt-4-turbo, etc.
- **Cerebras** — ultra-fast inference
- **Ollama** — local models, no API cost

### 🔒 **Sandbox Mode**
- **Deny-by-default** tool access — no files, code, browser, or messaging
- **Domain allowlists** — `--allow github`, `--allow slack`
- **Preset-based** tool unlocking — `--allow messages`, `--allow images`

### 💾 **Pluggable Storage**
- **SQLite** — zero dependencies with Node.js 22.5+
- **Memory** — in-memory for testing

### 📊 **Full Audit Trail**
- **Every message** logged with full content
- **Every tool call** logged with input/output
- **Event store** for analytics and debugging

<br />

## CLI Reference

```
dotbot — AI agent CLI

Usage:
  dotbot "message"            One-shot query
  dotbot                      Interactive chat
  dotbot serve [--port N]     Start HTTP server (default: 3000)
  dotbot serve --openai       Start OpenAI-compatible API server
  echo "msg" | dotbot         Pipe input from stdin

Commands:
  models                      List available models from provider
  doctor                      Check environment and configuration
  tools                       List all available tools
  stats                       Show database statistics
  memory [list|search <q>]    Manage saved memories
  memory delete <key>         Delete a memory by key
  jobs                        List scheduled jobs
  jobs delete <id>            Delete a scheduled job
  tasks                       List active tasks
  tasks delete <id>           Delete a task
  sessions                    List chat sessions
  sessions delete <id>        Delete a session
  events [--summary]          View audit log

Options:
  --provider, -p   AI provider: xai, anthropic, openai, ollama, local (default: xai)
  --model, -m      Model name (default: grok-4-1-fast-reasoning)
  --system, -s     Custom system prompt (prepended to default)
  --session        Resume a specific session by ID
  --sandbox        Restrict tools to safe subset (deny-by-default)
  --allow          Allow domain/preset in sandbox (github, slack, messages, etc.)
  --db             SQLite database path (default: ./dotbot.db)
  --port           Server port for 'serve' command
  --openai         Enable OpenAI-compatible API endpoints
  --json           Output as JSON (for inspection commands)
  --verbose        Show initialization logs
  --help, -h       Show help
  --version, -v    Show version

Environment Variables:
  XAI_API_KEY          API key for xAI
  ANTHROPIC_API_KEY    API key for Anthropic
  OPENAI_API_KEY       API key for OpenAI
  OLLAMA_BASE_URL      Base URL for Ollama (default: http://localhost:11434)
  LOCAL_LLM_URL        Base URL for a local OpenAI-compatible LLM server (default: http://127.0.0.1:1316/v1)

Config File:
  ~/.dotbotrc          JSON config for defaults (provider, model, db, sandbox)
```

<br />

## Library API

### `createAgent(options)`

```javascript
const agent = createAgent({
  sessionStore,              // required — SessionStore instance
  providers: {
    xai: { apiKey },         // API keys for each provider
    anthropic: { apiKey },
    openai: { apiKey },
    ollama: { baseUrl },
  },
  tools: coreTools,          // array of tool definitions
  cronStore,                 // optional — for scheduled jobs
  taskStore,                 // optional — for autonomous tasks
  triggerStore,              // optional — for event triggers
  memoryStore,               // optional — for long-term memory
  eventStore,                // optional — for audit logging
});
```

### `agent.chat(options)`

Streams a response as an async generator:

```javascript
for await (const event of agent.chat({
  sessionId: 'sess_123',
  message: 'Hello',
  provider: 'xai',
  model: 'grok-4-1-fast-reasoning',
  signal: abortController.signal,  // optional
  context: { userID: 'user123' },  // passed to tools
})) {
  switch (event.type) {
    case 'text_delta':  console.log(event.text); break;
    case 'tool_start':  console.log(`[${event.name}]`); break;
    case 'tool_result': console.log(event.result); break;
    case 'done':        console.log('Complete'); break;
  }
}
```

### SSE Event Types

| Event | Fields | Description |
|-------|--------|-------------|
| `text_delta` | `text` | Incremental text from model |
| `thinking` | `text` | Model reasoning (Claude) |
| `tool_start` | `name`, `input` | Tool execution begins |
| `tool_result` | `name`, `result` | Tool completed |
| `tool_error` | `name`, `error` | Tool failed |
| `done` | `content` | Agent loop complete |
| `stats` | `inputTokens`, `outputTokens` | Token usage |

<br />

## Built-in Tools (53)

| Category | Tools |
|----------|-------|
| **Memory** (6) | `memory_save`, `memory_search`, `memory_delete`, `memory_list`, `memory_read`, `memory_update` |
| **Web** (3) | `web_search`, `web_fetch`, `grokipedia_search` |
| **Browser** (7) | `browser_navigate`, `browser_read_page`, `browser_click`, `browser_type`, `browser_screenshot`, `browser_extract`, `browser_close` |
| **Files** (6) | `file_read`, `file_write`, `file_list`, `file_delete`, `file_move`, `folder_create` |
| **Images** (3) | `image_generate`, `image_list`, `image_search` |
| **Tasks** (9) | `task_create`, `task_list`, `task_plan`, `task_work`, `task_step_done`, `task_complete`, `task_delete`, `task_search`, `task_stats` |
| **Triggers** (4) | `trigger_create`, `trigger_list`, `trigger_toggle`, `trigger_delete` |
| **Jobs** (4) | `schedule_job`, `list_jobs`, `cancel_job`, `toggle_job` |
| **Messages** (4) | `message_list`, `message_send`, `message_read`, `message_delete` |
| **Code** (1) | `run_code` |
| **Weather** (1) | `weather_get` |
| **Notify** (1) | `notify_user` |
| **App Gen** (2) | `app_generate`, `app_validate` |

<br />

## Task System

Tasks enable multi-step autonomous workflows. In `auto` mode, the agent executes steps sequentially without user intervention.

```javascript
// Agent creates and executes a task
await agent.chat({
  sessionId,
  message: `Create a task to audit our API endpoints.
            Break it into 5 steps, use auto mode.`,
  provider: 'xai',
  model: 'grok-4-1-fast-reasoning',
  context: { userID: 'user-123' },
});
// Step 1 runs → schedules Step 2 → ... → task complete
```

**Requires:** `taskStore` and `cronStore` passed to `createAgent()`.

<br />

## Scheduled Jobs

Jobs are cron-like scheduled prompts that fire automatically.

```javascript
// Agent schedules a daily job
await agent.chat({
  sessionId,
  message: 'Schedule a daily job at 9am to check my calendar and summarize my day',
  ...
});
```

**Requires:** `cronStore` passed to `createAgent()`.

<br />

## Tech Stack

| Technology | Purpose |
|------------|---------|
| **Node.js 22.5+** | Runtime with built-in SQLite |
| **Chrome DevTools Protocol** | Browser automation (zero deps) |
| **SQLite** | Default storage (zero deps) |

<br />

## Package Structure

```
dotbot/
├── bin/
│   └── dotbot.js           # CLI entry point (REPL, server, sandbox mode)
├── core/
│   ├── agent.js            # Streaming agent loop
│   ├── events.js           # SSE event schemas
│   ├── compaction.js       # Context window management
│   ├── normalize.js        # Message format conversion
│   ├── failover.js         # Cross-provider failover
│   ├── cron_handler.js     # Scheduled job execution
│   └── trigger_handler.js  # Event-driven triggers
├── storage/
│   ├── SessionStore.js     # Session interface
│   ├── TaskStore.js        # Task interface
│   ├── CronStore.js        # Job scheduling interface
│   ├── TriggerStore.js     # Trigger interface
│   └── SQLite*.js          # SQLite adapters
├── tools/                  # 53 built-in tools
│   ├── memory.js
│   ├── web.js
│   ├── browser.js
│   ├── tasks.js
│   ├── jobs.js
│   └── ...
└── utils/
    └── providers.js        # AI provider configs
```

<br />

## Requirements

- **Node.js 22.5+** with `--experimental-sqlite` flag, or **Node.js 23+**
- API key for at least one provider (Anthropic, OpenAI, xAI) or local Ollama

<br />

## Contributing

```bash
git clone https://github.com/stevederico/dotbot
cd dotbot
node bin/dotbot.js --help
```

<br />

## Community & Support

- **X**: [@stevederico](https://x.com/stevederico)
- **Issues**: [GitHub Issues](https://github.com/stevederico/dotbot/issues)

<br />

## Related Projects

- [dottie-desktop](https://github.com/stevederico/dottie-desktop) — macOS AI assistant powered by dotbot
- [skateboard](https://github.com/stevederico/skateboard) — React starter with auth, Stripe, and SQLite

<br />

## License

MIT License — use it however you want. See [LICENSE](LICENSE) for details.

<br />

---

<div align="center">
  <p>
    Built with care by <a href="https://github.com/stevederico">Steve Derico</a>
  </p>
  <p>
    <a href="https://github.com/stevederico/dotbot">Star on GitHub</a> — it helps!
  </p>
</div>

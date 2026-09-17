<div align="center">
  <img src="https://media4.giphy.com/media/v1.Y2lkPTc5MGI3NjExaGNjeWoweGx4bGYxZXNvYmtsYW80MjlxODFmeTN0cHE3cHN6emFoNiZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/gYWeVOiMmbg3kzCTq5/giphy.gif" alt="dotbot" width="200">
  <h1 align="center" style="border-bottom: none; margin-bottom: 0;">dotbot</h1>
  <h3 align="center" style="margin-top: 0; font-weight: normal;">
    The ultra-lean agent harness.<br>
    ~11k lines. 53 tools. 0 dependencies.
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

A **streaming agent harness** — tool loop, memory, jobs, sandbox — not an inference engine. The model lives elsewhere (xAI, Anthropic, OpenAI, Ollama, or a local OpenAI-compatible server such as [dottie-local](https://github.com/stevederico/dottie-local) / llama.cpp).

**Surfaces:**

| Surface | Command |
|---------|---------|
| One-shot / REPL | `dotbot "…"`, `dotbot` |
| Full-screen TUI | `dotbot tui` |
| HTTP | `dotbot serve` (+ `--openai`) |
| Library | `import { createAgent } from '@stevederico/dotbot'` |

```bash
dotbot "What's the weather in San Francisco?"
dotbot                  # Interactive REPL
dotbot tui              # Full-screen TUI (alt-screen, zero deps)
dotbot --sandbox        # Restricted tools
dotbot serve --port 3000
dotbot models
dotbot tools
```

```javascript
import { createAgent, SQLiteSessionStore, coreTools } from '@stevederico/dotbot';
```

<br />

## Quick Start

### CLI

```bash
npm install -g @stevederico/dotbot

export XAI_API_KEY=xai-...

dotbot "Summarize the top 3 AI news stories today"
dotbot
dotbot tui
dotbot serve --port 3000
dotbot tools
dotbot stats
dotbot memory
```

### TUI

Zero-dependency full-screen chat (ANSI alt-screen + raw stdin). Same providers, tools, sandbox, and sessions as the CLI.

```bash
dotbot tui
dotbot tui -p local -m local          # local OpenAI-compatible server
dotbot tui --sandbox --allow github
dotbot tui --session <session-id>
```

| Input | Action |
|-------|--------|
| Enter | Send message |
| `/help` | Commands |
| `/clear` | Clear conversation |
| `/show` | Provider / model / session |
| `/load <model>` | Switch model |
| `/bye` | Quit |
| PgUp / PgDn | Scroll history |
| Ctrl+C | Quit |

Requires a TTY (`dotbot tui` inside a real terminal).

### Sandbox Mode

Deny-by-default tool access.

```bash
dotbot --sandbox "What is 2+2?"
dotbot --sandbox --allow github
dotbot --sandbox --allow github --allow slack
dotbot --sandbox --allow messages
dotbot --sandbox --allow images
dotbot --sandbox --allow github --allow messages --allow npm
dotbot --sandbox --allow api.mycompany.com

# ~/.dotbotrc
# { "sandbox": true, "sandboxAllow": ["github", "slack", "messages"] }
```

**Blocked by default:**

| Category | Tools | Unlock |
|----------|-------|--------|
| Filesystem writes | `dot_file_write`, `dot_file_delete`, `dot_file_move`, `dot_folder_create` | Cannot unlock |
| Arbitrary HTTP | `dot_web_fetch` | `--allow <domain>` |
| Browser | `dot_browser_navigate` | `--allow <domain>` |
| Code execution | `dot_run_code` | Always allowed (Node.js permission model) |
| Messaging | `dot_message_*` | `--allow messages` |
| Images | `dot_image_*` | `--allow images` |
| Notifications | `dot_notify_user` | `--allow notifications` |
| App generation | `dot_app_generate`, `dot_app_validate` | Cannot unlock |

**Always allowed:** `dot_memory_*`, `dot_web_search`, `dot_grokipedia_search`, `dot_file_read`, `dot_file_list`, `dot_weather_get`, `dot_event_*`, `dot_task_*`, `dot_trigger_*`, `dot_schedule_job`, `dot_list_jobs`, `dot_toggle_job`, `dot_cancel_job`

**Domain presets:** `github`, `slack`, `discord`, `npm`, `pypi`, `jira`, `huggingface`, `docker`, `telegram`

Tool names use a `dot_` prefix so they do not clash with provider built-ins (e.g. Grok's `web_search`).

### Library

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

### Streaming Agent Loop
- Async generator yields typed events
- Multi-turn tool execution
- AbortSignal support
- Provider failover

### 53 Built-in Tools (`dot_*`)
- **Memory** — durable save / search / update
- **Web** — search, fetch
- **Browser** — Chrome DevTools Protocol (no Playwright dep)
- **Files** — read / write / list / delete / move
- **Images** — generate via xAI Grok
- **Tasks** — multi-step autonomous workflows
- **Jobs** — scheduled prompts
- **Triggers** — event-driven wake-ups
- **Weather** — Open-Meteo (no key)

### Surfaces
- **CLI** — one-shot, REPL, inspect commands
- **TUI** — full-screen chat, zero deps
- **HTTP** — `serve` and optional OpenAI-compatible API
- **Library** — embed in Node apps

### Multi-Provider
- **xAI Grok** — default
- **Anthropic Claude**
- **OpenAI**
- **Cerebras**
- **Ollama** / **local** — OpenAI-compatible local servers

### Sandbox, Storage, Audit
- Deny-by-default sandbox + domain presets
- SQLite (Node built-in) or in-memory stores
- Full message and tool-call audit trail

<br />

## CLI Reference

```
dotbot — AI agent CLI

Usage:
  dotbot "message"            One-shot query
  dotbot                      Interactive REPL
  dotbot tui                  Full-screen TUI chat
  dotbot serve [--port N]     Start HTTP server (default: 3000)
  dotbot serve --openai       Start OpenAI-compatible API server
  echo "msg" | dotbot         Pipe input from stdin

Commands:
  tui                         Full-screen terminal UI
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
    xai: { apiKey },
    anthropic: { apiKey },
    openai: { apiKey },
    ollama: { baseUrl },
  },
  tools: coreTools,
  cronStore,
  taskStore,
  triggerStore,
  memoryStore,
  eventStore,
});
```

### `agent.chat(options)`

```javascript
for await (const event of agent.chat({
  sessionId: 'sess_123',
  message: 'Hello',
  provider: 'xai',
  model: 'grok-4-1-fast-reasoning',
  signal: abortController.signal,
  context: { userID: 'user123' },
})) {
  switch (event.type) {
    case 'text_delta':  console.log(event.text); break;
    case 'tool_start':  console.log(`[${event.name}]`); break;
    case 'tool_result': console.log(event.result); break;
    case 'done':        console.log('Complete'); break;
  }
}
```

### Event Types

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

All names are `dot_*` to avoid colliding with provider built-in tools.

| Category | Tools |
|----------|-------|
| **Memory** (6) | `dot_memory_save`, `dot_memory_search`, `dot_memory_delete`, `dot_memory_list`, `dot_memory_read`, `dot_memory_update` |
| **Web** (3) | `dot_web_search`, `dot_web_fetch`, `dot_grokipedia_search` |
| **Browser** (7) | `dot_browser_navigate`, `dot_browser_read_page`, `dot_browser_click`, `dot_browser_type`, `dot_browser_screenshot`, `dot_browser_extract`, `dot_browser_close` |
| **Files** (6) | `dot_file_read`, `dot_file_write`, `dot_file_list`, `dot_file_delete`, `dot_file_move`, `dot_folder_create` |
| **Images** (3) | `dot_image_generate`, `dot_image_list`, `dot_image_search` |
| **Tasks** (9) | `dot_task_create`, `dot_task_list`, `dot_task_plan`, `dot_task_work`, `dot_task_step_done`, `dot_task_complete`, `dot_task_delete`, `dot_task_search`, `dot_task_stats` |
| **Triggers** (4) | `dot_trigger_create`, `dot_trigger_list`, `dot_trigger_toggle`, `dot_trigger_delete` |
| **Jobs** (4) | `dot_schedule_job`, `dot_list_jobs`, `dot_cancel_job`, `dot_toggle_job` |
| **Messages** (4) | `dot_message_list`, `dot_message_send`, `dot_message_read`, `dot_message_delete` |
| **Code** (1) | `dot_run_code` |
| **Weather** (1) | `dot_weather_get` |
| **Notify** (1) | `dot_notify_user` |
| **App Gen** (2) | `dot_app_generate`, `dot_app_validate` |

<br />

## Task System

Tasks enable multi-step autonomous workflows. In `auto` mode, the agent executes steps sequentially without user intervention.

```javascript
await agent.chat({
  sessionId,
  message: `Create a task to audit our API endpoints.
            Break it into 5 steps, use auto mode.`,
  provider: 'xai',
  model: 'grok-4-1-fast-reasoning',
  context: { userID: 'user-123' },
});
```

**Requires:** `taskStore` and `cronStore` passed to `createAgent()`.

<br />

## Scheduled Jobs

Jobs are cron-like scheduled prompts that fire automatically.

```javascript
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
| **TypeScript** | Strict NodeNext ESM → `dist/` (zero runtime deps) |
| **Node.js 22.5+** | Runtime with built-in SQLite |
| **Chrome DevTools Protocol** | Browser automation (zero deps) |
| **ANSI + raw stdin** | Full-screen TUI (zero deps) |
| **SQLite** | Default storage (zero deps) |

<br />

## Package Structure

```
dotbot/
├── types.ts                # Shared types
├── bin/
│   ├── dotbot.ts           # CLI (REPL, serve, sandbox, commands)
│   └── tui.ts              # Full-screen TUI
├── core/
│   ├── agent.ts            # Streaming agent loop
│   ├── events.ts           # Event schemas
│   ├── compaction.ts       # Context window management
│   ├── normalize.ts        # Message format conversion
│   ├── failover.ts         # Cross-provider failover
│   ├── cron_handler.ts     # Scheduled job execution
│   └── trigger_handler.ts  # Event-driven triggers
├── storage/                # Session / task / cron / trigger / SQLite
├── tools/                  # 53 built-in tools (dot_*)
├── utils/
│   └── providers.ts
└── dist/                   # Published artifact
```

<br />

## Requirements

- **Node.js 22.5+** (built-in SQLite) or **Node.js 23+**
- API key for at least one cloud provider, **or** a local OpenAI-compatible server (`--provider local` / Ollama)

<br />

## Contributing

```bash
git clone https://github.com/stevederico/dotbot
cd dotbot
npm install
npm run build
npm test
node dist/bin/dotbot.js --help
node dist/bin/dotbot.js tui
```

<br />

## Community & Support

- **X**: [@stevederico](https://x.com/stevederico)
- **Issues**: [GitHub Issues](https://github.com/stevederico/dotbot/issues)

<br />

## Related Projects

- [dottie-local](https://github.com/stevederico/dottie-local) — local llama.cpp + optional dotbot harness (HTTP / MCP / CLI; replaces local-ai-cli `ask`)
- [dottie-talk](https://github.com/stevederico/dottie-talk) — local STT / TTS
- [dottie-desktop](https://github.com/stevederico/dottie-desktop) — macOS AI assistant
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

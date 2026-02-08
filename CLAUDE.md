# CLAUDE.md

Project guidance for AI agents working on the dotBot codebase.

## Development Commands

```bash
npm run start          # Start frontend + backend concurrently
npm run front          # Vite dev server on :5173
npm run server         # Hono backend on :8000
npm run build          # Production build
npm run install-all    # Install root + backend workspace deps
```

**Ports:** Frontend `:5173` | Backend `:8000` | Ollama `:11434`

## Architecture

### Data Flow

```
User message → POST /api/agent/chat (SSE) → Agent Loop → Ollama /api/chat → Tools → Loop → SSE back
```

### Key Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Streaming | SSE (not WebSocket) | Simpler, POST-based, no connection state |
| LLM | Ollama native `/api/chat` | Local inference, no API keys, model switching |
| Agent state | MongoDB | Persistent sessions, memories, cron across restarts |
| File I/O | Sandboxed to `~/.dotbot` | Security — agent can't escape sandbox |
| Frontend shell | skateboard-ui | Auth, routing, layout, payments out of the box |

### Project Structure

```
dotbot/
├── src/
│   ├── main.jsx                  # Route config, custom Layout override
│   ├── constants.json            # App name, pages, pricing config
│   ├── assets/styles.css         # Tailwind theme override
│   └── components/
│       ├── ChatView.jsx          # Agent chat UI with SSE streaming
│       ├── ChatSidebar.jsx       # Conversation history sidebar
│       └── Layout.jsx            # Custom layout (swaps in ChatSidebar)
├── backend/
│   ├── server.js                 # Hono server, auth, payments, agent mount
│   ├── config.json               # DB type/connection config
│   ├── adapters/
│   │   ├── manager.js            # Database factory (selects provider)
│   │   ├── mongodb.js            # MongoDB adapter
│   │   ├── sqlite.js             # SQLite adapter
│   │   └── postgres.js           # PostgreSQL adapter
│   └── agent/
│       ├── agent.js              # Agent loop — async generator, Ollama calls
│       ├── tools.js              # Tool registry (all 10 tools)
│       ├── routes.js             # SSE endpoint, session CRUD, Hono routes
│       ├── session.js            # Multi-session store, migration, message trimming
│       ├── memory.js             # Long-term memory (MongoDB text search)
│       └── cron.js               # Scheduled tasks (30s poll loop)
├── docs/                         # ARCHITECTURE, API, SCHEMA, DEPLOY, MIGRATION
├── vite.config.js                # Vite 7.1 + Tailwind v4
├── Dockerfile                    # Production container
└── package.json                  # Monorepo with backend workspace
```

## Agent System

### Agent Loop (`backend/agent/agent.js`)

Async generator that calls Ollama and executes tools in a loop.

1. POST to `http://localhost:11434/api/chat` with messages + tool definitions, `stream: true`
2. Stream NDJSON response — accumulate text, collect tool_calls
3. If tool_calls present: execute each tool, push results as `role: "tool"` messages, loop
4. If no tool_calls: yield `done` event with final content, exit
5. **Max 10 iterations** (safety limit)

### Tools

| Tool | Module | Description |
|------|--------|-------------|
| `memory_save` | memory.js | Save facts/preferences to long-term memory |
| `memory_search` | memory.js | Full-text search over saved memories (top 5) |
| `schedule_task` | cron.js | Schedule one-shot or recurring tasks |
| `list_tasks` | cron.js | List all scheduled tasks |
| `cancel_task` | cron.js | Delete a scheduled task by ID |
| `web_search` | tools.js | Brave Search API (requires `BRAVE_API_KEY`) |
| `web_fetch` | tools.js | Fetch + parse URL content (8000 char limit) |
| `file_read` | tools.js | Read file from `~/.dotbot` directory |
| `file_write` | tools.js | Write file to `~/.dotbot` directory |
| `run_code` | tools.js | Execute JavaScript in subprocess (10s timeout) |

### Adding a New Tool

1. Define the tool in `backend/agent/tools.js`:
```javascript
{
  name: "my_tool",
  description: "What this tool does",
  parameters: {
    type: "object",
    properties: {
      param1: { type: "string", description: "..." }
    },
    required: ["param1"]
  },
  execute: async ({ param1 }) => {
    // Tool logic here
    return "result string";
  }
}
```
2. Push it into the `tools` array in the same file
3. The agent loop auto-discovers tools from the registry
4. Restart the server — Ollama receives updated tool definitions on next chat

### Sessions (`sessions` collection)

- Multi-session: each user can have many conversations
- Keyed by UUID (`id`), with `owner` field for user ID
- `title` auto-populated from first user message (60 char max)
- Default model: `gpt-oss:20b`
- Message trimming: keeps system prompt + last 39 messages (40 total)
- System prompt refreshes on every request (updates timestamp)
- Legacy migration: old single-session docs get `owner = id`, new UUID for `id`

### Memory (`memories` collection)

- MongoDB text index on `content` + `tags`
- `memory_save` inserts with optional tags array
- `memory_search` returns top 5 by relevance score

### Cron (`cron_tasks` collection)

- 30-second poll loop checks for `nextRunAt <= now && enabled: true`
- Fires by injecting `[Heartbeat] {prompt}` into the session
- One-shot tasks: set `enabled: false` after fire
- Recurring tasks: update `nextRunAt = now + intervalMs`
- Interval parsing: `"30m"`, `"2h"`, `"1d"`, `"1w"`

## API Routes

### Standard Routes

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check |
| POST | `/api/signup` | Create user |
| POST | `/api/signin` | Sign in |
| POST | `/api/signout` | Sign out |
| GET | `/api/me` | Current user profile |
| PUT | `/api/me` | Update user (name) |
| POST | `/api/usage` | Check/track usage |
| POST | `/api/checkout` | Stripe checkout session |
| POST | `/api/portal` | Stripe billing portal |
| POST | `/api/payment` | Stripe webhook |

### Agent Routes (mounted if MongoDB available)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/agent/sessions` | List user's sessions |
| POST | `/api/agent/sessions` | Create new session |
| DELETE | `/api/agent/sessions/:id` | Delete session (ownership verified) |
| GET | `/api/agent/status` | Ollama connection + available models |
| GET | `/api/agent/history` | Conversation messages (`?sessionId=`) |
| GET | `/api/agent/tools` | List registered tools |
| POST | `/api/agent/chat` | Send message, returns SSE stream (`{ message, sessionId }`) |
| POST | `/api/agent/clear` | Clear conversation history (`{ sessionId }`) |
| POST | `/api/agent/model` | Set Ollama model for session (`{ sessionId, model }`) |

## SSE Event Types

| Event | Payload | Description |
|-------|---------|-------------|
| `text_delta` | `{ text }` | Incremental text token from model |
| `tool_start` | `{ name, input }` | Tool execution started |
| `tool_result` | `{ name, result }` | Tool completed successfully |
| `tool_error` | `{ name, error }` | Tool execution failed |
| `stats` | `{ model, eval_count, eval_duration, total_duration }` | Ollama performance stats |
| `done` | `{ content }` | Final answer, loop complete |
| `error` | `{ error }` | Fatal error |

## MongoDB Collections

| Collection | Key Indexes | Purpose |
|------------|-------------|---------|
| `Users` | `email: 1 (unique)` | User accounts |
| `Auths` | — | Email/password credentials |
| `WebhookEvents` | — | Stripe webhook dedup |
| `sessions` | `id: 1 (unique)`, `owner: 1, updatedAt: -1` | Multi-session conversation history |
| `memories` | `content: "text", tags: "text"` | Long-term agent memory |
| `cron_tasks` | `nextRunAt: 1`, `sessionId: 1` | Scheduled tasks |

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `JWT_SECRET` | Yes | — | Token signing key |
| `STRIPE_KEY` | Yes | — | Stripe secret key |
| `STRIPE_ENDPOINT_SECRET` | Yes | — | Stripe webhook signing |
| `MONGODB_URL` | Yes | — | MongoDB connection string |
| `BRAVE_API_KEY` | No | — | Brave Search API (for `web_search` tool) |
| `FREE_USAGE_LIMIT` | No | `20` | Monthly free-tier usage cap |
| `CORS_ORIGINS` | No | `localhost:5173,8000` | Allowed origins (production) |
| `FRONTEND_URL` | No | origin header | Frontend URL for Stripe redirects |
| `PORT` | No | `8000` | Backend server port |

## Key Patterns

### Frontend SSE Parsing (`ChatView.jsx`)

```javascript
const response = await fetch('/api/agent/chat', { method: 'POST', body, signal });
const reader = response.body.getReader();
// Read NDJSON lines, parse JSON, switch on event.type
```

Uses `fetch` + `ReadableStream` (not `EventSource` — POST not supported by EventSource).

### Skateboard-UI Imports

```javascript
import { Button } from '@stevederico/skateboard-ui/shadcn/ui/button';
import { apiRequest } from '@stevederico/skateboard-ui/Utilities';
import { getState } from '@stevederico/skateboard-ui/Context';
```

### Security Stack

- JWT in HttpOnly cookies (30-day expiry)
- CSRF token for mutations (24-hour expiry)
- Bcrypt with 10 salt rounds
- Rate limiting: 10 req/15min auth, 5 req/15min payments, 300 req/15min global
- Security headers: CSP, HSTS, X-Frame-Options

## Documentation Requirements

When modifying code, keep JSDoc in sync with implementation. Update CLAUDE.md if architecture changes. Update changelog.md for all changes.

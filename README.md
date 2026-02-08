<p align="center">
  <img src="public/icons/icon.png" width="80" height="80" alt="dotBot icon">
</p>

<h1 align="center">dotBot</h1>

<h3 align="center">Your local AI agent with memory, tools, and scheduled tasks</h3>

<p align="center">
  A personal AI assistant powered by Ollama that can search the web, read/write files, run code, remember things, and work on a schedule — all running locally on your machine.
</p>

<p align="center">
  <a href="https://opensource.org/licenses/mit">
    <img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="MIT License">
  </a>
</p>

---

<!-- Screenshots go here -->

## What dotBot Can Do

- Chat with a local LLM through a clean, streaming UI
- Remember facts, preferences, and context across conversations
- Search the web with Brave Search API
- Fetch and parse any URL
- Read and write files in a sandboxed `~/.dotbot` directory
- Execute JavaScript code with output capture
- Schedule one-shot or recurring tasks (reminders, checks, automations)
- Switch between any Ollama model on the fly

## Architecture

```
 React 19 + Vite 7          Hono Server             Ollama
 ┌─────────────┐        ┌──────────────────┐     ┌──────────┐
 │  ChatView   │──SSE──>│  Agent Routes    │────>│ /api/chat│
 │  (fetch +   │<──────>│  Agent Loop      │<────│ (stream) │
 │  ReadStream) │        │  (max 10 iters)  │     └──────────┘
 └─────────────┘        │        │         │
                        │   Tool Executor  │
                        │   ┌──────────┐   │
                        │   │ Memory   │   │     ┌──────────┐
                        │   │ Cron     │   │────>│ MongoDB  │
                        │   │ Web      │   │     └──────────┘
                        │   │ Files    │   │
                        │   │ Code     │   │
                        │   └──────────┘   │
                        └──────────────────┘
```

## Tech Stack

| Technology | Version | Purpose |
|------------|---------|---------|
| React | 19.2 | Frontend UI |
| Vite | 7.1 | Build + dev server |
| Tailwind CSS | 4.1 | Styling |
| skateboard-ui | 2.9 | App shell (auth, routing, components) |
| Hono | 4.7 | Backend HTTP server |
| MongoDB | — | Agent state (sessions, memories, cron) |
| Ollama | — | Local LLM inference |
| Node.js | 22+ | Runtime |
| Stripe | — | Subscription payments |

## Prerequisites

- **Node.js 22+**
- **MongoDB** (local or Atlas)
- **Ollama** installed and running

Pull the default model:
```bash
ollama pull gpt-oss:20b
```

## Quick Start

1. **Clone the repo**
   ```bash
   git clone <your-repo-url> dotbot
   cd dotbot
   ```

2. **Install dependencies**
   ```bash
   npm run install-all
   ```

3. **Configure environment** — create `backend/.env`:
   ```bash
   JWT_SECRET=your-random-secret-key
   MONGODB_URL=mongodb://localhost:27017
   STRIPE_KEY=sk_test_...
   STRIPE_ENDPOINT_SECRET=whsec_...
   BRAVE_API_KEY=your-brave-key        # optional, for web search
   ```

4. **Start Ollama**
   ```bash
   ollama serve
   ```

5. **Start the app**
   ```bash
   npm start
   ```

   Frontend: `http://localhost:5173` | Backend: `http://localhost:8000`

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `JWT_SECRET` | Yes | — | Token signing key |
| `MONGODB_URL` | Yes | — | MongoDB connection string |
| `STRIPE_KEY` | Yes | — | Stripe secret key |
| `STRIPE_ENDPOINT_SECRET` | Yes | — | Stripe webhook signing secret |
| `BRAVE_API_KEY` | No | — | Brave Search API key |
| `FREE_USAGE_LIMIT` | No | `20` | Monthly messages for free users |
| `CORS_ORIGINS` | No | localhost | Allowed origins (production) |
| `PORT` | No | `8000` | Backend port |

### Backend Config (`backend/config.json`)

```json
{
  "staticDir": "../dist",
  "database": {
    "db": "dotbot",
    "dbType": "mongodb",
    "connectionString": "${MONGODB_URL}"
  }
}
```

### App Config (`src/constants.json`)

Key fields: `appName`, `tagline`, `pages`, `stripeProducts`, `backendURL`, `devBackendURL`

## Agent Tools

| Tool | Description |
|------|-------------|
| `memory_save` | Save facts and preferences to long-term memory |
| `memory_search` | Search saved memories by content or tags |
| `schedule_task` | Schedule a one-shot or recurring task |
| `list_tasks` | List all active and completed tasks |
| `cancel_task` | Cancel a scheduled task |
| `web_search` | Search the web via Brave Search |
| `web_fetch` | Fetch and parse any URL |
| `file_read` | Read files from `~/.dotbot` |
| `file_write` | Write files to `~/.dotbot` |
| `run_code` | Execute JavaScript and capture output |

## Default Model

dotBot ships with `gpt-oss:20b` as the default. You can switch models in the chat UI or pull alternatives:

```bash
ollama pull llama3.3
ollama pull mistral
ollama pull codellama
```

## Development

```bash
npm run start      # Both frontend + backend
npm run front      # Frontend only (Vite on :5173)
npm run server     # Backend only (Hono on :8000)
npm run build      # Production build
```

The Vite dev server proxies `/api` requests to the Hono backend on port 8000.

## Deployment

```bash
docker build -t dotbot .
docker run -p 8000:8000 --env-file backend/.env dotbot
```

See [docs/DEPLOY.md](docs/DEPLOY.md) for Vercel, Render, Netlify, and Docker instructions.

## License

MIT License — see [LICENSE](LICENSE) for details.

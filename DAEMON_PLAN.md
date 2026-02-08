# Persistent Daemon Mode — Implementation Plan

## Overview

Extend dotBot from a request-response chat agent into a persistent daemon that processes events from multiple sources (cron, webhooks, watchers) through a single event queue, reusing the existing `agentLoop` async generator.

## Architecture

```
┌─────────────────────────────────────────────────┐
│                  Daemon Process                   │
│                                                   │
│  ┌───────────┐  ┌───────────┐  ┌───────────────┐ │
│  │  Cron      │  │  Webhooks │  │  Watchers     │ │
│  │  (exists)  │  │  Inbound  │  │  File/Event   │ │
│  └─────┬─────┘  └─────┬─────┘  └──────┬────────┘ │
│        │               │               │          │
│        └───────┬───────┴───────┬───────┘          │
│                ▼               ▼                   │
│         ┌─────────────────────────┐               │
│         │     Event Queue         │               │
│         │  (MongoDB collection)   │               │
│         └───────────┬─────────────┘               │
│                     ▼                              │
│         ┌─────────────────────────┐               │
│         │    Agent Loop Runner    │               │
│         │  (reuses agent.js)      │               │
│         └───────────┬─────────────┘               │
│                     ▼                              │
│         ┌─────────────────────────┐               │
│         │   Response Router       │               │
│         │  → SSE (web UI)         │               │
│         │  → Webhook (Telegram)   │               │
│         │  → Log (silent task)    │               │
│         └─────────────────────────┘               │
└─────────────────────────────────────────────────┘
```

## Event Sources

### 1. Cron (exists — refactor)
Current `cron.js` polls every 30s and directly calls the agent. Refactor to write events into `daemon_events` collection instead, letting the daemon loop process them uniformly.

### 2. Inbound Webhooks (new)
New route `POST /api/agent/webhook/:channel` receives events from external services (Telegram, GitHub, Home Assistant, etc.), normalizes them into a standard event shape, and inserts into the queue.

```javascript
app.post('/api/agent/webhook/:channel', async (c) => {
  const { channel } = c.req.param();
  const payload = await c.req.json();

  await db.collection('daemon_events').insertOne({
    channel,        // "telegram", "github", "homeassistant"
    payload,
    status: 'pending',
    createdAt: new Date()
  });

  return c.json({ queued: true });
});
```

### 3. Watchers (new)
Polling loops for services that don't support webhooks:

```javascript
const WATCHERS = [
  {
    name: 'email_check',
    intervalMs: 60_000,
    poll: async () => { /* Check IMAP, return event or null */ }
  },
  {
    name: 'file_monitor',
    intervalMs: 10_000,
    poll: async () => { /* Check ~/.dotbot/inbox/ for new files */ }
  }
];
```

## Core: The Daemon Loop

```javascript
async function daemonLoop(db) {
  const POLL_INTERVAL = 5_000;

  while (true) {
    const event = await db.collection('daemon_events').findOneAndUpdate(
      { status: 'pending' },
      { $set: { status: 'processing', startedAt: new Date() } },
      { sort: { createdAt: 1 } }
    );

    if (event) {
      const prompt = buildPrompt(event);
      const session = await getOrCreateSession(event.sessionId);
      const generator = agentLoop(session, prompt, db);

      let finalContent = '';
      for await (const chunk of generator) {
        if (chunk.type === 'done') finalContent = chunk.content;
      }

      await routeResponse(event.channel, finalContent);

      await db.collection('daemon_events').updateOne(
        { _id: event._id },
        { $set: { status: 'completed', response: finalContent } }
      );
    }

    await sleep(POLL_INTERVAL);
  }
}
```

## Response Routing

```javascript
async function routeResponse(channel, content) {
  switch (channel) {
    case 'telegram':
      await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id, text: content })
      });
      break;
    case 'web':
      // Already handled by SSE in existing chat flow
      break;
    case 'silent':
      console.log(`[daemon] silent task completed`);
      break;
  }
}
```

## Per-Channel Tool Permissions

Each channel gets a permission profile controlling which tools the agent can use:

```javascript
const CHANNEL_PERMISSIONS = {
  web:      { tools: '*',              sandbox: '~/.dotbot' },
  telegram: { tools: ['web_search', 'memory_save', 'memory_search'], sandbox: '~/.dotbot' },
  cron:     { tools: ['file_write', 'run_code', 'web_fetch'], sandbox: '~/.dotbot' },
  webhook:  { tools: ['memory_save'],  sandbox: '~/.dotbot' }
};
```

This is the key differentiator from OpenClaw — granular permissions per event source instead of blanket auto-accept.

## MongoDB: New Collection

### `daemon_events`

| Field | Type | Description |
|-------|------|-------------|
| `_id` | ObjectId | Auto |
| `channel` | string | Source: `"cron"`, `"telegram"`, `"webhook"`, etc. |
| `sessionId` | string | Target session for agent context |
| `payload` | object | Raw event data from source |
| `status` | string | `"pending"` → `"processing"` → `"completed"` / `"failed"` |
| `response` | string | Agent's final response (set on completion) |
| `createdAt` | Date | When event was queued |
| `startedAt` | Date | When processing began |
| `completedAt` | Date | When processing finished |

**Indexes:** `{ status: 1, createdAt: 1 }`

## Files Changed

| File | Change |
|------|--------|
| `backend/agent/daemon.js` | **New** — event queue, daemon loop, webhook routes, response router |
| `backend/agent/cron.js` | Refactor to write events to `daemon_events` instead of directly calling agent |
| `backend/server.js` | Mount daemon routes, start daemon loop on boot |
| `backend/agent/agent.js` | No changes — `agentLoop` already works as async generator |

## Startup

```javascript
// backend/server.js — add to existing boot sequence
if (db) {
  startCronLoop(db);      // existing
  startDaemonLoop(db);    // new — processes event queue
}
```

## Key Insight

`agentLoop` in `agent.js` is already decoupled from HTTP — it's an async generator that takes messages and yields events. The daemon is just another caller of that same generator, alongside the existing SSE endpoint. No refactor of the core agent needed.

## Future Channel Adapters

| Channel | Integration Method | Complexity |
|---------|-------------------|------------|
| Telegram | Bot API + webhook | Low |
| Discord | Discord.js bot | Medium |
| WhatsApp | WhatsApp Business API / Twilio | Medium |
| iMessage | AppleScript bridge (macOS only) | High |
| Email | IMAP polling + SMTP send | Medium |
| Home Assistant | REST API + webhook | Low |
| GitHub | Webhook + GitHub API | Low |

#!/usr/bin/env node

// Suppress SQLite experimental warning (stable but still flagged in Node 24)
const originalEmit = process.emit;
process.emit = function (event, error) {
  if (event === 'warning' && error?.name === 'ExperimentalWarning' && error?.message?.includes('SQLite')) {
    return false;
  }
  return originalEmit.apply(process, arguments);
};

/**
 * dotbot CLI
 *
 * Usage:
 *   dotbot chat "What's the weather?"    One-shot query
 *   dotbot repl                          Interactive chat session
 *   dotbot serve --port 3000             Start HTTP server
 *   dotbot --help                        Show help
 *
 * Requires Node.js 22.5+ with --experimental-sqlite flag, or Node.js 23+
 */

import { parseArgs } from 'node:util';
import * as readline from 'node:readline';
import { createServer } from 'node:http';

// Lazy-loaded modules (avoid SQLite import on --help)
let stores = null;
let coreTools = null;
let AI_PROVIDERS = null;
let agentLoop = null;

/**
 * Lazy-load dotbot modules.
 */
async function loadModules() {
  if (stores) return;
  const mod = await import('../index.js');
  stores = {
    SQLiteSessionStore: mod.SQLiteSessionStore,
    SQLiteCronStore: mod.SQLiteCronStore,
    SQLiteTaskStore: mod.SQLiteTaskStore,
    SQLiteTriggerStore: mod.SQLiteTriggerStore,
    SQLiteMemoryStore: mod.SQLiteMemoryStore,
    SQLiteEventStore: mod.SQLiteEventStore,
  };
  coreTools = mod.coreTools;
  AI_PROVIDERS = mod.AI_PROVIDERS;
  agentLoop = mod.agentLoop;
}

const VERSION = '0.17';
const DEFAULT_PORT = 3000;
const DEFAULT_DB = './dotbot.db';

/**
 * Print help message.
 */
function printHelp() {
  console.log(`
dotbot v${VERSION} — AI agent CLI

Usage:
  dotbot "message"            Send a message (default command)
  dotbot repl                 Interactive chat session
  dotbot serve [--port N]     Start HTTP server (default: ${DEFAULT_PORT})

Options:
  --provider, -p   AI provider: xai, anthropic, openai, ollama (default: xai)
  --model, -m      Model name (default: grok-4-1-fast-reasoning)
  --db             SQLite database path (default: ${DEFAULT_DB})
  --port           Server port for 'serve' command (default: ${DEFAULT_PORT})
  --help, -h       Show this help
  --version, -v    Show version

Environment Variables:
  XAI_API_KEY          API key for xAI
  ANTHROPIC_API_KEY    API key for Anthropic
  OPENAI_API_KEY       API key for OpenAI
  OLLAMA_BASE_URL      Base URL for Ollama (default: http://localhost:11434)

Examples:
  dotbot "What's the weather in SF?"
  dotbot "Summarize the news" -p anthropic -m claude-sonnet-4-5
  dotbot repl
  dotbot serve --port 8080
`);
}

/**
 * Parse CLI arguments.
 */
function parseCliArgs() {
  try {
    const { values, positionals } = parseArgs({
      allowPositionals: true,
      options: {
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'v', default: false },
        provider: { type: 'string', short: 'p', default: 'xai' },
        model: { type: 'string', short: 'm', default: 'grok-4-1-fast-reasoning' },
        db: { type: 'string', default: DEFAULT_DB },
        port: { type: 'string', default: String(DEFAULT_PORT) },
      },
    });
    return { ...values, positionals };
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

/**
 * Get provider config with API key from environment.
 *
 * @param {string} providerId - Provider ID
 * @returns {Object} Provider config with headers
 */
async function getProviderConfig(providerId) {
  await loadModules();
  const base = AI_PROVIDERS[providerId];
  if (!base) {
    console.error(`Unknown provider: ${providerId}`);
    console.error(`Available: ${Object.keys(AI_PROVIDERS).join(', ')}`);
    process.exit(1);
  }

  const envKey = base.envKey;
  const apiKey = process.env[envKey];

  if (!apiKey && providerId !== 'ollama') {
    console.error(`Missing ${envKey} environment variable`);
    process.exit(1);
  }

  if (providerId === 'ollama') {
    const baseUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
    return { ...base, apiUrl: `${baseUrl}/api/chat` };
  }

  return {
    ...base,
    headers: () => base.headers(apiKey),
  };
}

/**
 * Initialize stores.
 *
 * @param {string} dbPath - Path to SQLite database
 * @returns {Promise<Object>} Initialized stores
 */
async function initStores(dbPath) {
  await loadModules();

  const sessionStore = new stores.SQLiteSessionStore();
  await sessionStore.init(dbPath, {
    prefsFetcher: async () => ({ agentName: 'Dotbot', agentPersonality: '' }),
  });

  const cronStore = new stores.SQLiteCronStore();
  await cronStore.init(dbPath);

  const taskStore = new stores.SQLiteTaskStore();
  await taskStore.init(dbPath);

  const triggerStore = new stores.SQLiteTriggerStore();
  await triggerStore.init(dbPath);

  const memoryStore = new stores.SQLiteMemoryStore();
  await memoryStore.init(dbPath);

  const eventStore = new stores.SQLiteEventStore();
  await eventStore.init(dbPath);

  return { sessionStore, cronStore, taskStore, triggerStore, memoryStore, eventStore };
}

/**
 * Run a single chat message and stream output.
 *
 * @param {string} message - User message
 * @param {Object} options - CLI options
 */
async function runChat(message, options) {
  const storesObj = await initStores(options.db);
  const provider = await getProviderConfig(options.provider);

  const session = await storesObj.sessionStore.createSession('cli-user', options.model, options.provider);

  const context = {
    userID: 'cli-user',
    sessionId: session.id,
    providers: { [options.provider]: { apiKey: process.env[AI_PROVIDERS[options.provider]?.envKey] } },
    ...storesObj,
  };

  const messages = [{ role: 'user', content: message }];

  process.stdout.write('\n');

  for await (const event of agentLoop({
    model: options.model,
    messages,
    tools: coreTools,
    provider,
    context,
  })) {
    switch (event.type) {
      case 'thinking':
        if (event.text) {
          process.stdout.write(`\x1b[2m${event.text}\x1b[0m`);
        }
        break;
      case 'text_delta':
        process.stdout.write(event.text);
        break;
      case 'tool_start':
        process.stdout.write(`\n[${event.name}] `);
        break;
      case 'tool_result':
        process.stdout.write(`done\n`);
        break;
      case 'error':
        console.error(`\nError: ${event.error}`);
        break;
    }
  }

  process.stdout.write('\n\n');
  process.exit(0);
}

/**
 * Run interactive REPL.
 *
 * @param {Object} options - CLI options
 */
async function runRepl(options) {
  const storesObj = await initStores(options.db);
  const provider = await getProviderConfig(options.provider);

  const session = await storesObj.sessionStore.createSession('cli-user', options.model, options.provider);
  const messages = [];

  const context = {
    userID: 'cli-user',
    sessionId: session.id,
    providers: { [options.provider]: { apiKey: process.env[AI_PROVIDERS[options.provider]?.envKey] } },
    ...storesObj,
  };

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log(`\ndotbot v${VERSION} — ${options.provider}/${options.model}`);
  console.log('Type /quit to exit, /clear to reset conversation\n');

  const prompt = () => {
    rl.question('> ', async (input) => {
      const trimmed = input.trim();

      if (!trimmed) {
        prompt();
        return;
      }

      if (trimmed === '/quit' || trimmed === '/exit') {
        console.log('Goodbye!');
        rl.close();
        process.exit(0);
      }

      if (trimmed === '/clear') {
        messages.length = 0;
        console.log('Conversation cleared.\n');
        prompt();
        return;
      }

      messages.push({ role: 'user', content: trimmed });

      process.stdout.write('\n');
      let assistantContent = '';

      try {
        for await (const event of agentLoop({
          model: options.model,
          messages: [...messages],
          tools: coreTools,
          provider,
          context,
        })) {
          switch (event.type) {
            case 'thinking':
              if (event.text) {
                process.stdout.write(`\x1b[2m${event.text}\x1b[0m`);
              }
              break;
            case 'text_delta':
              process.stdout.write(event.text);
              assistantContent += event.text;
              break;
            case 'tool_start':
              process.stdout.write(`\n[${event.name}] `);
              break;
            case 'tool_result':
              process.stdout.write(`done\n`);
              break;
            case 'error':
              console.error(`\nError: ${event.error}`);
              break;
          }
        }

        if (assistantContent) {
          messages.push({ role: 'assistant', content: assistantContent });
        }
      } catch (err) {
        console.error(`\nError: ${err.message}`);
      }

      process.stdout.write('\n\n');
      prompt();
    });
  };

  prompt();
}

/**
 * Run HTTP server.
 *
 * @param {Object} options - CLI options
 */
async function runServer(options) {
  const port = parseInt(options.port, 10);
  const storesObj = await initStores(options.db);

  const server = createServer(async (req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://localhost:${port}`);

    // Health check
    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', version: VERSION }));
      return;
    }

    // Chat endpoint
    if (req.method === 'POST' && url.pathname === '/chat') {
      let body = '';
      for await (const chunk of req) body += chunk;

      try {
        const { message, provider: providerId = 'anthropic', model = 'claude-sonnet-4-5', sessionId } = JSON.parse(body);

        if (!message) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'message required' }));
          return;
        }

        const provider = await getProviderConfig(providerId);
        let session;

        if (sessionId) {
          session = await storesObj.sessionStore.getSessionInternal(sessionId);
        }
        if (!session) {
          session = await storesObj.sessionStore.createSession('api-user', model, providerId);
        }

        const context = {
          userID: 'api-user',
          sessionId: session.id,
          providers: { [providerId]: { apiKey: process.env[AI_PROVIDERS[providerId]?.envKey] } },
          ...storesObj,
        };

        const messages = [...(session.messages || []), { role: 'user', content: message }];

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });

        for await (const event of agentLoop({
          model,
          messages,
          tools: coreTools,
          provider,
          context,
        })) {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        }

        res.end();
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // 404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  server.listen(port, () => {
    console.log(`\ndotbot server v${VERSION}`);
    console.log(`Listening on http://localhost:${port}`);
    console.log(`\nEndpoints:`);
    console.log(`  GET  /health     Health check`);
    console.log(`  POST /chat       Send message (SSE stream)\n`);
  });
}

/**
 * Main entry point.
 */
async function main() {
  const args = parseCliArgs();

  if (args.version) {
    console.log(`dotbot v${VERSION}`);
    process.exit(0);
  }

  if (args.help || args.positionals.length === 0) {
    printHelp();
    process.exit(0);
  }

  const command = args.positionals[0];

  switch (command) {
    case 'chat':
      const chatMessage = args.positionals.slice(1).join(' ');
      if (!chatMessage) {
        console.error('Usage: dotbot "your message"');
        process.exit(1);
      }
      await runChat(chatMessage, args);
      break;

    case 'repl':
      await runRepl(args);
      break;

    case 'serve':
      await runServer(args);
      break;

    default:
      // Default to chat if not a recognized command
      const message = args.positionals.join(' ');
      await runChat(message, args);
      break;
  }
}

main().catch((err) => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});

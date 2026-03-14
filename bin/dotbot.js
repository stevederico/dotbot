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
 *   dotbot "What's the weather?"    One-shot query
 *   dotbot                          Interactive chat
 *   dotbot serve --port 3000        Start HTTP server
 *   dotbot --help                   Show help
 *
 * Requires Node.js 22+
 */

import { parseArgs } from 'node:util';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import * as readline from 'node:readline';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

// Read version from package.json
const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
const VERSION = pkg.version;

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
const DEFAULT_PORT = 3000;
const DEFAULT_DB = './dotbot.db';
const CONFIG_PATH = join(homedir(), '.dotbotrc');

// Spinner for tool execution feedback
let spinnerInterval = null;

function startSpinner() {
  if (spinnerInterval) clearInterval(spinnerInterval);
  spinnerInterval = setInterval(() => {
    process.stdout.write('.');
  }, 300);
}

function stopSpinner(text = 'done') {
  if (spinnerInterval) {
    clearInterval(spinnerInterval);
    spinnerInterval = null;
    if (text) {
      process.stdout.write(` ${text}\n`);
    } else {
      process.stdout.write('\n');
    }
  }
}

/**
 * Print help message.
 */
function printHelp() {
  console.log(`
dotbot v${VERSION} — AI agent CLI

Usage:
  dotbot "message"            One-shot query
  dotbot                      Interactive chat
  dotbot serve [--port N]     Start HTTP server (default: ${DEFAULT_PORT})
  dotbot serve --openai       Start OpenAI-compatible API server
  echo "msg" | dotbot         Pipe input from stdin

Commands:
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
  --provider, -p   AI provider: xai, anthropic, openai, ollama (default: xai)
  --model, -m      Model name (default: grok-4-1-fast-reasoning)
  --system, -s     Custom system prompt (prepended to default)
  --session        Resume a specific session by ID
  --db             SQLite database path (default: ${DEFAULT_DB})
  --port           Server port for 'serve' command (default: ${DEFAULT_PORT})
  --openai         Enable OpenAI-compatible API endpoints (/v1/chat/completions, /v1/models)
  --json           Output as JSON (for inspection commands)
  --verbose        Show initialization logs
  --help, -h       Show this help
  --version, -v    Show version

Environment Variables:
  XAI_API_KEY          API key for xAI
  ANTHROPIC_API_KEY    API key for Anthropic
  OPENAI_API_KEY       API key for OpenAI
  OLLAMA_BASE_URL      Base URL for Ollama (default: http://localhost:11434)

Config File:
  ~/.dotbotrc                 JSON config for defaults (provider, model, db)

Examples:
  dotbot "What's the weather in SF?"
  dotbot
  dotbot serve --port 8080
  dotbot doctor
  dotbot tools
  dotbot memory search "preferences"
  dotbot memory delete user_pref
  dotbot stats --json
  dotbot --system "You are a pirate" "Hello"
  dotbot --session abc-123 "follow up question"
  echo "What is 2+2?" | dotbot
  cat question.txt | dotbot
`);
}

/**
 * Load config from ~/.dotbotrc if it exists.
 *
 * @returns {Object} Config object or empty object if not found
 */
function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    return {};
  }
  try {
    const content = readFileSync(CONFIG_PATH, 'utf8');
    return JSON.parse(content);
  } catch (err) {
    console.error(`Warning: Invalid config file at ${CONFIG_PATH}: ${err.message}`);
    return {};
  }
}

/**
 * Parse CLI arguments with config file fallback.
 *
 * @returns {Object} Merged CLI args and config values
 */
function parseCliArgs() {
  const config = loadConfig();

  try {
    const { values, positionals } = parseArgs({
      allowPositionals: true,
      options: {
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'v', default: false },
        verbose: { type: 'boolean', default: false },
        provider: { type: 'string', short: 'p' },
        model: { type: 'string', short: 'm' },
        system: { type: 'string', short: 's' },
        summary: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        db: { type: 'string' },
        port: { type: 'string' },
        openai: { type: 'boolean', default: false },
        session: { type: 'string', default: '' },
      },
    });

    // Merge: CLI args > config file > hardcoded defaults
    return {
      ...values,
      provider: values.provider ?? config.provider ?? 'xai',
      model: values.model ?? config.model ?? 'grok-4-1-fast-reasoning',
      system: values.system ?? config.system ?? '',
      db: values.db ?? config.db ?? DEFAULT_DB,
      port: values.port ?? config.port ?? String(DEFAULT_PORT),
      session: values.session ?? '',
      positionals,
    };
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
 * @param {boolean} verbose - Show initialization logs
 * @param {string} customSystemPrompt - Custom system prompt to prepend
 * @returns {Promise<Object>} Initialized stores
 */
async function initStores(dbPath, verbose = false, customSystemPrompt = '') {
  await loadModules();

  // Import defaultSystemPrompt for custom builder
  const { defaultSystemPrompt } = await import('../storage/SQLiteAdapter.js');

  // Suppress init logs unless verbose
  const originalLog = console.log;
  if (!verbose) {
    console.log = () => {};
  }

  // Build custom systemPromptBuilder that prepends user's text
  const systemPromptBuilder = customSystemPrompt
    ? (prefs) => `${customSystemPrompt}\n\n${defaultSystemPrompt(prefs)}`
    : undefined;

  const sessionStore = new stores.SQLiteSessionStore();
  await sessionStore.init(dbPath, {
    prefsFetcher: async () => ({ agentName: 'Dotbot', agentPersonality: '' }),
    ...(systemPromptBuilder && { systemPromptBuilder }),
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

  // Restore console.log
  console.log = originalLog;

  return { sessionStore, cronStore, taskStore, triggerStore, memoryStore, eventStore };
}

/**
 * Run a single chat message and stream output.
 *
 * @param {string} message - User message
 * @param {Object} options - CLI options
 */
async function runChat(message, options) {
  const storesObj = await initStores(options.db, options.verbose, options.system);
  const provider = await getProviderConfig(options.provider);

  let session;
  let messages;

  if (options.session) {
    session = await storesObj.sessionStore.getSession(options.session, 'cli-user');
    if (!session) {
      console.error(`Error: Session not found: ${options.session}`);
      process.exit(1);
    }
    messages = [...(session.messages || []), { role: 'user', content: message }];
  } else {
    session = await storesObj.sessionStore.createSession('cli-user', options.model, options.provider);
    messages = [{ role: 'user', content: message }];
  }

  const context = {
    userID: 'cli-user',
    sessionId: session.id,
    providers: { [options.provider]: { apiKey: process.env[AI_PROVIDERS[options.provider]?.envKey] } },
    ...storesObj,
  };

  process.stdout.write('\n[thinking] ');
  startSpinner();

  for await (const event of agentLoop({
    model: options.model,
    messages,
    tools: coreTools,
    provider,
    context,
  })) {
    switch (event.type) {
      case 'thinking':
        // Already showing spinner, ignore thinking events
        break;
      case 'text_delta':
        stopSpinner('');  // Stop thinking spinner silently
        process.stdout.write(event.text);
        break;
      case 'tool_start':
        stopSpinner('');  // Stop thinking spinner silently
        process.stdout.write(`[${event.name}] `);
        startSpinner();
        break;
      case 'tool_result':
        stopSpinner('done');
        break;
      case 'tool_error':
        stopSpinner('error');
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
  const storesObj = await initStores(options.db, options.verbose, options.system);
  const provider = await getProviderConfig(options.provider);

  let session;
  let messages;

  if (options.session) {
    session = await storesObj.sessionStore.getSession(options.session, 'cli-user');
    if (!session) {
      console.error(`Error: Session not found: ${options.session}`);
      process.exit(1);
    }
    messages = [...(session.messages || [])];
  } else {
    session = await storesObj.sessionStore.createSession('cli-user', options.model, options.provider);
    messages = [];
  }

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
  if (options.session) {
    console.log(`Resuming session: ${session.id}`);
  }
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

      process.stdout.write('\n[thinking] ');
      startSpinner();
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
              // Already showing spinner, ignore thinking events
              break;
            case 'text_delta':
              stopSpinner('');  // Stop thinking spinner silently
              process.stdout.write(event.text);
              assistantContent += event.text;
              break;
            case 'tool_start':
              stopSpinner('');  // Stop thinking spinner silently
              process.stdout.write(`[${event.name}] `);
              startSpinner();
              break;
            case 'tool_result':
              stopSpinner('done');
              break;
            case 'tool_error':
              stopSpinner('error');
              break;
            case 'error':
              stopSpinner();
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
  const storesObj = await initStores(options.db, options.verbose, options.system);

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

    // OpenAI-compatible endpoints (when --openai flag is set)
    if (options.openai) {
      // GET /v1/models - list available models
      if (req.method === 'GET' && url.pathname === '/v1/models') {
        const models = [
          { id: 'grok-3', object: 'model', owned_by: 'xai' },
          { id: 'grok-4-1-fast-reasoning', object: 'model', owned_by: 'xai' },
          { id: 'claude-sonnet-4-5', object: 'model', owned_by: 'anthropic' },
          { id: 'claude-opus-4', object: 'model', owned_by: 'anthropic' },
          { id: 'gpt-4o', object: 'model', owned_by: 'openai' },
        ];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: models }));
        return;
      }

      // POST /v1/chat/completions - OpenAI-compatible chat endpoint
      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
        let body = '';
        for await (const chunk of req) body += chunk;

        try {
          const { model = 'grok-4-1-fast-reasoning', messages: reqMessages, stream = true } = JSON.parse(body);

          if (!reqMessages || !Array.isArray(reqMessages)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'messages array required', type: 'invalid_request_error' } }));
            return;
          }

          // Determine provider from model name
          let providerId = 'xai';
          if (model.startsWith('claude')) providerId = 'anthropic';
          else if (model.startsWith('gpt')) providerId = 'openai';
          else if (model.startsWith('llama') || model.startsWith('mistral')) providerId = 'ollama';

          const provider = await getProviderConfig(providerId);
          const session = await storesObj.sessionStore.createSession('api-user', model, providerId);

          const context = {
            userID: 'api-user',
            sessionId: session.id,
            providers: { [providerId]: { apiKey: process.env[AI_PROVIDERS[providerId]?.envKey] } },
            ...storesObj,
          };

          const completionId = `chatcmpl-${randomUUID()}`;
          const created = Math.floor(Date.now() / 1000);

          if (stream) {
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive',
            });

            // Send initial role chunk
            const roleChunk = {
              id: completionId,
              object: 'chat.completion.chunk',
              created,
              model,
              choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
            };
            res.write(`data: ${JSON.stringify(roleChunk)}\n\n`);

            for await (const event of agentLoop({
              model,
              messages: reqMessages,
              tools: coreTools,
              provider,
              context,
            })) {
              if (event.type === 'text_delta') {
                const chunk = {
                  id: completionId,
                  object: 'chat.completion.chunk',
                  created,
                  model,
                  choices: [{ index: 0, delta: { content: event.text }, finish_reason: null }],
                };
                res.write(`data: ${JSON.stringify(chunk)}\n\n`);
              } else if (event.type === 'done') {
                const finalChunk = {
                  id: completionId,
                  object: 'chat.completion.chunk',
                  created,
                  model,
                  choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                };
                res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
              }
            }

            res.write('data: [DONE]\n\n');
            res.end();
          } else {
            // Non-streaming response
            let fullContent = '';
            for await (const event of agentLoop({
              model,
              messages: reqMessages,
              tools: coreTools,
              provider,
              context,
            })) {
              if (event.type === 'text_delta') {
                fullContent += event.text;
              }
            }

            const response = {
              id: completionId,
              object: 'chat.completion',
              created,
              model,
              choices: [{
                index: 0,
                message: { role: 'assistant', content: fullContent },
                finish_reason: 'stop',
              }],
              usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            };
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(response));
          }
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: err.message, type: 'server_error' } }));
        }
        return;
      }
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
    console.log(`  POST /chat       Send message (SSE stream)`);
    if (options.openai) {
      console.log(`\nOpenAI-compatible API:`);
      console.log(`  GET  /v1/models            List available models`);
      console.log(`  POST /v1/chat/completions  Chat completions (SSE stream)`);
    }
    console.log();
  });
}

/**
 * List all available tools.
 *
 * @param {Object} options - CLI options
 */
async function runTools(options) {
  await loadModules();

  if (options.json) {
    const toolList = coreTools.map((t) => ({ name: t.name, description: t.description }));
    console.log(JSON.stringify(toolList));
    return;
  }

  console.log(`\ndotbot tools (${coreTools.length})\n`);

  // Group tools by category based on name prefix
  const categories = {};
  for (const tool of coreTools) {
    const prefix = tool.name.split('_')[0];
    if (!categories[prefix]) categories[prefix] = [];
    categories[prefix].push(tool.name);
  }

  for (const [category, tools] of Object.entries(categories).sort()) {
    console.log(`  ${category} (${tools.length})`);
    for (const name of tools.sort()) {
      console.log(`    ${name}`);
    }
  }
  console.log();
}

/**
 * Show database statistics.
 *
 * @param {Object} options - CLI options
 */
async function runStats(options) {
  const storesObj = await initStores(options.db, options.verbose, options.system);

  // Sessions
  const sessions = await storesObj.sessionStore.listSessions('cli-user');

  // Memory
  const memories = await storesObj.memoryStore.getAllMemories('cli-user');

  // Jobs (need to get session IDs first)
  const jobs = await storesObj.cronStore.listTasksBySessionIds(['default'], 'cli-user');

  // Tasks
  const tasks = await storesObj.taskStore.getTasks('cli-user');

  // Triggers
  const triggers = await storesObj.triggerStore.listTriggers('cli-user');

  if (options.json) {
    console.log(JSON.stringify({
      database: options.db,
      sessions: sessions.length,
      memories: memories.length,
      jobs: jobs.length,
      tasks: tasks.length,
      triggers: triggers.length,
    }));
    return;
  }

  console.log(`\ndotbot stats\n`);
  console.log(`  Database: ${options.db}`);
  console.log(`  Sessions: ${sessions.length}`);
  console.log(`  Memories: ${memories.length}`);
  console.log(`  Jobs: ${jobs.length}`);
  console.log(`  Tasks: ${tasks.length}`);
  console.log(`  Triggers: ${triggers.length}`);

  console.log();
}

/**
 * Manage memories.
 *
 * @param {Object} options - CLI options
 * @param {string} subcommand - list, search, or delete
 * @param {string} query - Search query or key to delete
 */
async function runMemory(options, subcommand, query) {
  const storesObj = await initStores(options.db, options.verbose, options.system);

  if (subcommand === 'delete' && query) {
    const result = await storesObj.memoryStore.deleteMemory('cli-user', query);
    if (options.json) {
      console.log(JSON.stringify({ deleted: result, key: query }));
    } else {
      console.log(result ? `\nDeleted memory: ${query}\n` : `\nMemory not found: ${query}\n`);
    }
    return;
  }

  if (subcommand === 'search' && query) {
    const results = await storesObj.memoryStore.readMemoryPattern('cli-user', `%${query}%`);
    if (options.json) {
      console.log(JSON.stringify(results));
      return;
    }
    console.log(`\nMemory search: "${query}" (${results.length} results)\n`);
    for (const mem of results) {
      const val = typeof mem.value === 'string' ? mem.value : JSON.stringify(mem.value);
      console.log(`  [${mem.key}] ${val.substring(0, 60)}${val.length > 60 ? '...' : ''}`);
    }
  } else {
    const memories = await storesObj.memoryStore.getAllMemories('cli-user');
    if (options.json) {
      console.log(JSON.stringify(memories));
      return;
    }
    console.log(`\nMemories (${memories.length})\n`);
    for (const mem of memories) {
      const val = typeof mem.value === 'string' ? mem.value : JSON.stringify(mem.value);
      console.log(`  [${mem.key}] ${val.substring(0, 60)}${val.length > 60 ? '...' : ''}`);
    }
  }
  console.log();
}

/**
 * Manage scheduled jobs.
 *
 * @param {Object} options - CLI options
 * @param {string} subcommand - list or delete
 * @param {string} jobId - Job ID to delete
 */
async function runJobs(options, subcommand, jobId) {
  const storesObj = await initStores(options.db, options.verbose, options.system);

  if (subcommand === 'delete' && jobId) {
    const result = await storesObj.cronStore.deleteTask(jobId);
    if (options.json) {
      console.log(JSON.stringify({ deleted: result, id: jobId }));
    } else {
      console.log(result ? `\nDeleted job: ${jobId}\n` : `\nJob not found: ${jobId}\n`);
    }
    return;
  }

  const jobs = await storesObj.cronStore.listTasksBySessionIds(['default'], 'cli-user');

  if (options.json) {
    console.log(JSON.stringify(jobs));
    return;
  }

  console.log(`\nScheduled jobs (${jobs.length})\n`);

  for (const job of jobs) {
    const status = job.enabled ? 'active' : 'paused';
    const next = job.nextRunAt ? job.nextRunAt.toLocaleString() : 'N/A';
    const interval = job.intervalMs ? `${Math.round(job.intervalMs / 60000)}m` : 'once';
    console.log(`  [${job.id}] ${job.name} (${status})`);
    console.log(`    Interval: ${interval}`);
    console.log(`    Next: ${next}`);
    console.log(`    Prompt: ${job.prompt.substring(0, 50)}${job.prompt.length > 50 ? '...' : ''}`);
    console.log();
  }
}

/**
 * Manage active tasks.
 *
 * @param {Object} options - CLI options
 * @param {string} subcommand - list or delete
 * @param {string} taskId - Task ID to delete
 */
async function runTasks(options, subcommand, taskId) {
  const storesObj = await initStores(options.db, options.verbose, options.system);

  if (subcommand === 'delete' && taskId) {
    const result = await storesObj.taskStore.deleteTask('cli-user', taskId);
    if (options.json) {
      console.log(JSON.stringify({ deleted: result, id: taskId }));
    } else {
      console.log(result ? `\nDeleted task: ${taskId}\n` : `\nTask not found: ${taskId}\n`);
    }
    return;
  }

  const tasks = await storesObj.taskStore.getTasks('cli-user');

  if (options.json) {
    console.log(JSON.stringify(tasks));
    return;
  }

  console.log(`\nTasks (${tasks.length})\n`);

  for (const task of tasks) {
    const steps = task.steps ? JSON.parse(task.steps) : [];
    const progress = `${task.current_step || 0}/${steps.length}`;
    console.log(`  [${task.id}] ${task.status} (${progress})`);
    console.log(`    Description: ${task.description?.substring(0, 50) || 'N/A'}${task.description?.length > 50 ? '...' : ''}`);
    console.log(`    Mode: ${task.mode || 'auto'}`);
    console.log(`    Created: ${new Date(task.created_at).toLocaleString()}`);
    console.log();
  }
}

/**
 * Manage chat sessions.
 *
 * @param {Object} options - CLI options
 * @param {string} subcommand - list or delete
 * @param {string} sessionId - Session ID to delete
 */
async function runSessions(options, subcommand, sessionId) {
  const storesObj = await initStores(options.db, options.verbose, options.system);

  if (subcommand === 'delete' && sessionId) {
    const result = await storesObj.sessionStore.deleteSession(sessionId, 'cli-user');
    if (options.json) {
      console.log(JSON.stringify({ deleted: result, id: sessionId }));
    } else {
      console.log(result ? `\nDeleted session: ${sessionId}\n` : `\nSession not found: ${sessionId}\n`);
    }
    return;
  }

  const sessions = await storesObj.sessionStore.listSessions('cli-user');

  if (options.json) {
    console.log(JSON.stringify(sessions));
    return;
  }

  console.log(`\nSessions (${sessions.length})\n`);

  for (const session of sessions) {
    const updated = new Date(session.updatedAt).toLocaleString();
    const msgCount = session.messageCount || 0;
    console.log(`  [${session.id}]`);
    console.log(`    Title: ${session.title || 'Untitled'}`);
    console.log(`    Messages: ${msgCount}`);
    console.log(`    Updated: ${updated}`);
    console.log();
  }
}

/**
 * View audit log events.
 *
 * @param {Object} options - CLI options
 */
async function runEvents(options) {
  const storesObj = await initStores(options.db, options.verbose, options.system);

  if (options.summary) {
    const summary = await storesObj.eventStore.summary({ userId: 'cli-user' });
    if (options.json) {
      console.log(JSON.stringify(summary));
      return;
    }
    console.log(`\nEvent summary\n`);
    console.log(`  Total events: ${summary.total || 0}`);
    if (summary.breakdown) {
      for (const [type, count] of Object.entries(summary.breakdown)) {
        console.log(`  ${type}: ${count}`);
      }
    }
  } else {
    const events = await storesObj.eventStore.query({ userId: 'cli-user', limit: 20 });
    if (options.json) {
      console.log(JSON.stringify(events));
      return;
    }
    console.log(`\nRecent events (${events.length})\n`);

    for (const event of events) {
      const time = new Date(event.timestamp).toLocaleString();
      console.log(`  [${time}] ${event.type}`);
      if (event.data) {
        const data = typeof event.data === 'string' ? event.data : JSON.stringify(event.data);
        console.log(`    ${data.substring(0, 60)}${data.length > 60 ? '...' : ''}`);
      }
    }
  }
  console.log();
}

/**
 * Check environment and configuration.
 *
 * @param {Object} options - CLI options
 */
async function runDoctor(options) {
  console.log(`\ndotbot doctor\n`);

  // Node.js version
  const nodeVersion = process.version;
  const nodeMajor = parseInt(nodeVersion.slice(1).split('.')[0], 10);
  const nodeOk = nodeMajor >= 22;
  console.log(`  Node.js: ${nodeVersion} ${nodeOk ? '\u2713' : '\u2717 (requires >= 22.0.0)'}`);

  // Database check
  const dbPath = options.db;
  let dbOk = false;
  try {
    if (existsSync(dbPath)) {
      // Try to open database
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(dbPath, { open: true });
      db.close();
      dbOk = true;
    } else {
      dbOk = true; // Will be created on first use
    }
  } catch {
    dbOk = false;
  }
  console.log(`  Database: ${dbPath} ${dbOk ? '\u2713' : '\u2717 not accessible'}`);

  // Config file check
  let configOk = false;
  let configMsg = '';
  if (existsSync(CONFIG_PATH)) {
    try {
      const content = readFileSync(CONFIG_PATH, 'utf8');
      JSON.parse(content);
      configOk = true;
      configMsg = `${CONFIG_PATH} \u2713`;
    } catch (err) {
      configMsg = `${CONFIG_PATH} \u2717 invalid JSON`;
    }
  } else {
    configMsg = `${CONFIG_PATH} (not found)`;
  }
  console.log(`  Config: ${configMsg}`);

  // API Keys
  console.log(`\n  API Keys:`);
  const apiKeys = [
    { name: 'XAI_API_KEY', env: process.env.XAI_API_KEY },
    { name: 'ANTHROPIC_API_KEY', env: process.env.ANTHROPIC_API_KEY },
    { name: 'OPENAI_API_KEY', env: process.env.OPENAI_API_KEY },
  ];

  for (const key of apiKeys) {
    const isSet = Boolean(key.env);
    console.log(`    ${key.name}: ${isSet ? '\u2713 set' : '\u2717 not set'}`);
  }

  console.log();
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

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const command = args.positionals[0];

  // Handle piped input from stdin
  if (!process.stdin.isTTY && !command) {
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk;
    }
    const message = input.trim();
    if (message) {
      await runChat(message, args);
      return;
    }
  }

  switch (command) {
    case 'doctor':
      await runDoctor(args);
      break;
    case 'serve':
      await runServer(args);
      break;
    case 'tools':
      await runTools(args);
      break;
    case 'stats':
      await runStats(args);
      break;
    case 'memory':
      await runMemory(args, args.positionals[1], args.positionals.slice(2).join(' '));
      break;
    case 'jobs':
      await runJobs(args, args.positionals[1], args.positionals[2]);
      break;
    case 'tasks':
      await runTasks(args, args.positionals[1], args.positionals[2]);
      break;
    case 'sessions':
      await runSessions(args, args.positionals[1], args.positionals[2]);
      break;
    case 'events':
      await runEvents(args);
      break;
    default: {
      const message = args.positionals.join(' ');
      if (message) {
        await runChat(message, args);
      } else {
        await runRepl(args);
      }
    }
  }
}

main().catch((err) => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});

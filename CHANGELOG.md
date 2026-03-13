0.24

  Add --system flag for custom prompts
  Add tools command
  Add stats command
  Add memory command
  Add jobs command
  Add tasks command
  Add sessions command
  Add events command

0.23

  Fix no-args launches interactive

0.22

  Simplify CLI, no args for interactive

0.21

  Fix spinner overlap bug

0.20.2

  Add spinner for thinking/tools

0.20.1

  Read version from package.json

0.20

  Zero npm dependencies
  Remove MongoDB support
  Add custom CDP client
  Add Chrome auto-download
  Require Node.js 22+

0.19

  Add test suite (node:test)
  Zero test dependencies

0.18

  Add --verbose flag
  Hide init logs by default
  Add publishConfig for npm

0.17

  Default model grok-4-1-fast-reasoning
  Show thinking stream
  Remove chat keyword requirement
  Suppress SQLite warning
  Fix store init signatures

0.16.1

  Fix store init signatures
  Fix cron table creation order
  Standardize init(dbPath) API

0.16.0

  Rename to @stevederico/dotbot
  Default provider xAI/grok-3
  Update examples to xAI

0.15.0

  Add CLI (dotbot chat, repl, serve)
  Add bin/dotbot.js entry point

0.14.1

  Rename package to dotbot

0.14.0

  Rename Goal to Task throughout
  Add full audit trail logging
  Add configurable maxTurns param
  Add max_tokens to API calls
  Add upsertSession to SQLiteAdapter
  Add updateTitle to SQLiteAdapter
  Add smarter title generation
  Add Morning Brief cron feature
  Add goal_id to task_id migration
  Update browser tool description
  Update web search tool description

0.13.0

  Rename taskTools to jobTools
  Rename task tools to job tools
  Add heartbeat protection to toggle/cancel
  Add heartbeat filter to job queries
  Fix cron schedule-before-fire
  Add ImageEvent to SSE events
  Add image event emission
  Lazy-load playwright
  Add close() to SQLite adapters
  Fix goal ID consistency

0.12.0

  Add EventStore interface
  Add SQLiteEventStore implementation
  Add eventTools (event_query, events_summary)
  Add event logging to agent loop

0.11.1

  Add appgenTools (app_generate, app_validate)
  Add envKey to AI_PROVIDERS
  Add generateImage helper
  Add extractVisualPrompt helper
  Add generateImageFromText helper
  Export appgenTools from index
  Update README for 47 tools

0.10.1

  Rename cronTools to taskTools
  Add backwards compatibility alias

0.10.0

  Add init() unified initialization
  Add core/cron_handler.js
  Add core/trigger_handler.js
  Add storesOnly mode for simple use cases
  Fix createAgent provider scoping bug
  Export createCronHandler
  Export createTriggerHandler

0.9.5

  Add SQLiteCronStore
  Add SQLiteGoalStore
  Add SQLiteTriggerStore
  Add SQLiteMemoryStore
  Add cronTools
  Refactor memory tools to use memoryStore
  Extract cron constants to cron_constants.js

0.9.4

  Add Cerebras provider
  Add local text tool call parsing
  Add passthrough mode for plain models
  Restore SQLiteSessionStore export

0.9.3

  Fix OpenAI content
  Add failover logging

0.9.2

  Standardize SSE events across all providers
  Add core/events.js with event schemas and validation
  Normalize thinking events (always include text + hasNativeThinking flag)
  Normalize stats events (inputTokens/outputTokens across all providers)
  Remove bare thinking events at iteration start
  Validate all events before emission

0.9.1

  Remove SQLiteSessionStore exports

0.9.0

  **BREAKING:** All SessionStore implementations now store messages in standard format only
  Agent loop writes standard format natively; provider-specific wire formats produced just-in-time via toProviderFormat()
  SessionStore adapters normalize legacy messages on read and migrate them on next save
  MemoryStore, SQLiteAdapter, and MongoAdapter all store/return standard format
  Compaction utilities updated to operate on standard format messages
  normalizeMessages() in /history endpoint is now a backward-compatible no-op for already-normalized data

  **Migration:** Existing sessions auto-migrate on first read — no manual steps required

0.8.0

  Add core/normalize.js - provider-agnostic message normalization
  Export toStandardFormat, toProviderFormat, normalizeMessages from core
  Standardize message format across Anthropic/OpenAI providers
  Collapse tool calls and results into unified assistant message structure

0.7.0

  Add SQLite session store
  Make SQLite default
  Update documentation examples

0.1.0

  Initial release

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

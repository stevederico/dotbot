/// <reference types="node" />
// types.ts
// Shared domain types for the dotbot Node ESM library.
//
// These are the types that recur across 2+ modules (core, tools, storage,
// utils). Per-file local types live in their own modules. Conversion agents
// in subdirectories import this as "../types.js"; index.ts imports "./types.js"
// (NodeNext requires the .js specifier — it resolves to this .ts source).

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

/** Any JSON-serializable value. Use for genuinely dynamic payloads. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** A JSON object payload (e.g. parsed tool input, request bodies). */
export type JsonObject = { [key: string]: JsonValue };

// ---------------------------------------------------------------------------
// Providers (utils/providers.js: AI_PROVIDERS)
// ---------------------------------------------------------------------------

/** A model option offered by a provider. */
export interface ProviderModel {
  id: string;
  name: string;
}

/**
 * Provider configuration entry from the AI_PROVIDERS registry.
 * Keys are injected at runtime via createAgent(); the registry itself carries
 * no secrets.
 */
export interface Provider {
  id: string;
  name: string;
  /** Environment variable name holding the API key. Absent for local servers. */
  envKey?: string;
  apiUrl: string;
  defaultModel: string;
  models: ProviderModel[];
  /** True for local OpenAI-compatible servers (ollama, local). */
  local?: boolean;
  /** True if the model's chat template natively supports role:"tool" messages. */
  supportsToolRole?: boolean;
  /** Build request headers from an API key (key may be null/empty for local). */
  headers: (apiKey?: string | null) => Record<string, string>;
  /** Endpoint path appended to apiUrl (e.g. "/messages", "/chat/completions"). */
  endpoint: string;
  /**
   * Build a (non-streaming) request body from messages and a model name.
   * `messages` is the opaque wire-format array; the returned body is passed
   * straight to JSON.stringify, so values are `unknown` rather than JsonValue.
   */
  formatRequest: (messages: unknown, model: string) => Record<string, unknown>;
  /** Extract the assistant text from a raw provider response. */
  formatResponse: (data: unknown) => string | undefined;
}

/** The known provider id keys in the AI_PROVIDERS registry. */
export type ProviderId =
  | "anthropic"
  | "openai"
  | "xai"
  | "cerebras"
  | "ollama"
  | "local";

/** The AI_PROVIDERS registry shape. */
export type ProviderRegistry = Record<string, Provider>;

/**
 * Per-provider runtime credentials/config injected into createAgent().
 * e.g. { anthropic: { apiKey }, xai: { apiKey }, ollama: { baseUrl } }
 */
export interface ProviderConfig {
  apiKey?: string;
  baseUrl?: string;
}

/** Map of provider id → runtime credentials, passed to createAgent(). */
export type ProvidersMap = Record<string, ProviderConfig>;

// ---------------------------------------------------------------------------
// Messages (core/normalize.js: standard message schema)
// ---------------------------------------------------------------------------

export type MessageRole = "system" | "user" | "assistant" | "tool";

/** Lifecycle status of a tool call within an assistant message. */
export type ToolCallStatus = "pending" | "done" | "error";

/** A tool call recorded on a standard-format assistant message. */
export interface MessageToolCall {
  id: string;
  name: string;
  /** Parsed arguments object (may be a raw string before parsing). */
  input: JsonObject | string;
  /** Result content once executed (JSON string if the tool returned an object). */
  result?: string;
  status: ToolCallStatus;
}

/** An image attached to an assistant message (from an image-producing tool). */
export interface MessageImage {
  url: string;
  prompt?: string;
}

/**
 * Provider-agnostic standard message (see core/normalize.js).
 * User/system messages carry string content; assistant messages may also carry
 * toolCalls, thinking, and images. `content` can be a content-block array while
 * a message is still in provider wire format (pre/post normalization).
 */
export interface Message {
  role: MessageRole;
  content: string | ContentBlock[];
  toolCalls?: MessageToolCall[];
  thinking?: string;
  images?: MessageImage[];
  /** Wire-format OpenAI tool calls (present on provider-format messages). */
  tool_calls?: WireToolCall[];
  /** Wire-format OpenAI tool-result correlation id (role:"tool" messages). */
  tool_call_id?: string;
  /** Creation timestamp (Unix ms). */
  _ts?: number;
}

/**
 * A content block in provider wire format (Anthropic content arrays / OpenAI).
 * Fields are optional because the union spans text, thinking, tool_use, and
 * tool_result block shapes; narrow on `type` before reading.
 */
export interface ContentBlock {
  type: "text" | "thinking" | "tool_use" | "tool_result";
  text?: string;
  thinking?: string;
  // tool_use
  id?: string;
  name?: string;
  input?: JsonObject;
  // tool_result
  tool_use_id?: string;
  content?: string | ContentBlock[];
}

/** OpenAI-format tool call on an assistant wire message. */
export interface WireToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    /** JSON-encoded arguments string. */
    arguments: string;
  };
}

/** Target wire format for toProviderFormat(). */
export type ProviderFormat = "anthropic" | "openai";

// ---------------------------------------------------------------------------
// Tools (tools/*.js: tool definition shape)
// ---------------------------------------------------------------------------

/**
 * A JSON Schema fragment describing a tool's parameters.
 * Kept loose (`unknown` values) because schemas are arbitrary JSON Schema.
 */
export interface JsonSchema {
  type?: string;
  description?: string;
  enum?: string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  [key: string]: unknown;
}

/** A tool's return value: a string, or an object that gets JSON-stringified. */
export type ToolResult = string | JsonObject;

/**
 * A tool's execute function.
 * NOTE the argument order: (input, signal, context) — input is the parsed
 * arguments object, signal is the optional AbortSignal, context is the
 * AgentContext injected by createAgent().
 */
export type ToolExecute = (
  input: JsonObject,
  signal: AbortSignal | undefined,
  context: AgentContext,
) => Promise<ToolResult> | ToolResult;

/** A tool definition registered with the agent. */
export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the tool's input parameters. */
  parameters: JsonSchema;
  execute: ToolExecute;
  /**
   * When every tool in a turn has directReturn:true and all succeed, the loop
   * returns their combined results as the final answer without a second LLM
   * call (see core/agent.js).
   */
  directReturn?: boolean;
}

// ---------------------------------------------------------------------------
// Agent execution context (index.js: enhancedContext passed to tools)
// ---------------------------------------------------------------------------

/**
 * Virtual filesystem connection config used by file tools (tools/files.js).
 */
export interface DbConfig {
  dbType: string;
  db: string;
  connectionString: string;
}

/**
 * Execution context passed to every tool's execute() and to the agent loop.
 * createAgent() injects providers + the configured stores; callers may add
 * arbitrary extra fields, hence the index signature.
 */
export interface AgentContext {
  /** Runtime provider credentials keyed by provider id. */
  providers?: ProvidersMap;
  /** Identifies the user for store scoping, browser isolation, event logging. */
  userID?: string;
  eventStore?: EventStore | null;
  cronStore?: CronStore | null;
  taskStore?: TaskStore | null;
  triggerStore?: TriggerStore | null;
  memoryStore?: MemoryStore | null;
  /** Virtual filesystem manager used by file tools. */
  databaseManager?: DatabaseManager;
  dbConfig?: DbConfig;
  /** Callers may attach additional, app-specific context fields. */
  [key: string]: unknown;
}

/**
 * Virtual filesystem manager backing the file tools. Modeled structurally from
 * tools/files.js usage; methods take (dbType, db, connectionString, userID, …).
 */
export interface DatabaseManager {
  readFile(
    dbType: string,
    db: string,
    connectionString: string,
    userID: string,
    path: string,
  ): Promise<VirtualFile | null>;
  writeFile?(...args: unknown[]): Promise<unknown>;
  createFile(
    dbType: string,
    db: string,
    connectionString: string,
    userID: string,
    file: Partial<VirtualFile> & { name: string; type: "file" | "folder" },
  ): Promise<unknown>;
  updateFile(
    dbType: string,
    db: string,
    connectionString: string,
    userID: string,
    path: string,
    updates: Partial<VirtualFile>,
  ): Promise<unknown>;
  deleteFiles(
    dbType: string,
    db: string,
    connectionString: string,
    userID: string,
    path: string,
  ): Promise<{ deletedCount: number }>;
  listFiles(
    dbType: string,
    db: string,
    connectionString: string,
    userID: string,
    path: string,
  ): Promise<VirtualFile[]>;
  seedUserFiles(
    dbType: string,
    db: string,
    connectionString: string,
    userID: string,
  ): Promise<unknown>;
}

/** A node in the user's virtual filesystem. */
export interface VirtualFile {
  name: string;
  type: "file" | "folder";
  parentPath?: string;
  content?: string;
  extension?: string | null;
  size?: number;
  source?: string;
}

// ---------------------------------------------------------------------------
// Agent events (core/events.js: SSE event union, discriminated on `type`)
// ---------------------------------------------------------------------------

export interface TextDeltaEvent {
  type: "text_delta";
  text: string;
}

export interface ThinkingEvent {
  type: "thinking";
  text: string;
  /** True if the provider natively emits reasoning; false for simulated. */
  hasNativeThinking: boolean;
}

export interface ToolStartEvent {
  type: "tool_start";
  name: string;
  input: JsonObject;
}

export interface ToolResultEvent {
  type: "tool_result";
  name: string;
  input: JsonObject;
  /** Tool result (JSON string if the tool returned an object). */
  result: string;
}

export interface ToolErrorEvent {
  type: "tool_error";
  name: string;
  error: string;
}

export interface DoneEvent {
  type: "done";
  content: string;
}

export interface MaxIterationsEvent {
  type: "max_iterations";
  message: string;
}

export interface ErrorEvent {
  type: "error";
  error: string;
}

export interface StatsEvent {
  type: "stats";
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface FollowupEvent {
  type: "followup";
  text: string;
}

export interface ImageEvent {
  type: "image";
  url: string;
  prompt: string;
}

/** Compaction event — no strict schema (see core/events.js validateEvent). */
export interface CompactionEvent {
  type: "compaction";
  [key: string]: unknown;
}

/** Discriminated union of every event the agent loop can yield. */
export type AgentEvent =
  | TextDeltaEvent
  | ThinkingEvent
  | ToolStartEvent
  | ToolResultEvent
  | ToolErrorEvent
  | DoneEvent
  | MaxIterationsEvent
  | ErrorEvent
  | StatsEvent
  | FollowupEvent
  | ImageEvent
  | CompactionEvent;

/** Raw, provider-specific stats passed to normalizeStatsEvent(). */
export interface RawProviderStats {
  model: string;
  // OpenAI-compatible
  prompt_tokens?: number;
  completion_tokens?: number;
  // Anthropic
  input_tokens?: number;
  output_tokens?: number;
}

// ---------------------------------------------------------------------------
// Agent loop options (core/agent.js: agentLoop)
// ---------------------------------------------------------------------------

/** Options for the core agentLoop() generator. */
export interface AgentLoopOptions {
  model: string;
  messages: Message[];
  tools: ToolDefinition[];
  signal?: AbortSignal;
  /** Provider config from AI_PROVIDERS; defaults to Ollama when omitted. */
  provider?: Provider;
  context?: AgentContext;
  /** Iteration safety cap (default 10). */
  maxTurns?: number;
}

// ---------------------------------------------------------------------------
// Storage interfaces (storage/*.js)
// ---------------------------------------------------------------------------

/** A persisted chat session document. */
export interface Session {
  uuid?: string;
  owner?: string;
  model?: string;
  provider?: string;
  messages: Message[];
  [key: string]: unknown;
}

/** Summary row returned by listSessions(). */
export interface SessionSummary {
  uuid?: string;
  model?: string;
  provider?: string;
  [key: string]: unknown;
}

/** Options accepted by SessionStore.init(). */
export interface SessionStoreInitOptions {
  prefsFetcher?: (
    userId: string,
  ) => Promise<{ agentName?: string; agentPersonality?: string }>;
  systemPromptBuilder?: (prefs: {
    agentName?: string;
    agentPersonality?: string;
  }) => string;
  heartbeatEnsurer?: (userId: string) => Promise<unknown | null>;
}

/**
 * Session storage backend (storage/SessionStore.js). The abstract base class
 * throws on every method; concrete adapters (SQLite, Memory) implement them.
 */
export interface SessionStore {
  init(dbPath: string, options?: SessionStoreInitOptions): Promise<void>;
  createSession(
    owner: string,
    model?: string,
    provider?: string,
  ): Promise<Session>;
  getSession(sessionId: string, owner: string): Promise<Session | null>;
  getSessionInternal(sessionId: string): Promise<Session | null>;
  getOrCreateDefaultSession(owner: string): Promise<Session>;
  saveSession(
    sessionId: string,
    messages: Message[],
    model: string,
    provider?: string,
  ): Promise<void>;
  addMessage(sessionId: string, message: Message): Promise<Session>;
  setModel(sessionId: string, model: string): Promise<void>;
  setProvider(sessionId: string, provider: string): Promise<void>;
  clearSession(sessionId: string): Promise<void>;
  listSessions(owner: string): Promise<SessionSummary[]>;
  deleteSession(sessionId: string, owner: string): Promise<unknown>;
  trimMessages(messages: Message[], maxMessages?: number): Message[];
}

/** Recognized analytics/audit event types. */
export type EventType =
  | "message_sent"
  | "message_received"
  | "tool_call"
  | "task_created"
  | "task_completed"
  | "trigger_fired"
  | string;

/** Parameters for EventStore.logEvent(). */
export interface LogEventParams {
  userId: string;
  type: EventType;
  data?: JsonObject;
  /** Unix ms timestamp (defaults to now). */
  timestamp?: number;
}

/** Parameters for EventStore.query(). */
export interface EventQueryParams {
  userId: string;
  type?: EventType;
  startDate?: string;
  endDate?: string;
  limit?: number;
}

/** Parameters for EventStore.summary(). */
export interface EventSummaryParams {
  userId: string;
  startDate?: string;
  endDate?: string;
  groupBy?: "type" | "day" | "week" | "month";
}

/** A single time-bucketed breakdown row (used for day/week/month grouping). */
export interface EventBreakdownPeriod {
  period: string;
  count: number;
  [key: string]: JsonValue;
}

/** Aggregated summary returned by EventStore.summary(). */
export interface EventSummary {
  total: number;
  breakdown: Record<string, number> | EventBreakdownPeriod[];
  toolUsage?: Record<string, number>;
  [key: string]: JsonValue | undefined;
}

/** A persisted analytics/audit event. */
export interface StoredEvent {
  id: string;
  userId: string;
  type: EventType;
  data?: JsonObject;
  timestamp: number;
  createdAt?: number;
  [key: string]: unknown;
}

/**
 * Event/analytics storage backend (storage/EventStore.js).
 * logEvent() is called fire-and-forget from the agent loop.
 */
export interface EventStore {
  init(db: unknown, options?: JsonObject): Promise<void>;
  logEvent(params: LogEventParams): Promise<StoredEvent>;
  query(params: EventQueryParams): Promise<StoredEvent[]>;
  summary(params: EventSummaryParams): Promise<EventSummary>;
  deleteOldEvents(
    userId: string,
    beforeDate: string,
  ): Promise<{ deletedCount?: number } & JsonObject>;
}

/**
 * Long-term memory backend (storage/SQLiteMemoryAdapter.js).
 * Modeled structurally from tools/memory.js usage.
 */
export interface MemoryStore {
  writeMemory(
    userID: string,
    key: string,
    value: unknown,
    source?: string,
  ): Promise<unknown>;
  readMemory(userID: string, key: string): Promise<unknown>;
  readMemoryPattern(userID: string, pattern: string): Promise<unknown[]>;
  deleteMemory(
    userID: string,
    key: string,
  ): Promise<{ deletedCount?: number | bigint }>;
}

/**
 * Scheduled/cron task backend (storage/CronStore.js). Used by job tools.
 * Method shapes are modeled structurally from tools/jobs.js usage; concrete
 * adapters may carry a richer record type.
 */
export interface CronStore {
  /**
   * Param is `unknown` because callers pass dynamic tool input (a JsonObject
   * whose values are JsonValue) while the concrete adapter accepts a richer
   * record that includes non-JSON members (e.g. a Date `runAt`). The adapter
   * validates the shape at runtime. The result is typed `unknown` because
   * concrete adapters return a defined object shape (e.g. CronTask) that the
   * tool callers either discard or narrow dynamically; a `Record<string,
   * unknown>` would wrongly require a string index signature on those shapes.
   */
  createTask(task: unknown): Promise<unknown>;
  listTasks(): Promise<Record<string, unknown>[]>;
  getTask(id: string): Promise<Record<string, unknown> | null>;
  toggleTask(id: string, enabled: boolean): Promise<unknown>;
  deleteTask(id: string): Promise<unknown>;
}

/**
 * Multi-step autonomous task backend (storage/TaskStore.js).
 * Modeled structurally from tools/tasks.js usage.
 */
export interface TaskStore {
  /**
   * Param is `unknown` because callers pass dynamic tool input (a JsonObject)
   * while the concrete adapter requires a richer record (userId, description,
   * …). The adapter validates the shape at runtime. The result is typed
   * `unknown` because concrete adapters return a defined object shape (e.g.
   * TaskDoc) that callers narrow dynamically; a `Record<string, unknown>`
   * would wrongly require a string index signature on those shapes.
   */
  createTask(task: unknown): Promise<unknown>;
  /**
   * Optional, typed `unknown`: the cron handler reads these dynamically and
   * narrows with `typeof === 'function'`. Declared explicitly (instead of a
   * string index signature) so concrete adapter classes stay assignable.
   */
  getTask?: unknown;
  findTasks?: unknown;
}

/**
 * Event-driven trigger backend (storage/TriggerStore.js).
 * Modeled structurally from tools/triggers.js usage.
 */
export interface TriggerStore {
  /**
   * Optional, typed `unknown`: the trigger handler reads these dynamically and
   * narrows with `typeof === 'function'`. Declared explicitly (instead of a
   * string index signature) so concrete adapter classes stay assignable.
   */
  findMatchingTriggers?: unknown;
  markTriggerFired?: unknown;
}

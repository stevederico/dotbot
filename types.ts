/// <reference types="node" />

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

export interface ProviderModel {
  id: string;
  name: string;
}

export interface Provider {
  id: string;
  name: string;
  envKey?: string;
  apiUrl: string;
  defaultModel: string;
  models: ProviderModel[];
  local?: boolean;
  supportsToolRole?: boolean;
  headers: (apiKey?: string | null) => Record<string, string>;
  endpoint: string;
  formatRequest: (messages: unknown, model: string) => Record<string, unknown>;
  formatResponse: (data: unknown) => string | undefined;
}

export type ProviderId =
  | "anthropic"
  | "openai"
  | "xai"
  | "cerebras"
  | "ollama"
  | "local";

export type ProviderRegistry = Record<string, Provider>;

export interface ProviderConfig {
  apiKey?: string;
  baseUrl?: string;
}

export type ProvidersMap = Record<string, ProviderConfig>;

export type MessageRole = "system" | "user" | "assistant" | "tool";

export type ToolCallStatus = "pending" | "done" | "error";

export interface MessageToolCall {
  id: string;
  name: string;
  input: JsonObject | string;
  result?: string;
  status: ToolCallStatus;
}

export interface MessageImage {
  url: string;
  prompt?: string;
}

export interface Message {
  role: MessageRole;
  content: string | ContentBlock[];
  toolCalls?: MessageToolCall[];
  thinking?: string;
  images?: MessageImage[];
  tool_calls?: WireToolCall[];
  tool_call_id?: string;
  _ts?: number;
}

export interface ContentBlock {
  type: "text" | "thinking" | "tool_use" | "tool_result";
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: JsonObject;
  tool_use_id?: string;
  content?: string | ContentBlock[];
}

export interface WireToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export type ProviderFormat = "anthropic" | "openai";

export interface JsonSchema {
  type?: string;
  description?: string;
  enum?: string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  [key: string]: unknown;
}

export type ToolResult = string | JsonObject;

export type ToolExecute = (
  input: JsonObject,
  signal: AbortSignal | undefined,
  context: AgentContext,
) => Promise<ToolResult> | ToolResult;

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
  execute: ToolExecute;
  directReturn?: boolean;
}

export interface DbConfig {
  dbType: string;
  db: string;
  connectionString: string;
}

export interface AgentContext {
  providers?: ProvidersMap;
  userID?: string;
  eventStore?: EventStore | null;
  cronStore?: CronStore | null;
  taskStore?: TaskStore | null;
  triggerStore?: TriggerStore | null;
  memoryStore?: MemoryStore | null;
  databaseManager?: DatabaseManager;
  dbConfig?: DbConfig;
  [key: string]: unknown;
}

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

export interface VirtualFile {
  name: string;
  type: "file" | "folder";
  parentPath?: string;
  content?: string;
  extension?: string | null;
  size?: number;
  source?: string;
}

export interface TextDeltaEvent {
  type: "text_delta";
  text: string;
}

export interface ThinkingEvent {
  type: "thinking";
  text: string;
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

export interface CompactionEvent {
  type: "compaction";
  [key: string]: unknown;
}

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

export interface RawProviderStats {
  model: string;
  prompt_tokens?: number;
  completion_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
}

export interface AgentLoopOptions {
  model: string;
  messages: Message[];
  tools: ToolDefinition[];
  signal?: AbortSignal;
  provider?: Provider;
  context?: AgentContext;
  maxTurns?: number;
}

export interface Session {
  uuid?: string;
  owner?: string;
  model?: string;
  provider?: string;
  messages: Message[];
  [key: string]: unknown;
}

export interface SessionSummary {
  uuid?: string;
  model?: string;
  provider?: string;
  [key: string]: unknown;
}

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

export type EventType =
  | "message_sent"
  | "message_received"
  | "tool_call"
  | "task_created"
  | "task_completed"
  | "trigger_fired"
  | string;

export interface LogEventParams {
  userId: string;
  type: EventType;
  data?: JsonObject;
  timestamp?: number;
}

export interface EventQueryParams {
  userId: string;
  type?: EventType;
  startDate?: string;
  endDate?: string;
  limit?: number;
}

export interface EventSummaryParams {
  userId: string;
  startDate?: string;
  endDate?: string;
  groupBy?: "type" | "day" | "week" | "month";
}

export interface EventBreakdownPeriod {
  period: string;
  count: number;
  [key: string]: JsonValue;
}

export interface EventSummary {
  total: number;
  breakdown: Record<string, number> | EventBreakdownPeriod[];
  toolUsage?: Record<string, number>;
  [key: string]: JsonValue | undefined;
}

export interface StoredEvent {
  id: string;
  userId: string;
  type: EventType;
  data?: JsonObject;
  timestamp: number;
  createdAt?: number;
  [key: string]: unknown;
}

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

export interface CronStore {
  createTask(task: unknown): Promise<unknown>;
  listTasks(): Promise<Record<string, unknown>[]>;
  getTask(id: string): Promise<Record<string, unknown> | null>;
  toggleTask(id: string, enabled: boolean): Promise<unknown>;
  deleteTask(id: string): Promise<unknown>;
}

export interface TaskStore {
  createTask(task: unknown): Promise<unknown>;
  getTask?: unknown;
  findTasks?: unknown;
}

export interface TriggerStore {
  findMatchingTriggers?: unknown;
  markTriggerFired?: unknown;
}

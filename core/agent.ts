
import { AI_PROVIDERS } from "../utils/providers.js";
import { fetchWithFailover, FailoverError } from "./failover.js";
import { toProviderFormat } from "./normalize.js";
import { validateEvent, normalizeStatsEvent } from "./events.js";
import { hasToolCallMarkers, parseToolCalls, stripToolCallMarkers } from "./gptoss_tool_parser.js";
import type {
  AgentLoopOptions,
  AgentEvent,
  Provider,
  Message,
  MessageToolCall,
  JsonObject,
  JsonValue,
  EventType,
  ErrorEvent,
  TextDeltaEvent,
  ThinkingEvent,
  ToolStartEvent,
  ToolResultEvent,
  ToolErrorEvent,
  DoneEvent,
  MaxIterationsEvent,
  FollowupEvent,
  ImageEvent,
  StatsEvent,
} from "../types.js";

const OLLAMA_BASE = "http://localhost:11434";

interface StreamToolCall {
  id: string;
  function: {
    name: string;
    arguments: string | JsonValue;
  };
}

interface StreamResult {
  fullContent: string;
  toolCalls: StreamToolCall[];
}

interface AgentRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

type RequestBody = Record<string, unknown>;

function parseRequestBody(body: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return {};
  }
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    const record: Record<string, unknown> = {};
    for (const key of Object.keys(parsed)) {
      record[key] = Reflect.get(parsed, key);
    }
    return record;
  }
  return {};
}

function toJsonObject(value: JsonValue): JsonObject {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value;
  }
  return {};
}

function parseJsonObject(text: string): JsonObject | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    const record: JsonObject = {};
    for (const key of Object.keys(parsed)) {
      const v = Reflect.get(parsed, key);
      record[key] = toJsonValue(v);
    }
    return record;
  }
  return null;
}

interface OpenAIDeltaToolCall {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAIDelta {
  content?: string;
  reasoning?: string;
  reasoning_content?: string;
  tool_calls?: OpenAIDeltaToolCall[];
}

interface OpenAIChunk {
  model?: string;
  choices?: { delta?: OpenAIDelta; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

interface AnthropicStreamEvent {
  type?: string;
  index?: number;
  model?: string;
  content_block?: { type?: string; id?: string; name?: string };
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
  };
  usage?: { input_tokens?: number; output_tokens?: number };
}

type AnthropicContentBlock =
  | { type: "tool_use"; id?: string; name?: string; inputJson: string }
  | { type: "thinking"; text: string }
  | { type: "text"; text: string };

function recordOf(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null) {
    const record: Record<string, unknown> = {};
    for (const key of Object.keys(value)) record[key] = Reflect.get(value, key);
    return record;
  }
  return null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function parseOpenAIChunk(data: string): OpenAIChunk | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  const root = recordOf(parsed);
  if (!root) return null;

  const chunk: OpenAIChunk = { model: asString(root.model) };

  const usage = recordOf(root.usage);
  if (usage) {
    chunk.usage = {
      prompt_tokens: asNumber(usage.prompt_tokens),
      completion_tokens: asNumber(usage.completion_tokens),
    };
  }

  if (Array.isArray(root.choices)) {
    chunk.choices = root.choices.map((rawChoice) => {
      const choice = recordOf(rawChoice);
      const deltaRecord = choice ? recordOf(choice.delta) : null;
      let delta: OpenAIDelta | undefined;
      if (deltaRecord) {
        delta = {
          content: asString(deltaRecord.content),
          reasoning: asString(deltaRecord.reasoning),
          reasoning_content: asString(deltaRecord.reasoning_content),
        };
        if (Array.isArray(deltaRecord.tool_calls)) {
          delta.tool_calls = deltaRecord.tool_calls.map((rawTc) => {
            const tcRecord = recordOf(rawTc);
            const fnRecord = tcRecord ? recordOf(tcRecord.function) : null;
            const out: OpenAIDeltaToolCall = {
              index: tcRecord ? asNumber(tcRecord.index) : undefined,
              id: tcRecord ? asString(tcRecord.id) : undefined,
            };
            if (fnRecord) {
              out.function = {
                name: asString(fnRecord.name),
                arguments: asString(fnRecord.arguments),
              };
            }
            return out;
          });
        }
      }
      const finishReasonRaw = choice ? choice.finish_reason : undefined;
      const finish_reason =
        finishReasonRaw === null ? null : asString(finishReasonRaw) ?? undefined;
      return { delta, finish_reason };
    });
  }

  return chunk;
}

function parseAnthropicEvent(data: string): AnthropicStreamEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  const root = recordOf(parsed);
  if (!root) return null;

  const event: AnthropicStreamEvent = {
    type: asString(root.type),
    index: asNumber(root.index),
    model: asString(root.model),
  };

  const block = recordOf(root.content_block);
  if (block) {
    event.content_block = {
      type: asString(block.type),
      id: asString(block.id),
      name: asString(block.name),
    };
  }

  const delta = recordOf(root.delta);
  if (delta) {
    event.delta = {
      type: asString(delta.type),
      text: asString(delta.text),
      thinking: asString(delta.thinking),
      partial_json: asString(delta.partial_json),
    };
  }

  const usage = recordOf(root.usage);
  if (usage) {
    event.usage = {
      input_tokens: asNumber(usage.input_tokens),
      output_tokens: asNumber(usage.output_tokens),
    };
  }

  return event;
}

function toJsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(toJsonValue);
  }
  if (typeof value === "object") {
    const obj: JsonObject = {};
    for (const key of Object.keys(value)) {
      obj[key] = toJsonValue(Reflect.get(value, key));
    }
    return obj;
  }
  return null;
}

const IMAGE_PART_TOKENS = 256;

export function estimateMessageTokens(messages: unknown[]): number {
  let chars = 0;
  let images = 0;
  for (const message of messages) {
    if (typeof message !== 'object' || message === null) {
      chars += JSON.stringify(message)?.length ?? 0;
      continue;
    }
    const content: unknown = Reflect.get(message, 'content');
    if (Array.isArray(content)) {
      for (const part of content) {
        const type: unknown = typeof part === 'object' && part !== null ? Reflect.get(part, 'type') : null;
        if (type === 'image_url') images += 1;
        else chars += JSON.stringify(part)?.length ?? 0;
      }
    } else {
      chars += JSON.stringify(message)?.length ?? 0;
    }
  }
  return Math.round(chars / 4) + images * IMAGE_PART_TOKENS;
}

export async function* agentLoop(
  { model, messages, tools, signal, provider, context, maxTurns }: AgentLoopOptions,
): AsyncGenerator<AgentEvent, void, unknown> {
  if (!provider) {
    provider = AI_PROVIDERS.ollama;
  }
  if (!provider) {
    throw new Error("No provider available");
  }
  const resolvedProvider: Provider = provider;

  const logEvent = (type: EventType, data: Record<string, JsonValue | undefined> = {}): void => {
    if (context?.eventStore && context?.userID) {
      const cleaned: JsonObject = {};
      for (const key of Object.keys(data)) {
        const value = data[key];
        if (value !== undefined) cleaned[key] = value;
      }
      context.eventStore.logEvent({
        userId: context.userID,
        type,
        data: cleaned,
      }).catch(() => {});
    }
  };

  const lastUserMsg = messages.filter(m => m.role === 'user').slice(-1)[0];
  if (lastUserMsg) {
    const content = typeof lastUserMsg.content === 'string'
      ? lastUserMsg.content
      : JSON.stringify(lastUserMsg.content);
    logEvent('message_sent', { length: content.length, content });
  }

  const maxIterations = maxTurns || 10;
  let iteration = 0;

  while (iteration < maxIterations) {
    iteration++;

    const toolDefs = tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));

    let response: Response | undefined;
    let activeProvider: Provider = resolvedProvider;

    const buildAgentRequest = (targetProvider: Provider): AgentRequest => {
      const targetApiKey = targetProvider.envKey ? process.env[targetProvider.envKey] : null;
      const targetIsAnthropic = targetProvider.id === "anthropic";
      const targetModel = targetProvider === resolvedProvider ? model : targetProvider.defaultModel;

      const targetFormat = targetIsAnthropic ? "anthropic" : "openai";
      const wireMessages = toProviderFormat(messages, targetFormat);

      if (targetIsAnthropic) {
        const anthropicTools = tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters,
        }));
        const systemMsg = wireMessages.find((m) => m.role === "system");
        const chatMessages = wireMessages.filter((m) => m.role !== "system");
        const supportsThinking = targetModel.includes('sonnet') || targetModel.includes('opus');
        const requestBody: RequestBody = {
          model: targetModel,
          max_tokens: supportsThinking ? 16000 : 4096,
          stream: true,
          messages: chatMessages,
          tools: anthropicTools,
        };
        if (supportsThinking) {
          requestBody.thinking = { type: 'enabled', budget_tokens: 10000 };
        }
        if (systemMsg) {
          requestBody.system = systemMsg.content;
        }
        return {
          url: `${targetProvider.apiUrl}${targetProvider.endpoint}`,
          headers: targetProvider.headers(targetApiKey),
          body: JSON.stringify(requestBody),
        };
      }

      let finalMessages: Message[] = wireMessages;

      if (targetProvider.local && !targetProvider.supportsToolRole) {
        finalMessages = [];
        const tcNameMap: Record<string, string> = {};
        for (const msg of wireMessages) {
          if (msg.role === 'assistant' && msg.tool_calls) {
            for (const tc of msg.tool_calls) {
              tcNameMap[tc.id] = tc.function?.name || 'unknown';
            }
            const { tool_calls, ...rest } = msg;
            finalMessages.push(rest);
          } else if (msg.role === 'tool') {
            const name = (msg.tool_call_id ? tcNameMap[msg.tool_call_id] : undefined) || 'unknown';
            finalMessages.push({
              role: 'user',
              content: `[Tool Result for ${name}]: ${typeof msg.content === 'string' ? msg.content : String(msg.content)}`,
            });
          } else {
            finalMessages.push(msg);
          }
        }
      }

      const requestBody: RequestBody = {
        model: targetModel,
        messages: finalMessages,
        stream: true,
        max_tokens: 8192,
      };

      if (!targetProvider.local || targetProvider.supportsToolRole) {
        requestBody.tools = toolDefs;
      }

      return {
        url: `${targetProvider.apiUrl}${targetProvider.endpoint}`,
        headers: targetProvider.headers(targetApiKey),
        body: JSON.stringify(requestBody),
      };
    };

    if (resolvedProvider.local) {
      const { url, headers, body } = buildAgentRequest(resolvedProvider);
      const reqBody = parseRequestBody(body);
      const reqMessages = Array.isArray(reqBody.messages) ? reqBody.messages : [];
      const inputChars = JSON.stringify(reqMessages).length;
      const toolCount = Array.isArray(reqBody.tools) ? reqBody.tools.length : 0;
      const totalBodyChars = body.length;
      const msgTokens = estimateMessageTokens(reqMessages);
      const toolTokens = Math.round((totalBodyChars - inputChars) / 4);
      process.stderr.write(`[dotbot] LLM req: ${reqMessages.length} msgs, ${toolCount} tools, ~${msgTokens} tok msgs + ~${toolTokens} tok tools = ~${msgTokens + toolTokens} tok total\n`);
      response = await fetch(url, { method: "POST", headers, body, signal });
      if (!response.ok) {
        const errorEvent: ErrorEvent = { type: "error", error: `${resolvedProvider.name} returned ${response.status}: ${await response.text()}` };
        validateEvent(errorEvent);
        yield errorEvent;
        return;
      }
    } else {
      try {
        const result = await fetchWithFailover({ provider: resolvedProvider, buildRequest: buildAgentRequest, signal });
        response = result.response;
        activeProvider = result.activeProvider;
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
        const msg = err instanceof FailoverError
          ? err.message
          : (err instanceof Error ? err.message : String(err));
        const errorEvent: ErrorEvent = { type: "error", error: msg };
        validateEvent(errorEvent);
        yield errorEvent;
        return;
      }
    }

    if (!response) return;
    let fullContent = "";
    let toolCalls: StreamToolCall[] = [];

    if (activeProvider.id === "anthropic") {
      const result = yield* parseAnthropicStream(response, fullContent, toolCalls, signal, activeProvider.id);
      fullContent = result.fullContent;
      toolCalls = result.toolCalls;
    } else if (activeProvider.id === "local") {
      const gen = parseOpenAIStream(response, fullContent, toolCalls, signal, activeProvider.id);
      let rawBuffer = "";
      let finalMarkerFound = false;
      let lastFinalYieldPos = 0;
      let usesNativeReasoning = false;
      let usesPassthrough = false;
      let analysisStarted = false;
      let analysisEnded = false;
      let lastThinkingYieldPos = 0;
      const ANALYSIS_MARKER = "<|channel|>analysis<|message|>";
      const ANALYSIS_END = "<|end|>";
      const FINAL_MARKER = "<|channel|>final<|message|>";
      const CHANNEL_DETECT_THRESHOLD = 200;

      while (true) {
        const { value, done } = await gen.next();
        if (done) {
          fullContent = value.fullContent;
          toolCalls = value.toolCalls;
          if (!usesPassthrough && !usesNativeReasoning && !analysisStarted && !finalMarkerFound && rawBuffer.length > 0) {
            if (!hasToolCallMarkers(rawBuffer)) {
              const textEvent: TextDeltaEvent = { type: "text_delta", text: rawBuffer };
              validateEvent(textEvent);
              yield textEvent;
            }
          }
          break;
        }

        if (value.type === "thinking") {
          usesNativeReasoning = true;
          yield value;
          continue;
        }

        if (value.type !== "text_delta") {
          yield value;
          continue;
        }

        if (usesNativeReasoning) {
          yield value;
          continue;
        }

        if (usesPassthrough) {
          yield value;
          continue;
        }

        rawBuffer += value.text;

        if (!analysisStarted && !finalMarkerFound && rawBuffer.length > CHANNEL_DETECT_THRESHOLD) {
          console.log("[local] no channel tokens after", rawBuffer.length, "chars — switching to passthrough");
          usesPassthrough = true;
          const textEvent: TextDeltaEvent = { type: "text_delta", text: rawBuffer };
          validateEvent(textEvent);
          yield textEvent;
          continue;
        }

        if (!finalMarkerFound) {
          if (!analysisStarted) {
            const aIdx = rawBuffer.indexOf(ANALYSIS_MARKER);
            if (aIdx !== -1) {
              analysisStarted = true;
              lastThinkingYieldPos = aIdx + ANALYSIS_MARKER.length;
              console.log("[local] analysis marker found at", aIdx, "| yieldPos:", lastThinkingYieldPos);
            }
          }

          if (analysisStarted && !analysisEnded) {
            const endIdx = rawBuffer.indexOf(ANALYSIS_END, lastThinkingYieldPos);
            if (endIdx !== -1) {
              const chunk = rawBuffer.slice(lastThinkingYieldPos, endIdx);
              if (chunk) {
                console.log("[local] thinking (final):", chunk.slice(0, 80));
                const thinkingEvent: ThinkingEvent = {
                  type: "thinking",
                  text: chunk,
                  hasNativeThinking: false,
                };
                validateEvent(thinkingEvent);
                yield thinkingEvent;
              }
              lastThinkingYieldPos = endIdx + ANALYSIS_END.length;
              analysisEnded = true;
            } else {
              const chunk = rawBuffer.slice(lastThinkingYieldPos);
              if (chunk) {
                console.log("[local] thinking (incr):", chunk.slice(0, 80));
                const thinkingEvent: ThinkingEvent = {
                  type: "thinking",
                  text: chunk,
                  hasNativeThinking: false,
                };
                validateEvent(thinkingEvent);
                yield thinkingEvent;
              }
              lastThinkingYieldPos = rawBuffer.length;
            }
          }

          const fIdx = rawBuffer.indexOf(FINAL_MARKER);
          if (fIdx !== -1) {
            console.log("[local] final marker found at", fIdx, "| bufLen:", rawBuffer.length);
            finalMarkerFound = true;
            lastFinalYieldPos = fIdx + FINAL_MARKER.length;
            const pending = rawBuffer.slice(lastFinalYieldPos);
            if (pending) {
              const textEvent: TextDeltaEvent = { type: "text_delta", text: pending };
              validateEvent(textEvent);
              yield textEvent;
              lastFinalYieldPos = rawBuffer.length;
            }
          }
        } else {
          const newText = rawBuffer.slice(lastFinalYieldPos);
          if (newText) {
            const textEvent: TextDeltaEvent = { type: "text_delta", text: newText };
            validateEvent(textEvent);
            yield textEvent;
            lastFinalYieldPos = rawBuffer.length;
          }
        }
      }

      if (!usesNativeReasoning && !usesPassthrough) fullContent = stripGptOssTokens(fullContent);

      if (hasToolCallMarkers(fullContent)) {
        const textToolCalls = parseToolCalls(fullContent);
        if (textToolCalls.length > 0) {
          toolCalls = textToolCalls;
          fullContent = stripToolCallMarkers(fullContent);
        }
      }
    } else {
      const result = yield* parseOpenAIStream(response, fullContent, toolCalls, signal, activeProvider.id);
      fullContent = result.fullContent;
      toolCalls = result.toolCalls;
    }

    if (toolCalls.length > 0) {
      const assistantMsg: Message = {
        role: "assistant",
        content: fullContent || "",
        toolCalls: toolCalls.map((tc): MessageToolCall => {
          let input: JsonObject | string =
            typeof tc.function.arguments === "string" ? tc.function.arguments : toJsonObject(tc.function.arguments);
          if (typeof input === "string") {
            const parsed = parseJsonObject(input);
            if (parsed) input = parsed;
          }
          return {
            id: tc.id,
            name: tc.function.name,
            input,
            status: "pending",
          };
        }),
        _ts: Date.now(),
      };
      messages.push(assistantMsg);

      const assistantToolCalls = assistantMsg.toolCalls ?? [];

      for (let i = 0; i < assistantToolCalls.length; i++) {
        const tc = assistantToolCalls[i];
        if (!tc) continue;
        const tool = tools.find((t) => t.name === tc.name);
        const tcInput: JsonObject = typeof tc.input === "string" ? {} : tc.input;

        const toolStartEvent: ToolStartEvent = { type: "tool_start", name: tc.name, input: tcInput };
        validateEvent(toolStartEvent);
        yield toolStartEvent;

        if (!tool) {
          const errorResult = `Tool "${tc.name}" not found`;
          const toolErrorEvent: ToolErrorEvent = { type: "tool_error", name: tc.name, error: errorResult };
          validateEvent(toolErrorEvent);
          yield toolErrorEvent;
          tc.result = errorResult;
          tc.status = "error";
          continue;
        }

        try {
          const result = await tool.execute(tcInput, signal, context ?? {});
          const resultStr = typeof result === "string" ? result : JSON.stringify(result);

          const toolResultEvent: ToolResultEvent = { type: "tool_result", name: tc.name, input: tcInput, result: resultStr };
          validateEvent(toolResultEvent);
          yield toolResultEvent;

          const parsed = parseJsonObject(resultStr);
          if (parsed && parsed.type === 'image' && parsed.url) {
            const imageEvent: ImageEvent = {
              type: 'image',
              url: typeof parsed.url === 'string' ? parsed.url : String(parsed.url),
              prompt: typeof parsed.prompt === 'string' ? parsed.prompt : '',
            };
            validateEvent(imageEvent);
            yield imageEvent;
          }

          tc.result = resultStr;
          tc.status = "done";
          logEvent('tool_call', {
            tool: tc.name,
            success: true,
            input: tcInput,
            result: resultStr,
          });
        } catch (err) {
          const errMessage = err instanceof Error ? err.message : String(err);
          const errStack = err instanceof Error ? err.stack : undefined;
          const errorResult = `Tool error: ${errMessage}`;
          const toolErrorEvent: ToolErrorEvent = { type: "tool_error", name: tc.name, error: errorResult };
          validateEvent(toolErrorEvent);
          yield toolErrorEvent;
          tc.result = errorResult;
          tc.status = "error";
          logEvent('tool_call', {
            tool: tc.name,
            success: false,
            input: tcInput,
            error: errMessage,
            stack: errStack?.split('\n').slice(0, 5).join('\n'),
          });
        }
      }

      const allDirectReturn = assistantToolCalls.every(tc => {
        const t = tools.find(tool => tool.name === tc.name);
        return t?.directReturn && tc.status === 'done';
      });

      if (allDirectReturn) {
        const combinedResult = assistantToolCalls
          .map(tc => tc.result)
          .join('\n');
        const textEvent: TextDeltaEvent = { type: "text_delta", text: combinedResult };
        validateEvent(textEvent);
        yield textEvent;
        messages.push({ role: "assistant", content: combinedResult, _ts: Date.now() });
        const doneEvent: DoneEvent = { type: "done", content: combinedResult };
        validateEvent(doneEvent);
        yield doneEvent;
        return;
      }

      toolCalls = [];
      fullContent = "";
    } else {
      let followup: string | null = null;
      const followupMatch = fullContent.match(/<followup>([\s\S]*?)<\/followup>/);
      if (followupMatch && followupMatch[1] !== undefined) {
        followup = followupMatch[1].trim();
        fullContent = fullContent.replace(/<followup>[\s\S]*?<\/followup>/, '').trim();
      }

      messages.push({ role: "assistant", content: fullContent, _ts: Date.now() });
      logEvent('message_received', {
        length: fullContent.length,
        content: fullContent,
      });
      if (followup) {
        const followupEvent: FollowupEvent = { type: "followup", text: followup };
        validateEvent(followupEvent);
        yield followupEvent;
      }
      const doneEvent: DoneEvent = { type: "done", content: fullContent };
      validateEvent(doneEvent);
      yield doneEvent;
      return;
    }
  }

  const maxIterEvent: MaxIterationsEvent = { type: "max_iterations", message: `I've reached my reasoning limit (${maxIterations} steps). You can send another message to continue.` };
  validateEvent(maxIterEvent);
  yield maxIterEvent;
}

async function* parseOpenAIStream(
  response: Response,
  fullContent: string,
  toolCalls: StreamToolCall[],
  signal: AbortSignal | undefined,
  providerId: string | undefined,
): AsyncGenerator<AgentEvent, StreamResult, unknown> {
  if (!response.body) return { fullContent, toolCalls };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const toolCallMap: Record<number, StreamToolCall> = {};

  while (true) {
    if (signal?.aborted) {
      await reader.cancel();
      break;
    }
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]" || !data) continue;

      const chunk = parseOpenAIChunk(data);
      if (!chunk) continue;
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;

      const reasoning = delta.reasoning_content || delta.reasoning;
      if (reasoning) {
        const thinkingEvent: ThinkingEvent = {
          type: "thinking",
          text: reasoning,
          hasNativeThinking: true,
        };
        validateEvent(thinkingEvent);
        yield thinkingEvent;
      }

      if (delta.content) {
        const isToolMarker = delta.content.includes('<|tool_call>') || delta.content.includes('<tool_call|>');
        if (!isToolMarker) {
          fullContent += delta.content;
          const textEvent: TextDeltaEvent = { type: "text_delta", text: delta.content };
          validateEvent(textEvent);
          yield textEvent;
        }
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          let entry = toolCallMap[idx];
          if (!entry) {
            entry = {
              id: tc.id || `call_${idx}`,
              function: { name: "", arguments: "" },
            };
            toolCallMap[idx] = entry;
          }
          if (tc.id) entry.id = tc.id;
          if (tc.function?.name) entry.function.name += tc.function.name;
          if (tc.function?.arguments && typeof entry.function.arguments === "string") {
            entry.function.arguments += tc.function.arguments;
          }
        }
      }

      if (chunk.choices?.[0]?.finish_reason) {
        if (chunk.usage) {
          const statsEvent = normalizeStatsEvent({
            model: chunk.model ?? "",
            prompt_tokens: chunk.usage.prompt_tokens,
            completion_tokens: chunk.usage.completion_tokens,
          }, providerId || 'openai');
          validateEvent(statsEvent);
          yield statsEvent;
        }
      }
    }
  }

  toolCalls = Object.values(toolCallMap).map((tc): StreamToolCall => {
    let args: string | JsonValue = tc.function.arguments;
    if (typeof args === "string") {
      try {
        args = toJsonValue(JSON.parse(args));
      } catch {
      }
    }
    return { id: tc.id, function: { name: tc.function.name, arguments: args } };
  });

  return { fullContent, toolCalls };
}

async function* parseAnthropicStream(
  response: Response,
  fullContent: string,
  toolCalls: StreamToolCall[],
  signal: AbortSignal | undefined,
  providerId: string | undefined,
): AsyncGenerator<AgentEvent, StreamResult, unknown> {
  if (!response.body) return { fullContent, toolCalls };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const contentBlocks: Record<number, AnthropicContentBlock> = {};

  while (true) {
    if (signal?.aborted) {
      await reader.cancel();
      break;
    }
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data) continue;

      const event = parseAnthropicEvent(data);
      if (!event) continue;

      if (event.type === "content_block_start") {
        const block = event.content_block;
        const idx = event.index ?? 0;
        if (block?.type === "tool_use") {
          contentBlocks[idx] = {
            type: "tool_use",
            id: block.id,
            name: block.name,
            inputJson: "",
          };
        } else if (block?.type === "thinking") {
          contentBlocks[idx] = { type: "thinking", text: "" };
        } else if (block?.type === "text") {
          contentBlocks[idx] = { type: "text", text: "" };
        }
      }

      if (event.type === "content_block_delta") {
        const idx = event.index ?? 0;
        const delta = event.delta;
        const current = contentBlocks[idx];
        if (delta?.type === "thinking_delta") {
          if (current && current.type !== "tool_use") current.text += delta.thinking ?? "";
          const thinkingEvent: ThinkingEvent = {
            type: "thinking",
            text: delta.thinking ?? "",
            hasNativeThinking: true,
          };
          validateEvent(thinkingEvent);
          yield thinkingEvent;
        } else if (delta?.type === "text_delta") {
          fullContent += delta.text ?? "";
          if (current && current.type !== "tool_use") current.text += delta.text ?? "";
          const textEvent: TextDeltaEvent = { type: "text_delta", text: delta.text ?? "" };
          validateEvent(textEvent);
          yield textEvent;
        } else if (delta?.type === "input_json_delta") {
          if (current && current.type === "tool_use") current.inputJson += delta.partial_json ?? "";
        }
      }

      if (event.type === "message_delta") {
        if (event.usage) {
          const statsEvent = normalizeStatsEvent({
            model: event.model || "",
            input_tokens: event.usage.input_tokens,
            output_tokens: event.usage.output_tokens,
          }, providerId || 'anthropic');
          validateEvent(statsEvent);
          yield statsEvent;
        }
      }
    }
  }

  toolCalls = Object.values(contentBlocks)
    .filter((b): b is Extract<AnthropicContentBlock, { type: "tool_use" }> => b.type === "tool_use")
    .map((b): StreamToolCall => {
      let args: JsonValue = {};
      try {
        args = toJsonValue(JSON.parse(b.inputJson));
      } catch {
      }
      return { id: b.id ?? "", function: { name: b.name ?? "", arguments: args } };
    });

  return { fullContent, toolCalls };
}

interface OllamaModelInfo {
  name: string;
  size: number;
  modified: string;
}

interface OllamaStatus {
  running: boolean;
  models: OllamaModelInfo[];
}

export async function getOllamaStatus(): Promise<OllamaStatus> {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`);
    if (!res.ok) return { running: false, models: [] };
    const data: unknown = await res.json();
    const root = recordOf(data);
    const rawModels = root && Array.isArray(root.models) ? root.models : [];
    return {
      running: true,
      models: rawModels.map((m): OllamaModelInfo => {
        const rec = recordOf(m);
        return {
          name: asString(rec?.name) ?? "",
          size: asNumber(rec?.size) ?? 0,
          modified: asString(rec?.modified_at) ?? "",
        };
      }),
    };
  } catch {
    return { running: false, models: [] };
  }
}

function stripGptOssTokens(text: string): string {
  const FINAL_RE = /<\|channel\|>final<\|message\|>([\s\S]*)$/;
  const TOKEN_RE = /<\|[^|]*\|>/g;

  const finalMatch = text.match(FINAL_RE);
  if (finalMatch && finalMatch[1] !== undefined) {
    return finalMatch[1].replace(TOKEN_RE, "").trim();
  }
  return text.replace(TOKEN_RE, "").trim();
}

interface LocalModelInfo {
  name: string;
}

interface LocalStatus {
  running: boolean;
  models: LocalModelInfo[];
}

export async function getMlxLocalStatus(): Promise<LocalStatus> {
  const baseUrl = (process.env.LOCAL_LLM_URL || 'http://localhost:1316/v1').replace(/\/v1$/, '');
  try {
    const res = await fetch(`${baseUrl}/v1/models`);
    if (!res.ok) return { running: false, models: [] };
    const data: unknown = await res.json();
    const root = recordOf(data);
    const rawModels = root && Array.isArray(root.data) ? root.data : [];
    const models = rawModels.map((m): LocalModelInfo => {
      const rec = recordOf(m);
      return { name: asString(rec?.id) ?? "" };
    });
    return { running: true, models };
  } catch {
    return { running: false, models: [] };
  }
}

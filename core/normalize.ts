// core/normalize.js
// Standardize message formats across providers (Anthropic, OpenAI, xAI, Ollama).
// Provides bidirectional conversion between provider-specific formats and a
// unified schema that apps can consume without coupling to provider quirks.

import type {
  Message,
  MessageToolCall,
  ContentBlock,
  ProviderFormat,
  WireToolCall,
  JsonObject,
} from "../types.js";

/** Result content stored on a tool call: a string, or an Anthropic content-block array. */
type ToolResultContent = string | ContentBlock[];

/**
 * A standard-format tool call as produced by toStandardFormat(). Identical to
 * the shared MessageToolCall except `result` is widened to also allow an
 * Anthropic content-block array (the raw value carried on a tool_result block),
 * and `name` may be undefined when a malformed provider message omits it.
 */
interface StdToolCall extends Omit<MessageToolCall, "result" | "name"> {
  name?: string;
  result?: ToolResultContent;
}

/** A standard-format message with the widened tool-call result type. */
interface StdMessage extends Omit<Message, "toolCalls"> {
  toolCalls?: StdToolCall[];
}

/** Shape of a parsed image tool result (type:"image" with a url). */
interface ImageToolResult {
  type: "image";
  url: string;
  prompt?: string;
}

/** Parse a JSON string to an unknown record, or null if not a JSON object. */
function parseJsonObject(text: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    const record: Record<string, unknown> = {};
    for (const key of Object.keys(parsed)) {
      record[key] = Reflect.get(parsed, key);
    }
    return record;
  }
  return null;
}

/** Narrow a parsed JSON object to an image tool result. */
function asImageResult(obj: Record<string, unknown> | null): ImageToolResult | null {
  if (obj && obj.type === "image" && typeof obj.url === "string") {
    return {
      type: "image",
      url: obj.url,
      prompt: typeof obj.prompt === "string" ? obj.prompt : undefined,
    };
  }
  return null;
}

/**
 * Standard message schema (provider-agnostic):
 *
 * User message:
 * {
 *   role: "user",
 *   content: string,
 *   _ts?: number
 * }
 *
 * Assistant message:
 * {
 *   role: "assistant",
 *   content: string,
 *   toolCalls?: [{ id, name, input, result?, status: "pending"|"done"|"error" }],
 *   thinking?: string,
 *   images?: [{ url, prompt }],
 *   _ts?: number
 * }
 *
 * System message:
 * {
 *   role: "system",
 *   content: string
 * }
 */

/**
 * Convert provider-specific messages to standard format.
 * Collapses assistant + tool_result pairs into single messages with toolCalls array.
 *
 * @param messages - Raw messages in Anthropic or OpenAI format
 * @returns Normalized messages in standard format
 */
export function toStandardFormat(messages: Message[]): StdMessage[] {
  // Build tool result lookup (tool_use_id/tool_call_id → result content)
  const toolResults = new Map<string, ToolResultContent>();

  for (const msg of messages) {
    // Anthropic tool results (role: user, content: [{type: "tool_result", ...}])
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_result' && block.tool_use_id !== undefined && block.content !== undefined) {
          toolResults.set(block.tool_use_id, block.content);
        }
      }
    }
    // OpenAI tool results (role: tool)
    if (msg.role === 'tool' && msg.tool_call_id) {
      toolResults.set(msg.tool_call_id, msg.content);
    }
  }

  const normalized: StdMessage[] = [];

  for (const msg of messages) {
    // Skip tool-result-only user messages (Anthropic)
    if (msg.role === 'user' && Array.isArray(msg.content) &&
        msg.content.length > 0 && msg.content.every(b => b.type === 'tool_result')) {
      continue;
    }
    // Skip OpenAI tool messages
    if (msg.role === 'tool') continue;

    // System messages
    if (msg.role === 'system') {
      normalized.push({ role: 'system', content: msg.content });
      continue;
    }

    // User messages
    if (msg.role === 'user') {
      normalized.push({
        role: 'user',
        content: typeof msg.content === 'string' ? msg.content : '',
        ...(msg._ts && { _ts: msg._ts })
      });
      continue;
    }

    // Assistant messages
    if (msg.role === 'assistant') {
      const standard: StdMessage = {
        role: 'assistant',
        content: '',
        ...(msg._ts && { _ts: msg._ts })
      };

      // OpenAI format (string content + tool_calls array)
      if (!Array.isArray(msg.content)) {
        standard.content = typeof msg.content === 'string' ? msg.content : '';

        if (msg.tool_calls) {
          standard.toolCalls = msg.tool_calls.map((tc): StdToolCall => {
            const result = toolResults.get(tc.id);
            let input: JsonObject | string = {};
            try {
              const parsedArgs: unknown = JSON.parse(tc.function?.arguments || '{}');
              if (typeof parsedArgs === 'object' && parsedArgs !== null && !Array.isArray(parsedArgs)) {
                input = { ...parsedArgs };
              }
            } catch {}

            const toolCall: StdToolCall = {
              id: tc.id,
              name: tc.function?.name,
              input,
              status: 'done'
            };

            if (result !== undefined) {
              toolCall.result = result;
              // Check if result is an image
              if (typeof result === 'string') {
                const image = asImageResult(parseJsonObject(result));
                if (image) {
                  if (!standard.images) standard.images = [];
                  standard.images.push({ url: image.url, prompt: image.prompt });
                }
              }
            }

            return toolCall;
          });
        }
      }
      // Anthropic format (content block array)
      else {
        const toolCalls: StdToolCall[] = [];
        let textContent = typeof standard.content === 'string' ? standard.content : '';

        for (const block of msg.content) {
          if (block.type === 'text') {
            textContent += block.text;
            standard.content = textContent;
          }
          else if (block.type === 'tool_use') {
            const result = toolResults.get(block.id ?? '');
            const toolCall: StdToolCall = {
              id: block.id ?? '',
              name: block.name,
              input: block.input || {},
              status: 'done'
            };

            if (result !== undefined) {
              toolCall.result = result;
              // Check if result is an image
              if (typeof result === 'string') {
                const image = asImageResult(parseJsonObject(result));
                if (image) {
                  if (!standard.images) standard.images = [];
                  standard.images.push({ url: image.url, prompt: image.prompt });
                }
              }
            }

            toolCalls.push(toolCall);
          }
          else if (block.type === 'thinking') {
            standard.thinking = (standard.thinking || '') + (block.thinking || '');
          }
        }

        if (toolCalls.length > 0) {
          standard.toolCalls = toolCalls;
        }
      }

      // Clean up empty arrays
      if (standard.toolCalls?.length === 0) delete standard.toolCalls;
      if (standard.images?.length === 0) delete standard.images;

      normalized.push(standard);
    }
  }

  // Merge consecutive assistant messages (collapse tool-call phases)
  const merged: StdMessage[] = [];
  for (const msg of normalized) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === 'assistant' && msg.role === 'assistant') {
      // Merge toolCalls
      if (prev.toolCalls?.length) {
        msg.toolCalls = [...prev.toolCalls, ...(msg.toolCalls || [])];
      }
      // Merge thinking
      if (prev.thinking) {
        msg.thinking = (prev.thinking || '') + (msg.thinking || '');
      }
      // Merge images
      if (prev.images?.length) {
        msg.images = [...(prev.images || []), ...(msg.images || [])];
      }
      // Keep first content if current is empty
      if (!msg.content && prev.content) {
        msg.content = prev.content;
      }
      // Keep earlier timestamp
      if (prev._ts && !msg._ts) {
        msg._ts = prev._ts;
      }
      merged[merged.length - 1] = msg;
    } else {
      merged.push(msg);
    }
  }

  return merged;
}

/**
 * Convert standard format messages to provider-specific format.
 * Splits assistant messages with toolCalls into separate assistant + tool_result messages.
 *
 * @param messages - Normalized messages in standard format
 * @param targetFormat - Target provider format ("anthropic" | "openai")
 * @returns Messages in provider-specific format
 */
export function toProviderFormat(messages: StdMessage[], targetFormat: ProviderFormat): Message[] {
  const result: Message[] = [];

  for (const msg of messages) {
    // System and user messages stay the same
    if (msg.role === 'system' || msg.role === 'user') {
      const { toolCalls: _toolCalls, ...rest } = msg;
      result.push({ ...rest });
      continue;
    }

    // Assistant messages with tool calls
    if (msg.role === 'assistant') {
      if (targetFormat === 'anthropic') {
        // Anthropic: content block array
        const contentBlocks: ContentBlock[] = [];

        if (msg.content && typeof msg.content === 'string') {
          contentBlocks.push({ type: 'text', text: msg.content });
        }

        if (msg.thinking) {
          contentBlocks.push({ type: 'thinking', thinking: msg.thinking });
        }

        const toolUses: { id: string; result?: ToolResultContent }[] = [];
        if (msg.toolCalls) {
          for (const tc of msg.toolCalls) {
            const block: ContentBlock = {
              type: 'tool_use',
              id: tc.id,
              name: tc.name,
            };
            if (typeof tc.input !== 'string') {
              block.input = tc.input;
            }
            contentBlocks.push(block);
            toolUses.push({ id: tc.id, result: tc.result });
          }
        }

        result.push({
          role: 'assistant',
          content: contentBlocks,
          ...(msg._ts && { _ts: msg._ts })
        });

        // Add tool results as separate user message
        if (toolUses.length > 0) {
          result.push({
            role: 'user',
            content: toolUses.map(tu => ({
              type: 'tool_result',
              tool_use_id: tu.id,
              content: tu.result || ''
            }))
          });
        }
      }
      else {
        // OpenAI: string content + tool_calls array
        const assistantMsg: Message = {
          role: 'assistant',
          content: msg.content || '',
          ...(msg._ts && { _ts: msg._ts })
        };

        if (msg.toolCalls) {
          assistantMsg.tool_calls = msg.toolCalls.map((tc): WireToolCall => ({
            id: tc.id,
            type: 'function',
            function: {
              name: tc.name ?? '',
              arguments: typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input)
            }
          }));
        }

        result.push(assistantMsg);

        // Add tool results as separate tool messages
        if (msg.toolCalls) {
          for (const tc of msg.toolCalls) {
            if (tc.result !== undefined) {
              result.push({
                role: 'tool',
                tool_call_id: tc.id,
                content: tc.result
              });
            }
          }
        }
      }
    }
  }

  return result;
}

/**
 * Normalize messages for frontend display.
 * Alias for toStandardFormat() for backward compatibility.
 *
 * @param messages - Raw provider-specific messages
 * @returns Normalized messages
 */
export function normalizeMessages(messages: Message[]): StdMessage[] {
  return toStandardFormat(messages);
}


import type {
  Message,
  MessageToolCall,
  ContentBlock,
  ProviderFormat,
  WireToolCall,
  JsonObject,
} from "../types.js";

type ToolResultContent = string | ContentBlock[];

interface StdToolCall extends Omit<MessageToolCall, "result" | "name"> {
  name?: string;
  result?: ToolResultContent;
}

interface StdMessage extends Omit<Message, "toolCalls"> {
  toolCalls?: StdToolCall[];
}

interface ImageToolResult {
  type: "image";
  url: string;
  prompt?: string;
}

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

export function toStandardFormat(messages: Message[]): StdMessage[] {
  const toolResults = new Map<string, ToolResultContent>();

  for (const msg of messages) {
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_result' && block.tool_use_id !== undefined && block.content !== undefined) {
          toolResults.set(block.tool_use_id, block.content);
        }
      }
    }
    if (msg.role === 'tool' && msg.tool_call_id) {
      toolResults.set(msg.tool_call_id, msg.content);
    }
  }

  const normalized: StdMessage[] = [];

  for (const msg of messages) {
    if (msg.role === 'user' && Array.isArray(msg.content) &&
        msg.content.length > 0 && msg.content.every(b => b.type === 'tool_result')) {
      continue;
    }
    if (msg.role === 'tool') continue;

    if (msg.role === 'system') {
      normalized.push({ role: 'system', content: msg.content });
      continue;
    }

    if (msg.role === 'user') {
      normalized.push({
        role: 'user',
        content: typeof msg.content === 'string' ? msg.content : '',
        ...(msg._ts && { _ts: msg._ts })
      });
      continue;
    }

    if (msg.role === 'assistant') {
      const standard: StdMessage = {
        role: 'assistant',
        content: '',
        ...(msg._ts && { _ts: msg._ts })
      };

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

      if (standard.toolCalls?.length === 0) delete standard.toolCalls;
      if (standard.images?.length === 0) delete standard.images;

      normalized.push(standard);
    }
  }

  const merged: StdMessage[] = [];
  for (const msg of normalized) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === 'assistant' && msg.role === 'assistant') {
      if (prev.toolCalls?.length) {
        msg.toolCalls = [...prev.toolCalls, ...(msg.toolCalls || [])];
      }
      if (prev.thinking) {
        msg.thinking = (prev.thinking || '') + (msg.thinking || '');
      }
      if (prev.images?.length) {
        msg.images = [...(prev.images || []), ...(msg.images || [])];
      }
      if (!msg.content && prev.content) {
        msg.content = prev.content;
      }
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

export function toProviderFormat(messages: StdMessage[], targetFormat: ProviderFormat): Message[] {
  const result: Message[] = [];

  for (const msg of messages) {
    if (msg.role === 'system' || msg.role === 'user') {
      const { toolCalls: _toolCalls, ...rest } = msg;
      result.push({ ...rest });
      continue;
    }

    if (msg.role === 'assistant') {
      if (targetFormat === 'anthropic') {
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

export function normalizeMessages(messages: Message[]): StdMessage[] {
  return toStandardFormat(messages);
}

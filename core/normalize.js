// core/normalize.js
// Standardize message formats across providers (Anthropic, OpenAI, xAI, Ollama).
// Provides bidirectional conversion between provider-specific formats and a
// unified schema that apps can consume without coupling to provider quirks.

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
 * @param {Array} messages - Raw messages in Anthropic or OpenAI format
 * @returns {Array} Normalized messages in standard format
 */
export function toStandardFormat(messages) {
  // Build tool result lookup (tool_use_id/tool_call_id → result content)
  const toolResults = new Map();

  for (const msg of messages) {
    // Anthropic tool results (role: user, content: [{type: "tool_result", ...}])
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_result') {
          toolResults.set(block.tool_use_id, block.content);
        }
      }
    }
    // OpenAI tool results (role: tool)
    if (msg.role === 'tool' && msg.tool_call_id) {
      toolResults.set(msg.tool_call_id, msg.content);
    }
  }

  const normalized = [];

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
      const standard = {
        role: 'assistant',
        content: '',
        ...(msg._ts && { _ts: msg._ts })
      };

      // OpenAI format (string content + tool_calls array)
      if (!Array.isArray(msg.content)) {
        standard.content = typeof msg.content === 'string' ? msg.content : '';

        if (msg.tool_calls) {
          standard.toolCalls = msg.tool_calls.map(tc => {
            const result = toolResults.get(tc.id);
            let input = {};
            try {
              input = JSON.parse(tc.function?.arguments || '{}');
            } catch {}

            const toolCall = {
              id: tc.id,
              name: tc.function?.name,
              input,
              status: 'done'
            };

            if (result !== undefined) {
              toolCall.result = result;
              // Check if result is an image
              try {
                const parsed = JSON.parse(result);
                if (parsed.type === 'image' && parsed.url) {
                  if (!standard.images) standard.images = [];
                  standard.images.push({ url: parsed.url, prompt: parsed.prompt });
                }
              } catch {}
            }

            return toolCall;
          });
        }
      }
      // Anthropic format (content block array)
      else {
        const toolCalls = [];

        for (const block of msg.content) {
          if (block.type === 'text') {
            standard.content += block.text;
          }
          else if (block.type === 'tool_use') {
            const result = toolResults.get(block.id);
            const toolCall = {
              id: block.id,
              name: block.name,
              input: block.input || {},
              status: 'done'
            };

            if (result !== undefined) {
              toolCall.result = result;
              // Check if result is an image
              try {
                const parsed = JSON.parse(result);
                if (parsed.type === 'image' && parsed.url) {
                  if (!standard.images) standard.images = [];
                  standard.images.push({ url: parsed.url, prompt: parsed.prompt });
                }
              } catch {}
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
  const merged = [];
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
 * @param {Array} messages - Normalized messages in standard format
 * @param {"anthropic"|"openai"} targetFormat - Target provider format
 * @returns {Array} Messages in provider-specific format
 */
export function toProviderFormat(messages, targetFormat) {
  const result = [];

  for (const msg of messages) {
    // System and user messages stay the same
    if (msg.role === 'system' || msg.role === 'user') {
      result.push({ ...msg });
      continue;
    }

    // Assistant messages with tool calls
    if (msg.role === 'assistant') {
      if (targetFormat === 'anthropic') {
        // Anthropic: content block array
        const contentBlocks = [];

        if (msg.content) {
          contentBlocks.push({ type: 'text', text: msg.content });
        }

        if (msg.thinking) {
          contentBlocks.push({ type: 'thinking', thinking: msg.thinking });
        }

        const toolUses = [];
        if (msg.toolCalls) {
          for (const tc of msg.toolCalls) {
            contentBlocks.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.name,
              input: tc.input
            });
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
        const assistantMsg = {
          role: 'assistant',
          content: msg.content || null,
          ...(msg._ts && { _ts: msg._ts })
        };

        if (msg.toolCalls) {
          assistantMsg.tool_calls = msg.toolCalls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: {
              name: tc.name,
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
 * @param {Array} messages - Raw provider-specific messages
 * @returns {Array} Normalized messages
 */
export function normalizeMessages(messages) {
  return toStandardFormat(messages);
}

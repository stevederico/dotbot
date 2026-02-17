// core/compaction.js
// Session auto-compaction: summarizes old messages when context nears provider limits.
// Runs before trimMessages as an intelligent alternative to hard truncation.

import { AI_PROVIDERS } from "../utils/providers.js";

/** Max context window tokens per provider family. */
const CONTEXT_LIMITS = {
  anthropic: 180000,
  openai: 120000,
  xai: 120000,
  ollama: 6000,
  dottie_desktop: 6000,
};

/** Number of recent messages to always preserve verbatim. */
const RECENT_TO_KEEP = 20;

/** Compaction triggers when estimated tokens exceed this fraction of the context limit. */
const COMPACT_THRESHOLD = 0.7;

/** Cheapest model per provider, used for summarization calls. */
const CHEAP_MODELS = {
  xai: "grok-4-1-fast-non-reasoning",
  anthropic: "claude-3-5-haiku-20241022",
  openai: "gpt-5-nano",
};

/**
 * Estimate token count for an array of messages.
 *
 * Uses a 4-chars-per-token heuristic. Handles both string content,
 * Anthropic content block arrays, and OpenAI tool_calls.
 *
 * @param {Array} messages - Conversation messages in any provider format.
 * @returns {number} Estimated token count.
 */
export function estimateTokens(messages) {
  let chars = 0;

  for (const msg of messages) {
    if (typeof msg.content === "string") {
      chars += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      // Anthropic content blocks
      for (const block of msg.content) {
        if (block.type === "text" && block.text) {
          chars += block.text.length;
        } else if (block.type === "tool_use") {
          chars += (block.name || "").length;
          chars += JSON.stringify(block.input || {}).length;
        } else if (block.type === "tool_result") {
          chars += (typeof block.content === "string" ? block.content : JSON.stringify(block.content || "")).length;
        } else if (block.type === "thinking" && block.thinking) {
          chars += block.thinking.length;
        }
      }
    }

    // OpenAI tool_calls on assistant messages
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        chars += (tc.function?.name || "").length;
        chars += (tc.function?.arguments || "").length;
      }
    }
  }

  return Math.ceil(chars / 4);
}

/**
 * Naive fallback summary when no AI provider is available.
 *
 * Extracts the first 100 characters of each user message and tool result,
 * producing a bullet-point summary.
 *
 * @param {Array} messages - Old messages to summarize.
 * @returns {string} Plain-text summary.
 */
function naiveSummary(messages) {
  const lines = [];

  for (const msg of messages) {
    if (msg.role === "user" && typeof msg.content === "string") {
      lines.push(`- User: ${msg.content.slice(0, 100)}`);
    } else if (msg.role === "assistant") {
      // Extract tool results from Anthropic format
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "tool_use") {
            lines.push(`- Tool: ${block.name}`);
          }
        }
      }
      // Extract tool results from OpenAI format
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          lines.push(`- Tool: ${tc.function?.name}`);
        }
      }
    } else if (msg.role === "tool" && typeof msg.content === "string") {
      lines.push(`- Result: ${msg.content.slice(0, 100)}`);
    }
  }

  return lines.length > 0
    ? lines.join("\n")
    : "Previous conversation context (details unavailable).";
}

/**
 * Summarize old messages using the cheapest available AI provider.
 *
 * Checks env keys in order: XAI_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY.
 * Falls back to naiveSummary() if no provider is configured.
 *
 * @param {Array} oldMessages - Messages to summarize.
 * @param {Object} [options={}]
 * @param {AbortSignal} [options.signal] - Optional abort signal.
 * @returns {Promise<string>} Summary text.
 */
async function summarizeMessages(oldMessages, { signal } = {}) {
  // Build plain-text transcript from old messages
  const transcript = oldMessages
    .map((msg) => {
      const role = msg.role || "unknown";
      let text = "";
      if (typeof msg.content === "string") {
        text = msg.content;
      } else if (Array.isArray(msg.content)) {
        text = msg.content
          .map((b) => {
            if (b.type === "text") return b.text;
            if (b.type === "tool_use") return `[tool: ${b.name}]`;
            if (b.type === "tool_result") return `[result: ${typeof b.content === "string" ? b.content.slice(0, 200) : "..."}]`;
            return "";
          })
          .filter(Boolean)
          .join(" ");
      }
      return `${role}: ${text}`;
    })
    .join("\n");

  // Find cheapest available provider from injected providers
  const providerOrder = ["xai", "anthropic", "openai"];

  let selectedProvider = null;
  let selectedModel = null;
  let apiKey = null;
  for (const id of providerOrder) {
    if (providers[id]?.apiKey) {
      selectedProvider = AI_PROVIDERS[id];
      selectedModel = CHEAP_MODELS[id];
      apiKey = providers[id].apiKey;
      break;
    }
  }

  if (!selectedProvider || !apiKey) {
    return naiveSummary(oldMessages);
  }

  const summaryPrompt =
    "Summarize this conversation concisely. Preserve: key decisions, user facts, tool results, and any important outcomes. Omit: greetings, thinking steps, redundant tool calls. Output only the summary, no preamble.";

  try {
    const isAnthropic = selectedProvider.id === "anthropic";

    let url, headers, body;

    if (isAnthropic) {
      url = `${selectedProvider.apiUrl}${selectedProvider.endpoint}`;
      headers = selectedProvider.headers(apiKey);
      body = JSON.stringify({
        model: selectedModel,
        max_tokens: 1024,
        messages: [
          { role: "user", content: `${summaryPrompt}\n\n---\n${transcript}` },
        ],
      });
    } else {
      url = `${selectedProvider.apiUrl}${selectedProvider.endpoint}`;
      headers = selectedProvider.headers(apiKey);
      body = JSON.stringify({
        model: selectedModel,
        max_tokens: 1024,
        messages: [
          { role: "system", content: summaryPrompt },
          { role: "user", content: transcript },
        ],
      });
    }

    const res = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal,
    });

    if (!res.ok) {
      console.error(`[compaction] summarization failed (${res.status}), using naive fallback`);
      return naiveSummary(oldMessages);
    }

    const data = await res.json();
    const text = selectedProvider.formatResponse(data);
    return text || naiveSummary(oldMessages);
  } catch (err) {
    if (err.name === "AbortError") throw err;
    console.error("[compaction] summarization error, using naive fallback:", err.message);
    return naiveSummary(oldMessages);
  }
}

/**
 * Compact a conversation's messages if approaching the provider's context limit.
 *
 * Splits messages into [system prompt] + [old messages] + [recent N messages],
 * summarizes old messages via the cheapest AI provider, and returns a compacted
 * array. If under the threshold, returns the original messages unchanged.
 *
 * @param {Array} messages - Full conversation history including system prompt.
 * @param {Object} [options={}]
 * @param {string} [options.providerId='ollama'] - Provider ID for context limit lookup.
 * @param {AbortSignal} [options.signal] - Optional abort signal.
 * @param {Object} [options.providers] - Provider configuration with API keys: { anthropic: { apiKey }, openai: { apiKey }, xai: { apiKey } }
 * @returns {Promise<{messages: Array, compacted: boolean}>} Compacted result.
 */
export async function compactMessages(messages, { providerId = "ollama", signal, providers = {} } = {}) {
  const tokens = estimateTokens(messages);
  const limit = CONTEXT_LIMITS[providerId] || CONTEXT_LIMITS.ollama;

  if (tokens < limit * COMPACT_THRESHOLD) {
    return { messages, compacted: false };
  }

  // Need at least system + RECENT_TO_KEEP + 1 old message to compact
  if (messages.length <= RECENT_TO_KEEP + 2) {
    return { messages, compacted: false };
  }

  const systemPrompt = messages[0];
  const recent = messages.slice(-RECENT_TO_KEEP);
  const old = messages.slice(1, messages.length - RECENT_TO_KEEP);

  if (old.length === 0) {
    return { messages, compacted: false };
  }

  console.log(`[compaction] ${tokens} tokens (~${Math.round((tokens / limit) * 100)}% of ${providerId} limit), compacting ${old.length} old messages`);

  const summary = await summarizeMessages(old, { signal });

  const summaryMessage = {
    role: "user",
    content: `[Context Summary]\n${summary}`,
    _compaction: true,
    _ts: Date.now(),
  };

  return {
    messages: [systemPrompt, summaryMessage, ...recent],
    compacted: true,
  };
}

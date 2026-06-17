// core/compaction.js
// Session auto-compaction: summarizes old messages when context nears provider limits.
// Runs before trimMessages as an intelligent alternative to hard truncation.
// Operates on standard-format messages (see normalize.js).

/// <reference types="node" />

import { AI_PROVIDERS } from "../utils/providers.js";
import { toStandardFormat, toProviderFormat } from "./normalize.js";
import type {
  Message,
  Provider,
  ProvidersMap,
  ProviderFormat,
} from "../types.js";

/** Options for summarizeMessages(). */
interface SummarizeOptions {
  signal?: AbortSignal;
  providers?: ProvidersMap;
}

/** Options for compactMessages(). */
interface CompactOptions {
  providerId?: string;
  signal?: AbortSignal;
  providers?: ProvidersMap;
}

/** Result of compactMessages(). */
interface CompactResult {
  messages: Message[];
  compacted: boolean;
}

/** Summarization request body sent to the provider's chat endpoint. */
interface SummaryRequestBody {
  model: string;
  max_tokens: number;
  system?: string;
  messages: Message[];
}

/** A compaction summary message — a standard user message flagged with _compaction. */
interface CompactionSummaryMessage extends Message {
  _compaction: true;
}

/** Max context window tokens per provider family. */
const CONTEXT_LIMITS: Record<string, number> = {
  anthropic: 180000,
  openai: 120000,
  xai: 120000,
  ollama: 6000,
  local: 6000,
};

/** Number of recent messages to always preserve verbatim. */
const RECENT_TO_KEEP = 20;

/** Compaction triggers when estimated tokens exceed this fraction of the context limit. */
const COMPACT_THRESHOLD = 0.7;

/** Cheapest model per provider, used for summarization calls. */
const CHEAP_MODELS: Record<string, string> = {
  xai: "grok-4-1-fast-non-reasoning",
  anthropic: "claude-3-5-haiku-20241022",
  openai: "gpt-5-nano",
};

/**
 * Estimate token count for an array of standard-format messages.
 *
 * Uses a 4-chars-per-token heuristic. Counts content, toolCalls
 * (name + input + result), and thinking fields.
 *
 * @param messages - Conversation messages in standard format.
 * @returns Estimated token count.
 */
export function estimateTokens(messages: Message[]): number {
  let chars = 0;

  for (const msg of messages) {
    if (typeof msg.content === "string") {
      chars += msg.content.length;
    }

    if (msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        chars += (tc.name || "").length;
        chars += JSON.stringify(tc.input || {}).length;
        if (tc.result) {
          chars += (typeof tc.result === "string" ? tc.result : JSON.stringify(tc.result)).length;
        }
      }
    }

    if (msg.thinking) {
      chars += msg.thinking.length;
    }
  }

  return Math.ceil(chars / 4);
}

/**
 * Naive fallback summary when no AI provider is available.
 *
 * Extracts the first 100 characters of each user message, tool call names,
 * and tool results, producing a bullet-point summary.
 *
 * @param messages - Standard-format messages to summarize.
 * @returns Plain-text summary.
 */
function naiveSummary(messages: Message[]): string {
  const lines: string[] = [];

  for (const msg of messages) {
    if (msg.role === "user" && msg.content && typeof msg.content === "string") {
      lines.push(`- User: ${msg.content.slice(0, 100)}`);
    } else if (msg.role === "assistant") {
      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          lines.push(`- Tool: ${tc.name}`);
          if (tc.result) {
            const resultStr = typeof tc.result === "string" ? tc.result : JSON.stringify(tc.result);
            lines.push(`- Result: ${resultStr.slice(0, 100)}`);
          }
        }
      }
    }
  }

  return lines.length > 0
    ? lines.join("\n")
    : "Previous conversation context (details unavailable).";
}

/**
 * Summarize old messages using the cheapest available AI provider.
 *
 * Checks provider keys in order: xAI, Anthropic, OpenAI.
 * Falls back to naiveSummary() if no provider is configured.
 * Messages are expected in standard format; converted to provider format for the API call.
 *
 * @param oldMessages - Standard-format messages to summarize.
 * @param options.signal - Optional abort signal.
 * @param options.providers - Provider config with API keys.
 * @returns Summary text.
 */
async function summarizeMessages(
  oldMessages: Message[],
  { signal, providers = {} }: SummarizeOptions = {},
): Promise<string> {
  // Build plain-text transcript from standard-format messages
  const transcript = oldMessages
    .map((msg) => {
      const role = msg.role || "unknown";
      const parts: string[] = [];

      if (msg.content && typeof msg.content === "string") {
        parts.push(msg.content);
      }

      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          parts.push(`[tool: ${tc.name}]`);
          if (tc.result) {
            const resultStr = typeof tc.result === "string" ? tc.result : JSON.stringify(tc.result);
            parts.push(`[result: ${resultStr.slice(0, 200)}]`);
          }
        }
      }

      return `${role}: ${parts.join(" ")}`;
    })
    .join("\n");

  // Find cheapest available provider
  const providerOrder = ["xai", "anthropic", "openai"];

  let selectedProvider: Provider | null = null;
  let selectedModel: string | null = null;
  let apiKey: string | null = null;
  for (const id of providerOrder) {
    const key = providers[id]?.apiKey;
    if (key) {
      selectedProvider = AI_PROVIDERS[id] ?? null;
      selectedModel = CHEAP_MODELS[id] ?? null;
      apiKey = key;
      break;
    }
  }

  if (!selectedProvider || !apiKey || !selectedModel) {
    return naiveSummary(oldMessages);
  }

  const summaryPrompt =
    "Summarize this conversation concisely. Preserve: key decisions, user facts, tool results, and any important outcomes. Omit: greetings, thinking steps, redundant tool calls. Output only the summary, no preamble.";

  // Build summarization request in standard format, then convert for the provider
  const summaryMessages: Message[] = [
    { role: "system", content: summaryPrompt },
    { role: "user", content: transcript },
  ];

  const targetFormat: ProviderFormat = selectedProvider.id === "anthropic" ? "anthropic" : "openai";
  const providerMessages = toProviderFormat(summaryMessages, targetFormat);

  // Anthropic doesn't support system role in messages — use top-level system param
  let requestBody: SummaryRequestBody;
  if (targetFormat === "anthropic") {
    requestBody = {
      model: selectedModel,
      max_tokens: 1024,
      system: summaryPrompt,
      messages: providerMessages.filter((m) => m.role !== "system"),
    };
  } else {
    requestBody = {
      model: selectedModel,
      max_tokens: 1024,
      messages: providerMessages,
    };
  }

  try {
    const url = `${selectedProvider.apiUrl}${selectedProvider.endpoint}`;
    const headers = selectedProvider.headers(apiKey);

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
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
    if (err instanceof Error && err.name === "AbortError") throw err;
    console.error("[compaction] summarization error, using naive fallback:", err instanceof Error ? err.message : String(err));
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
 * @param messages - Full conversation history including system prompt.
 * @param options.providerId - Provider ID for context limit lookup (default 'ollama').
 * @param options.signal - Optional abort signal.
 * @param options.providers - Provider configuration with API keys: { anthropic: { apiKey }, openai: { apiKey }, xai: { apiKey } }
 * @returns Compacted result.
 */
export async function compactMessages(
  messages: Message[],
  { providerId = "ollama", signal, providers = {} }: CompactOptions = {},
): Promise<CompactResult> {
  const tokens = estimateTokens(messages);
  const limit = CONTEXT_LIMITS[providerId] || CONTEXT_LIMITS.ollama || 6000;

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

  if (old.length === 0 || !systemPrompt) {
    return { messages, compacted: false };
  }

  console.log(`[compaction] ${tokens} tokens (~${Math.round((tokens / limit) * 100)}% of ${providerId} limit), compacting ${old.length} old messages`);

  const summary = await summarizeMessages(old, { signal, providers });

  const summaryMessage: CompactionSummaryMessage = {
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

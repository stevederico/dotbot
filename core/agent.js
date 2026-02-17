// agent/agent.js
// Provider-agnostic agent loop. Supports OpenAI-compatible providers
// (OpenAI, xAI, Ollama) and Anthropic via separate code paths.

import { AI_PROVIDERS } from "../utils/providers.js";
import { fetchWithFailover, FailoverError } from "./failover.js";

const OLLAMA_BASE = "http://localhost:11434";

/**
 * Run the agent loop. Yields events for streaming to the frontend.
 *
 * Events yielded:
 * - { type: "text_delta", text } — incremental text from the model
 * - { type: "tool_start", name, input } — tool call initiated
 * - { type: "tool_result", name, result } — tool call completed
 * - { type: "tool_error", name, error } — tool call failed
 * - { type: "stats", model, eval_count, eval_duration, total_duration }
 * - { type: "done", content } — final answer, loop complete
 * - { type: "max_iterations", message } — agent hit the iteration safety cap
 * - { type: "thinking" } — agent is reasoning about tool results (iteration > 1)
 * - { type: "error", error } — fatal error
 *
 * @param {Object} options
 * @param {string} options.model - Model name (e.g. "llama3.3", "grok-3", "claude-sonnet-4-5")
 * @param {Array} options.messages - Conversation history
 * @param {Array} options.tools - Tool definitions from tools.js
 * @param {AbortSignal} [options.signal] - Optional abort signal
 * @param {Object} [options.provider] - Provider config from AI_PROVIDERS. Defaults to Ollama.
 * @param {Object} [options.context] - Execution context passed to tool execute functions (e.g. databaseManager, dbConfig, userID).
 * @yields {Object} Stream events for the frontend
 */
export async function* agentLoop({ model, messages, tools, signal, provider, context }) {
  // Default to Ollama for backward compat (cron, etc.)
  if (!provider) {
    provider = AI_PROVIDERS.ollama;
  }

  const maxIterations = 10;
  let iteration = 0;

  while (iteration < maxIterations) {
    iteration++;
    yield { type: "thinking" };

    // Build tool definitions in the format the provider expects
    const toolDefs = tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));

    let response;
    let activeProvider = provider;

    /**
     * Build a fetch request for a given target provider.
     * Handles Anthropic vs OpenAI-compatible format differences.
     * @param {Object} targetProvider - Provider config from AI_PROVIDERS.
     * @returns {{url: string, headers: Object, body: string}}
     */
    const buildAgentRequest = (targetProvider) => {
      const targetApiKey = targetProvider.envKey ? process.env[targetProvider.envKey] : null;
      const targetIsAnthropic = targetProvider.id === "anthropic";

      if (targetIsAnthropic) {
        const anthropicTools = tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters,
        }));
        const systemMsg = messages.find((m) => m.role === "system");
        const chatMessages = messages.filter((m) => m.role !== "system");
        const targetModel = targetProvider === provider ? model : targetProvider.defaultModel;
        const supportsThinking = targetModel.includes('sonnet') || targetModel.includes('opus');
        const requestBody = {
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

      // OpenAI-compatible path
      return {
        url: `${targetProvider.apiUrl}${targetProvider.endpoint}`,
        headers: targetProvider.headers(targetApiKey),
        body: JSON.stringify({
          model: targetProvider === provider ? model : targetProvider.defaultModel,
          messages,
          tools: toolDefs,
          stream: true,
        }),
      };
    };

    // Local providers (ollama, dottie_desktop): direct fetch, no failover
    if (provider.local) {
      const { url, headers, body } = buildAgentRequest(provider);
      response = await fetch(url, { method: "POST", headers, body, signal });
      if (!response.ok) {
        yield { type: "error", error: `${provider.name} returned ${response.status}: ${await response.text()}` };
        return;
      }
    } else {
      try {
        const result = await fetchWithFailover({ provider, buildRequest: buildAgentRequest, signal });
        response = result.response;
        activeProvider = result.activeProvider;
      } catch (err) {
        if (err.name === 'AbortError') return;
        const msg = err instanceof FailoverError
          ? `All providers failed: ${err.attempts.map(a => `${a.provider}(${a.status})`).join(', ')}`
          : err.message;
        yield { type: "error", error: msg };
        return;
      }
    }

    // Update format flag if failover switched provider families
    const useAnthropicFormat = activeProvider.id === "anthropic";

    // Stream parsing — two paths depending on provider format
    let fullContent = "";
    let toolCalls = [];

    if (useAnthropicFormat) {
      // Anthropic SSE format: content_block_start, content_block_delta, content_block_stop, message_delta
      const result = yield* parseAnthropicStream(response, fullContent, toolCalls, signal);
      fullContent = result.fullContent;
      toolCalls = result.toolCalls;
    } else if (activeProvider.id === "dottie_desktop") {
      // Dottie Desktop serves gpt-oss which may use either:
      // 1. delta.reasoning field (native reasoning) — handled by parseOpenAIStream
      // 2. Channel tokens in delta.content — parsed here
      // Detect which format by checking if thinking events arrive from the parser.
      const gen = parseOpenAIStream(response, fullContent, toolCalls, signal);
      let rawBuffer = "";
      let finalMarkerFound = false;
      let lastFinalYieldPos = 0;
      let usesNativeReasoning = false;
      let analysisStarted = false;
      let analysisEnded = false;
      let lastThinkingYieldPos = 0;
      const ANALYSIS_MARKER = "<|channel|>analysis<|message|>";
      const ANALYSIS_END = "<|end|>";
      const FINAL_MARKER = "<|channel|>final<|message|>";

      while (true) {
        const { value, done } = await gen.next();
        if (done) {
          fullContent = value.fullContent;
          toolCalls = value.toolCalls;
          break;
        }

        // If parseOpenAIStream yields thinking events, the model uses native reasoning —
        // pass everything through directly (no channel token parsing needed).
        if (value.type === "thinking") {
          usesNativeReasoning = true;
          yield value;
          continue;
        }

        if (value.type !== "text_delta") {
          yield value;
          continue;
        }

        // Native reasoning mode: pass text_delta through directly
        if (usesNativeReasoning) {
          yield value;
          continue;
        }

        // Channel token mode: buffer and parse markers, stream thinking incrementally
        rawBuffer += value.text;

        if (!finalMarkerFound) {
          // Detect analysis channel start
          if (!analysisStarted) {
            const aIdx = rawBuffer.indexOf(ANALYSIS_MARKER);
            if (aIdx !== -1) {
              analysisStarted = true;
              lastThinkingYieldPos = aIdx + ANALYSIS_MARKER.length;
              console.log("[dottie_desktop] analysis marker found at", aIdx, "| yieldPos:", lastThinkingYieldPos);
            }
          }

          // Stream thinking text incrementally while inside analysis channel
          if (analysisStarted && !analysisEnded) {
            const endIdx = rawBuffer.indexOf(ANALYSIS_END, lastThinkingYieldPos);
            if (endIdx !== -1) {
              const chunk = rawBuffer.slice(lastThinkingYieldPos, endIdx);
              if (chunk) {
                console.log("[dottie_desktop] thinking (final):", chunk.slice(0, 80));
                yield { type: "thinking", text: chunk };
              }
              lastThinkingYieldPos = endIdx + ANALYSIS_END.length;
              analysisEnded = true;
            } else {
              const chunk = rawBuffer.slice(lastThinkingYieldPos);
              if (chunk) {
                console.log("[dottie_desktop] thinking (incr):", chunk.slice(0, 80));
                yield { type: "thinking", text: chunk };
              }
              lastThinkingYieldPos = rawBuffer.length;
            }
          }

          // Check for final channel marker
          const fIdx = rawBuffer.indexOf(FINAL_MARKER);
          if (fIdx !== -1) {
            console.log("[dottie_desktop] final marker found at", fIdx, "| bufLen:", rawBuffer.length);
            finalMarkerFound = true;
            lastFinalYieldPos = fIdx + FINAL_MARKER.length;
            const pending = rawBuffer.slice(lastFinalYieldPos);
            if (pending) {
              yield { type: "text_delta", text: pending };
              lastFinalYieldPos = rawBuffer.length;
            }
          }
        } else {
          // In final channel — yield incremental text
          const newText = rawBuffer.slice(lastFinalYieldPos);
          if (newText) {
            yield { type: "text_delta", text: newText };
            lastFinalYieldPos = rawBuffer.length;
          }
        }
      }

      // Clean fullContent for persistence (strip channel tokens)
      if (!usesNativeReasoning) fullContent = stripGptOssTokens(fullContent);
    } else {
      // OpenAI-compatible SSE format (Ollama, OpenAI, xAI)
      const result = yield* parseOpenAIStream(response, fullContent, toolCalls, signal);
      fullContent = result.fullContent;
      toolCalls = result.toolCalls;
    }

    // Check if the model wants to call tools
    if (toolCalls.length > 0) {
      if (useAnthropicFormat) {
        // Anthropic: assistant message has content blocks
        const contentBlocks = [];
        if (fullContent) {
          contentBlocks.push({ type: "text", text: fullContent });
        }
        for (const tc of toolCalls) {
          contentBlocks.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function.name,
            input: tc.function.arguments,
          });
        }
        messages.push({ role: "assistant", content: contentBlocks, _ts: Date.now() });
      } else {
        // OpenAI-compatible: tool_calls array on assistant message
        messages.push({
          role: "assistant",
          content: fullContent || null,
          _ts: Date.now(),
          tool_calls: toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: {
              name: tc.function.name,
              arguments: typeof tc.function.arguments === "string"
                ? tc.function.arguments
                : JSON.stringify(tc.function.arguments),
            },
          })),
        });
      }

      // Execute each tool
      for (const call of toolCalls) {
        const toolName = call.function.name;
        let toolInput = call.function.arguments;

        // Parse arguments if they're a JSON string
        if (typeof toolInput === "string") {
          try {
            toolInput = JSON.parse(toolInput);
          } catch {
            // Keep as string if not valid JSON
          }
        }

        const tool = tools.find((t) => t.name === toolName);

        yield { type: "tool_start", name: toolName, input: toolInput };

        if (!tool) {
          const errorResult = `Tool "${toolName}" not found`;
          yield { type: "tool_error", name: toolName, error: errorResult };
          if (useAnthropicFormat) {
            messages.push({
              role: "user",
              content: [{ type: "tool_result", tool_use_id: call.id, content: errorResult }],
            });
          } else {
            messages.push({ role: "tool", tool_call_id: call.id, content: errorResult });
          }
          continue;
        }

        try {
          const result = await tool.execute(toolInput, signal, context);
          const resultStr = typeof result === "string" ? result : JSON.stringify(result);

          yield { type: "tool_result", name: toolName, input: toolInput, result: resultStr };

          if (useAnthropicFormat) {
            messages.push({
              role: "user",
              content: [{ type: "tool_result", tool_use_id: call.id, content: resultStr }],
            });
          } else {
            messages.push({ role: "tool", tool_call_id: call.id, content: resultStr });
          }
        } catch (err) {
          const errorResult = `Tool error: ${err.message}`;
          yield { type: "tool_error", name: toolName, error: errorResult };
          if (useAnthropicFormat) {
            messages.push({
              role: "user",
              content: [{ type: "tool_result", tool_use_id: call.id, content: errorResult, is_error: true }],
            });
          } else {
            messages.push({ role: "tool", tool_call_id: call.id, content: errorResult });
          }
        }
      }

      toolCalls = [];
      fullContent = "";
    } else {
      // Extract follow-up suggestion before persisting
      let followup = null;
      const followupMatch = fullContent.match(/<followup>([\s\S]*?)<\/followup>/);
      if (followupMatch) {
        followup = followupMatch[1].trim();
        fullContent = fullContent.replace(/<followup>[\s\S]*?<\/followup>/, '').trim();
      }

      // Persist the cleaned text response so saveSession() includes it
      if (useAnthropicFormat) {
        messages.push({ role: "assistant", content: [{ type: "text", text: fullContent }], _ts: Date.now() });
      } else {
        messages.push({ role: "assistant", content: fullContent, _ts: Date.now() });
      }
      if (followup) {
        yield { type: "followup", text: followup };
      }
      yield { type: "done", content: fullContent };
      return;
    }
  }

  yield { type: "max_iterations", message: "I've reached my reasoning limit (10 steps). You can send another message to continue." };
}

/**
 * Parse an OpenAI-compatible SSE stream (works with Ollama, OpenAI, xAI).
 *
 * Tool calls arrive incrementally across chunks via delta.tool_calls with index-based assembly.
 *
 * @param {Response} response - Fetch response with SSE body
 * @param {string} fullContent - Accumulated text content (passed by reference via return)
 * @param {Array} toolCalls - Accumulated tool calls (passed by reference via return)
 * @param {AbortSignal} [signal] - Optional abort signal to cancel the reader
 * @yields {Object} text_delta events
 * @returns {{ fullContent: string, toolCalls: Array }}
 */
async function* parseOpenAIStream(response, fullContent, toolCalls, signal) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const toolCallMap = {};

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

      try {
        const chunk = JSON.parse(data);
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;

        // Reasoning/thinking content (gpt-oss, DeepSeek, etc.)
        const reasoning = delta.reasoning_content || delta.reasoning;
        if (reasoning) {
          yield { type: "thinking", text: reasoning };
        }

        // Text content
        if (delta.content) {
          fullContent += delta.content;
          yield { type: "text_delta", text: delta.content };
        }

        // Tool calls — assembled incrementally by index
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!toolCallMap[idx]) {
              toolCallMap[idx] = {
                id: tc.id || `call_${idx}`,
                function: { name: "", arguments: "" },
              };
            }
            if (tc.id) toolCallMap[idx].id = tc.id;
            if (tc.function?.name) toolCallMap[idx].function.name += tc.function.name;
            if (tc.function?.arguments) toolCallMap[idx].function.arguments += tc.function.arguments;
          }
        }

        // Finish reason — check for stats if present
        if (chunk.choices?.[0]?.finish_reason) {
          // Some providers include usage stats
          if (chunk.usage) {
            yield {
              type: "stats",
              model: chunk.model,
              prompt_tokens: chunk.usage.prompt_tokens,
              completion_tokens: chunk.usage.completion_tokens,
            };
          }
        }
      } catch {
        // Skip malformed JSON
      }
    }
  }

  // Parse accumulated tool call arguments from JSON strings to objects
  toolCalls = Object.values(toolCallMap).map((tc) => {
    let args = tc.function.arguments;
    try {
      args = JSON.parse(args);
    } catch {
      // Keep as string
    }
    return { id: tc.id, function: { name: tc.function.name, arguments: args } };
  });

  return { fullContent, toolCalls };
}

/**
 * Parse an Anthropic SSE stream.
 *
 * Tool calls arrive via content_block_start (type: "tool_use") + content_block_delta (input_json_delta).
 *
 * @param {Response} response - Fetch response with SSE body
 * @param {string} fullContent - Accumulated text content
 * @param {Array} toolCalls - Accumulated tool calls
 * @param {AbortSignal} [signal] - Optional abort signal to cancel the reader
 * @yields {Object} text_delta events
 * @returns {{ fullContent: string, toolCalls: Array }}
 */
async function* parseAnthropicStream(response, fullContent, toolCalls, signal) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const contentBlocks = {};

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

      try {
        const event = JSON.parse(data);

        if (event.type === "content_block_start") {
          const block = event.content_block;
          const idx = event.index;
          if (block.type === "tool_use") {
            contentBlocks[idx] = {
              type: "tool_use",
              id: block.id,
              name: block.name,
              inputJson: "",
            };
          } else if (block.type === "thinking") {
            contentBlocks[idx] = { type: "thinking", text: "" };
          } else if (block.type === "text") {
            contentBlocks[idx] = { type: "text", text: "" };
          }
        }

        if (event.type === "content_block_delta") {
          const idx = event.index;
          const delta = event.delta;
          if (delta.type === "thinking_delta") {
            if (contentBlocks[idx]) contentBlocks[idx].text += delta.thinking;
            yield { type: "thinking", text: delta.thinking };
          } else if (delta.type === "text_delta") {
            fullContent += delta.text;
            if (contentBlocks[idx]) contentBlocks[idx].text += delta.text;
            yield { type: "text_delta", text: delta.text };
          } else if (delta.type === "input_json_delta") {
            if (contentBlocks[idx]) contentBlocks[idx].inputJson += delta.partial_json;
          }
        }

        if (event.type === "message_delta") {
          if (event.usage) {
            yield {
              type: "stats",
              model: event.model || "",
              input_tokens: event.usage.input_tokens,
              output_tokens: event.usage.output_tokens,
            };
          }
        }
      } catch {
        // Skip malformed JSON
      }
    }
  }

  // Assemble tool calls from content blocks
  toolCalls = Object.values(contentBlocks)
    .filter((b) => b.type === "tool_use")
    .map((b) => {
      let args = {};
      try {
        args = JSON.parse(b.inputJson);
      } catch {
        // Empty or malformed
      }
      return { id: b.id, function: { name: b.name, arguments: args } };
    });

  return { fullContent, toolCalls };
}

/**
 * Check if Ollama is running and list available models.
 *
 * @returns {Promise<{running: boolean, models: Array<{name: string, size: number, modified: string}>}>}
 */
export async function getOllamaStatus() {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`);
    if (!res.ok) return { running: false, models: [] };
    const data = await res.json();
    return {
      running: true,
      models: data.models.map((m) => ({
        name: m.name,
        size: m.size,
        modified: m.modified_at,
      })),
    };
  } catch {
    return { running: false, models: [] };
  }
}

/**
 * Check if Dottie Desktop is running and list available models.
 * Uses the OpenAI-compatible /v1/models endpoint.
 *
 * @returns {Promise<{running: boolean, models: Array<{name: string}>}>}
 */
/**
 * Strip gpt-oss channel tokens and extract only the final response content.
 * If the text has a "final" channel, returns only that content.
 * Otherwise strips all `<|...|>` tokens and returns the cleaned text.
 *
 * @param {string} text - Raw model output with channel tokens
 * @returns {string} Cleaned text with tokens removed
 */
function stripGptOssTokens(text) {
  const FINAL_RE = /<\|channel\|>final<\|message\|>([\s\S]*)$/;
  const TOKEN_RE = /<\|[^|]*\|>/g;

  const finalMatch = text.match(FINAL_RE);
  if (finalMatch) {
    return finalMatch[1].replace(TOKEN_RE, "").trim();
  }
  // No channel markers — strip all tokens as fallback
  return text.replace(TOKEN_RE, "").trim();
}

export async function getDottieDesktopStatus() {
  const baseUrl = (process.env.DOTTIE_DESKTOP_URL || 'http://localhost:1316/v1').replace(/\/v1$/, '');
  try {
    const res = await fetch(`${baseUrl}/v1/models`);
    if (!res.ok) return { running: false, models: [] };
    const data = await res.json();
    const models = (data.data || []).map((m) => ({ name: m.id }));
    return { running: true, models };
  } catch {
    return { running: false, models: [] };
  }
}

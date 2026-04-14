// agent/agent.js
// Provider-agnostic agent loop. All conversation history is stored in a
// standard format (see normalize.js). Provider-specific wire formats are
// produced just-in-time inside buildAgentRequest() via toProviderFormat().

import { AI_PROVIDERS } from "../utils/providers.js";
import { fetchWithFailover, FailoverError } from "./failover.js";
import { toProviderFormat } from "./normalize.js";
import { validateEvent, normalizeStatsEvent } from "./events.js";
import { hasToolCallMarkers, parseToolCalls, stripToolCallMarkers } from "./gptoss_tool_parser.js";

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
 * @param {Object} [options.context] - Execution context passed to tool execute functions (e.g. providers, userID).
 * @yields {Object} Stream events for the frontend
 */
export async function* agentLoop({ model, messages, tools, signal, provider, context, maxTurns }) {
  // Default to Ollama for backward compat (cron, etc.)
  if (!provider) {
    provider = AI_PROVIDERS.ollama;
  }

  // Helper to log events (fire-and-forget, non-blocking)
  const logEvent = (type, data = {}) => {
    if (context?.eventStore && context?.userID) {
      context.eventStore.logEvent({
        userId: context.userID,
        type,
        data,
      }).catch(() => {}); // Swallow errors to avoid breaking the agent loop
    }
  };

  // Log message_sent for the latest user message (first iteration only)
  const lastUserMsg = messages.filter(m => m.role === 'user').slice(-1)[0];
  if (lastUserMsg) {
    const content = typeof lastUserMsg.content === 'string'
      ? lastUserMsg.content
      : JSON.stringify(lastUserMsg.content);
    // Full audit log: capture complete message content for debugging
    logEvent('message_sent', { length: content.length, content });
  }

  const maxIterations = maxTurns || 10;
  let iteration = 0;

  while (iteration < maxIterations) {
    iteration++;

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
     * Messages are stored in standard format and converted to provider-specific
     * wire format just-in-time here via toProviderFormat().
     * @param {Object} targetProvider - Provider config from AI_PROVIDERS.
     * @returns {{url: string, headers: Object, body: string}}
     */
    const buildAgentRequest = (targetProvider) => {
      const targetApiKey = targetProvider.envKey ? process.env[targetProvider.envKey] : null;
      const targetIsAnthropic = targetProvider.id === "anthropic";
      const targetModel = targetProvider === provider ? model : targetProvider.defaultModel;

      // JIT conversion: standard format → provider wire format
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
      let finalMessages = wireMessages;

      // Local providers use text-based tool calls via system prompt, so convert
      // role:"tool" messages to role:"user" and strip tool_calls from assistant
      // messages — unless the model's chat template supports role:"tool" natively
      // (e.g. LFM2.5). Models that support it set supportsToolRole on the provider.
      if (targetProvider.local && !targetProvider.supportsToolRole) {
        finalMessages = [];
        const tcNameMap = {};
        for (const msg of wireMessages) {
          if (msg.role === 'assistant' && msg.tool_calls) {
            for (const tc of msg.tool_calls) {
              tcNameMap[tc.id] = tc.function?.name || 'unknown';
            }
            const { tool_calls, ...rest } = msg;
            finalMessages.push(rest);
          } else if (msg.role === 'tool') {
            const name = tcNameMap[msg.tool_call_id] || 'unknown';
            finalMessages.push({
              role: 'user',
              content: `[Tool Result for ${name}]: ${msg.content}`,
            });
          } else {
            finalMessages.push(msg);
          }
        }
      }

      const requestBody = {
        model: targetModel,
        messages: finalMessages,
        stream: true,
        max_tokens: 8192,
      };

      // Include tool definitions for non-local providers and local providers
      // that support native tool calling (e.g., GLM-4.7 via local LLM server v0.30.7+)
      if (!targetProvider.local || targetProvider.supportsToolRole) {
        requestBody.tools = toolDefs;
      }

      return {
        url: `${targetProvider.apiUrl}${targetProvider.endpoint}`,
        headers: targetProvider.headers(targetApiKey),
        body: JSON.stringify(requestBody),
      };
    };

    // Local providers (ollama, local): direct fetch, no failover
    if (provider.local) {
      const { url, headers, body } = buildAgentRequest(provider);
      response = await fetch(url, { method: "POST", headers, body, signal });
      if (!response.ok) {
        const errorEvent = { type: "error", error: `${provider.name} returned ${response.status}: ${await response.text()}` };
        validateEvent(errorEvent);
        yield errorEvent;
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
        const errorEvent = { type: "error", error: msg };
        validateEvent(errorEvent);
        yield errorEvent;
        return;
      }
    }

    // Stream parsing — two paths depending on provider wire format
    let fullContent = "";
    let toolCalls = [];

    if (activeProvider.id === "anthropic") {
      // Anthropic SSE format: content_block_start, content_block_delta, content_block_stop, message_delta
      const result = yield* parseAnthropicStream(response, fullContent, toolCalls, signal, activeProvider.id);
      fullContent = result.fullContent;
      toolCalls = result.toolCalls;
    } else if (activeProvider.id === "local") {
      // Local OpenAI-compatible server. Models served this way
      // may emit output in one of three formats:
      // 1. gpt-oss channel tokens (<|channel|>analysis/final<|message|>)
      // 2. Native reasoning (delta.reasoning from parseOpenAIStream)
      // 3. Plain text (LFM2.5, SmolLM, etc. — no special tokens)
      // Detect format by buffering initial tokens and checking for markers.
      const gen = parseOpenAIStream(response, fullContent, toolCalls, signal, activeProvider.id);
      let rawBuffer = "";
      let finalMarkerFound = false;
      let lastFinalYieldPos = 0;
      let usesNativeReasoning = false;
      let usesPassthrough = false; // Models without channel tokens (LFM, SmolLM, etc.)
      let analysisStarted = false;
      let analysisEnded = false;
      let lastThinkingYieldPos = 0;
      const ANALYSIS_MARKER = "<|channel|>analysis<|message|>";
      const ANALYSIS_END = "<|end|>";
      const FINAL_MARKER = "<|channel|>final<|message|>";
      const CHANNEL_DETECT_THRESHOLD = 200; // chars before assuming no channel tokens

      while (true) {
        const { value, done } = await gen.next();
        if (done) {
          fullContent = value.fullContent;
          toolCalls = value.toolCalls;
          // Flush buffered plain-text responses that never hit the
          // CHANNEL_DETECT_THRESHOLD. Happens for short greetings and
          // small-talk from models that don't emit gpt-oss channel tokens
          // (Gemma 4 E2B, LFM2.5, SmolLM, etc.). Without this flush, the
          // rawBuffer is silently discarded and the downstream consumer
          // never receives any text_delta — the UI renders an empty bubble.
          // Skip if the buffer contains tool call markers so the existing
          // post-loop parseToolCalls() below can handle them.
          if (!usesPassthrough && !usesNativeReasoning && !analysisStarted && !finalMarkerFound && rawBuffer.length > 0) {
            if (!hasToolCallMarkers(rawBuffer)) {
              const textEvent = { type: "text_delta", text: rawBuffer };
              validateEvent(textEvent);
              yield textEvent;
            }
          }
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

        // Passthrough mode: model doesn't use channel tokens, stream directly
        if (usesPassthrough) {
          yield value;
          continue;
        }

        // Channel token mode: buffer and parse markers, stream thinking incrementally
        rawBuffer += value.text;

        // Fallback: if enough text accumulated without any channel token,
        // the model doesn't use gpt-oss format (e.g. LFM2.5, SmolLM).
        // Flush buffer and switch to passthrough for remaining tokens.
        if (!analysisStarted && !finalMarkerFound && rawBuffer.length > CHANNEL_DETECT_THRESHOLD) {
          console.log("[local] no channel tokens after", rawBuffer.length, "chars — switching to passthrough");
          usesPassthrough = true;
          const textEvent = { type: "text_delta", text: rawBuffer };
          validateEvent(textEvent);
          yield textEvent;
          continue;
        }

        if (!finalMarkerFound) {
          // Detect analysis channel start
          if (!analysisStarted) {
            const aIdx = rawBuffer.indexOf(ANALYSIS_MARKER);
            if (aIdx !== -1) {
              analysisStarted = true;
              lastThinkingYieldPos = aIdx + ANALYSIS_MARKER.length;
              console.log("[local] analysis marker found at", aIdx, "| yieldPos:", lastThinkingYieldPos);
            }
          }

          // Stream thinking text incrementally while inside analysis channel
          if (analysisStarted && !analysisEnded) {
            const endIdx = rawBuffer.indexOf(ANALYSIS_END, lastThinkingYieldPos);
            if (endIdx !== -1) {
              const chunk = rawBuffer.slice(lastThinkingYieldPos, endIdx);
              if (chunk) {
                console.log("[local] thinking (final):", chunk.slice(0, 80));
                const thinkingEvent = {
                  type: "thinking",
                  text: chunk,
                  hasNativeThinking: false, // Channel token simulation
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
                const thinkingEvent = {
                  type: "thinking",
                  text: chunk,
                  hasNativeThinking: false, // Channel token simulation
                };
                validateEvent(thinkingEvent);
                yield thinkingEvent;
              }
              lastThinkingYieldPos = rawBuffer.length;
            }
          }

          // Check for final channel marker
          const fIdx = rawBuffer.indexOf(FINAL_MARKER);
          if (fIdx !== -1) {
            console.log("[local] final marker found at", fIdx, "| bufLen:", rawBuffer.length);
            finalMarkerFound = true;
            lastFinalYieldPos = fIdx + FINAL_MARKER.length;
            const pending = rawBuffer.slice(lastFinalYieldPos);
            if (pending) {
              const textEvent = { type: "text_delta", text: pending };
              validateEvent(textEvent);
              yield textEvent;
              lastFinalYieldPos = rawBuffer.length;
            }
          }
        } else {
          // In final channel — yield incremental text
          const newText = rawBuffer.slice(lastFinalYieldPos);
          if (newText) {
            const textEvent = { type: "text_delta", text: newText };
            validateEvent(textEvent);
            yield textEvent;
            lastFinalYieldPos = rawBuffer.length;
          }
        }
      }

      // Clean fullContent for persistence (strip channel tokens)
      if (!usesNativeReasoning && !usesPassthrough) fullContent = stripGptOssTokens(fullContent);

      // Detect text-based tool calls from <tool_call> markers in model output.
      // Models without native tool_calls support emit tool invocations as text
      // when instructed via system prompt.
      if (hasToolCallMarkers(fullContent)) {
        const textToolCalls = parseToolCalls(fullContent);
        if (textToolCalls.length > 0) {
          toolCalls = textToolCalls;
          fullContent = stripToolCallMarkers(fullContent);
        }
      }
    } else {
      // OpenAI-compatible SSE format (Ollama, OpenAI, xAI)
      const result = yield* parseOpenAIStream(response, fullContent, toolCalls, signal, activeProvider.id);
      fullContent = result.fullContent;
      toolCalls = result.toolCalls;
    }

    // Check if the model wants to call tools
    if (toolCalls.length > 0) {
      // Standard format: single assistant message with toolCalls array.
      // toProviderFormat() splits this into the wire format each provider expects.
      const assistantMsg = {
        role: "assistant",
        content: fullContent || "",
        toolCalls: toolCalls.map((tc) => {
          let input = tc.function.arguments;
          if (typeof input === "string") {
            try { input = JSON.parse(input); } catch {}
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

      // Execute each tool and update the standard-format toolCalls in place.
      // No separate tool-result messages — results are stored on the toolCall object.
      // toProviderFormat() will expand these into the wire format at request time.
      for (let i = 0; i < assistantMsg.toolCalls.length; i++) {
        const tc = assistantMsg.toolCalls[i];
        const tool = tools.find((t) => t.name === tc.name);

        const toolStartEvent = { type: "tool_start", name: tc.name, input: tc.input };
        validateEvent(toolStartEvent);
        yield toolStartEvent;

        if (!tool) {
          const errorResult = `Tool "${tc.name}" not found`;
          const toolErrorEvent = { type: "tool_error", name: tc.name, error: errorResult };
          validateEvent(toolErrorEvent);
          yield toolErrorEvent;
          tc.result = errorResult;
          tc.status = "error";
          continue;
        }

        try {
          const result = await tool.execute(tc.input, signal, context);
          const resultStr = typeof result === "string" ? result : JSON.stringify(result);

          const toolResultEvent = { type: "tool_result", name: tc.name, input: tc.input, result: resultStr };
          validateEvent(toolResultEvent);
          yield toolResultEvent;

          // Check if the result is an image and emit additional image event
          try {
            const parsed = JSON.parse(resultStr);
            if (parsed.type === 'image' && parsed.url) {
              const imageEvent = { type: 'image', url: parsed.url, prompt: parsed.prompt || '' };
              validateEvent(imageEvent);
              yield imageEvent;
            }
          } catch {
            // Not JSON or not an image result, continue
          }

          tc.result = resultStr;
          tc.status = "done";
          // Full audit log: capture tool input and output for debugging
          logEvent('tool_call', {
            tool: tc.name,
            success: true,
            input: tc.input,
            result: resultStr,
          });
        } catch (err) {
          const errorResult = `Tool error: ${err.message}`;
          const toolErrorEvent = { type: "tool_error", name: tc.name, error: errorResult };
          validateEvent(toolErrorEvent);
          yield toolErrorEvent;
          tc.result = errorResult;
          tc.status = "error";
          // Full audit log: capture tool input and error for debugging
          logEvent('tool_call', {
            tool: tc.name,
            success: false,
            input: tc.input,
            error: err.message,
            stack: err.stack?.split('\n').slice(0, 5).join('\n'),
          });
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

      // Standard format: plain string content, no provider-specific wrapping
      messages.push({ role: "assistant", content: fullContent, _ts: Date.now() });
      // Full audit log: capture complete response content for debugging
      logEvent('message_received', {
        length: fullContent.length,
        content: fullContent,
      });
      if (followup) {
        const followupEvent = { type: "followup", text: followup };
        validateEvent(followupEvent);
        yield followupEvent;
      }
      const doneEvent = { type: "done", content: fullContent };
      validateEvent(doneEvent);
      yield doneEvent;
      return;
    }
  }

  const maxIterEvent = { type: "max_iterations", message: `I've reached my reasoning limit (${maxIterations} steps). You can send another message to continue.` };
  validateEvent(maxIterEvent);
  yield maxIterEvent;
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
 * @param {string} [providerId] - Provider ID for stats normalization
 * @yields {Object} text_delta events
 * @returns {{ fullContent: string, toolCalls: Array }}
 */
async function* parseOpenAIStream(response, fullContent, toolCalls, signal, providerId) {
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
          const thinkingEvent = {
            type: "thinking",
            text: reasoning,
            hasNativeThinking: true, // Native reasoning from provider
          };
          validateEvent(thinkingEvent);
          yield thinkingEvent;
        }

        // Text content — suppress native tool call markers (e.g. Gemma's
        // <|tool_call>...<tool_call|> format) since we parse the structured
        // tool_calls from the same chunk instead.
        if (delta.content) {
          const isToolMarker = delta.content.includes('<|tool_call>') || delta.content.includes('<tool_call|>');
          if (!isToolMarker) {
            fullContent += delta.content;
            const textEvent = { type: "text_delta", text: delta.content };
            validateEvent(textEvent);
            yield textEvent;
          }
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
            const statsEvent = normalizeStatsEvent({
              model: chunk.model,
              prompt_tokens: chunk.usage.prompt_tokens,
              completion_tokens: chunk.usage.completion_tokens,
            }, providerId || 'openai');
            validateEvent(statsEvent);
            yield statsEvent;
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
 * @param {string} [providerId] - Provider ID for stats normalization
 * @yields {Object} text_delta events
 * @returns {{ fullContent: string, toolCalls: Array }}
 */
async function* parseAnthropicStream(response, fullContent, toolCalls, signal, providerId) {
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
            const thinkingEvent = {
              type: "thinking",
              text: delta.thinking,
              hasNativeThinking: true, // Native thinking from Anthropic
            };
            validateEvent(thinkingEvent);
            yield thinkingEvent;
          } else if (delta.type === "text_delta") {
            fullContent += delta.text;
            if (contentBlocks[idx]) contentBlocks[idx].text += delta.text;
            const textEvent = { type: "text_delta", text: delta.text };
            validateEvent(textEvent);
            yield textEvent;
          } else if (delta.type === "input_json_delta") {
            if (contentBlocks[idx]) contentBlocks[idx].inputJson += delta.partial_json;
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
 * Check if a local OpenAI-compatible model server is running and list
 * available models. Defaults to the local LLM server convention
 * (http://localhost:1316/v1) and can be overridden with LOCAL_LLM_URL.
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

export async function getMlxLocalStatus() {
  const baseUrl = (process.env.LOCAL_LLM_URL || 'http://localhost:1316/v1').replace(/\/v1$/, '');
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

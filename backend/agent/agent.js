// agent/agent.js
// The agent loop. Sends messages to Ollama, executes tool calls, loops until done.
// Ollama exposes an OpenAI-compatible API at http://localhost:11434/v1

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
 * - { type: "error", error } — fatal error
 *
 * @param {Object} options
 * @param {string} options.model - Ollama model name (e.g. "llama3.3")
 * @param {Array} options.messages - Conversation history
 * @param {Array} options.tools - Tool definitions from tools.js
 * @param {AbortSignal} [options.signal] - Optional abort signal
 * @yields {Object} Stream events for the frontend
 */
export async function* agentLoop({ model, messages, tools, signal }) {
  const maxIterations = 10;
  let iteration = 0;

  while (iteration < maxIterations) {
    iteration++;

    // 1. Call Ollama (native chat endpoint with tool support)
    const response = await fetch(`${OLLAMA_BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({
        model,
        messages,
        tools: tools.map((t) => ({
          type: "function",
          function: {
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          },
        })),
        stream: true,
      }),
    });

    if (!response.ok) {
      yield { type: "error", error: `Ollama returned ${response.status}: ${await response.text()}` };
      return;
    }

    // 2. Stream the response
    let fullContent = "";
    let toolCalls = [];
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const lines = decoder.decode(value, { stream: true }).split("\n").filter(Boolean);

      for (const line of lines) {
        try {
          const chunk = JSON.parse(line);

          // Text content streaming
          if (chunk.message?.content) {
            fullContent += chunk.message.content;
            yield { type: "text_delta", text: chunk.message.content };
          }

          // Tool calls (Ollama returns these in the message)
          if (chunk.message?.tool_calls) {
            toolCalls = chunk.message.tool_calls;
          }

          // Done signal with final stats
          if (chunk.done) {
            yield {
              type: "stats",
              model: chunk.model,
              eval_count: chunk.eval_count,
              eval_duration: chunk.eval_duration,
              total_duration: chunk.total_duration,
            };
          }
        } catch (e) {
          // Skip malformed JSON lines
        }
      }
    }

    // 3. Check if the model wants to call tools
    if (toolCalls.length > 0) {
      // Add the assistant message with tool calls to history
      messages.push({
        role: "assistant",
        content: fullContent || null,
        tool_calls: toolCalls,
      });

      // Execute each tool
      for (const call of toolCalls) {
        const toolName = call.function.name;
        const toolInput = call.function.arguments;
        const tool = tools.find((t) => t.name === toolName);

        yield { type: "tool_start", name: toolName, input: toolInput };

        if (!tool) {
          const errorResult = `Tool "${toolName}" not found`;
          yield { type: "tool_error", name: toolName, error: errorResult };
          messages.push({ role: "tool", content: errorResult });
          continue;
        }

        try {
          const result = await tool.execute(toolInput, signal);
          const resultStr = typeof result === "string" ? result : JSON.stringify(result);

          yield { type: "tool_result", name: toolName, result: resultStr };

          // Add tool result to messages for the next loop iteration
          messages.push({ role: "tool", content: resultStr });
        } catch (err) {
          const errorResult = `Tool error: ${err.message}`;
          yield { type: "tool_error", name: toolName, error: errorResult };
          messages.push({ role: "tool", content: errorResult });
        }
      }

      // Loop continues — model will see tool results and respond
      toolCalls = [];
      fullContent = "";
    } else {
      // No tool calls — model gave a final answer, we're done
      yield { type: "done", content: fullContent };
      return;
    }
  }

  // Safety: if we hit max iterations
  yield { type: "error", error: "Agent hit maximum iteration limit" };
}

/**
 * Check if Ollama is running and list available models
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

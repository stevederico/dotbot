// agent/routes.js
// SSE-based Hono routes for the DotBot agent.
// Uses Hono's built-in streamSSE (from hono/streaming) — zero new packages.

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { agentLoop, getOllamaStatus } from "./agent.js";
import { tools } from "./tools.js";
import { getSession, saveSession, clearSession, setModel, trimMessages } from "./session.js";

/**
 * Create agent routes with injected middleware
 *
 * Routes accept authMiddleware and csrfProtection as factory params
 * so they integrate with the existing server.js security stack.
 *
 * @param {Function} authMiddleware - JWT auth middleware from server.js
 * @param {Function} csrfProtection - CSRF token middleware from server.js
 * @returns {Hono} Hono app instance with agent routes
 */
export function createAgentRoutes(authMiddleware, csrfProtection) {
  const agent = new Hono();

  /**
   * GET /status — Ollama connection status + available models
   */
  agent.get("/status", authMiddleware, async (c) => {
    const status = await getOllamaStatus();
    const userID = c.get("userID");

    // Also return the user's current model
    let currentModel = "llama3.3";
    try {
      const session = await getSession(userID);
      currentModel = session.model;
    } catch {
      // Session may not exist yet
    }

    return c.json({ ...status, currentModel });
  });

  /**
   * GET /history — return conversation messages for the current session
   */
  agent.get("/history", authMiddleware, async (c) => {
    const userID = c.get("userID");
    try {
      const session = await getSession(userID);
      const messages = session.messages.filter((m) => m.role !== "system");
      return c.json({ messages });
    } catch {
      return c.json({ messages: [] });
    }
  });

  /**
   * GET /tools — list registered tools (names + descriptions)
   */
  agent.get("/tools", authMiddleware, async (c) => {
    return c.json(
      tools.map((t) => ({
        name: t.name,
        description: t.description,
      }))
    );
  });

  /**
   * POST /chat — send a message, returns SSE stream
   *
   * Uses fetch + ReadableStream parsing on the client side (not EventSource,
   * since EventSource doesn't support POST). The stream emits JSON-encoded
   * SSE events matching the agentLoop event types.
   */
  agent.post("/chat", authMiddleware, csrfProtection, async (c) => {
    const userID = c.get("userID");
    const body = await c.req.json();
    const { message } = body;

    if (!message || typeof message !== "string" || message.trim().length === 0) {
      return c.json({ error: "Message is required" }, 400);
    }

    if (message.length > 10000) {
      return c.json({ error: "Message too long (max 10,000 chars)" }, 400);
    }

    return streamSSE(c, async (stream) => {
      try {
        // Get or create session for this user
        const session = await getSession(userID);
        let messages = session.messages;

        // Add user message
        messages.push({ role: "user", content: message.trim() });

        // Trim if conversation is too long
        messages = trimMessages(messages);

        // Run agent loop and stream events
        for await (const event of agentLoop({
          model: session.model,
          messages,
          tools,
          signal: c.req.raw.signal,
        })) {
          await stream.writeSSE({
            event: event.type,
            data: JSON.stringify(event),
          });
        }

        // Save conversation state after completion
        await saveSession(userID, messages, session.model);
      } catch (err) {
        if (err.name === "AbortError") {
          // Client disconnected — save what we have
          try {
            const session = await getSession(userID);
            await saveSession(userID, session.messages, session.model);
          } catch {
            // Best effort
          }
          return;
        }

        console.error("[agent/chat] error:", err.message);
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ type: "error", error: err.message }),
        });
      }
    });
  });

  /**
   * POST /clear — clear conversation history for the user's session
   */
  agent.post("/clear", authMiddleware, csrfProtection, async (c) => {
    const userID = c.get("userID");
    await clearSession(userID);
    return c.json({ ok: true });
  });

  /**
   * POST /model — set the Ollama model for the user's session
   */
  agent.post("/model", authMiddleware, csrfProtection, async (c) => {
    const userID = c.get("userID");
    const body = await c.req.json();
    const { model } = body;

    if (!model || typeof model !== "string") {
      return c.json({ error: "Model name is required" }, 400);
    }

    await setModel(userID, model);
    return c.json({ ok: true, model });
  });

  return agent;
}

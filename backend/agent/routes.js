// agent/routes.js
// SSE-based Hono routes for the DotBot agent.
// Uses Hono's built-in streamSSE (from hono/streaming) — zero new packages.

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { agentLoop, getOllamaStatus } from "./agent.js";
import { tools } from "./tools.js";
import {
  getSession,
  getOrCreateDefaultSession,
  createSession,
  saveSession,
  clearSession,
  setModel,
  listSessions,
  deleteSession,
  trimMessages,
} from "./session.js";

/**
 * Create agent routes with injected middleware
 *
 * Routes accept authMiddleware and csrfProtection as factory params
 * so they integrate with the existing server.js security stack.
 * All session-scoped routes require a sessionId param (body or query).
 *
 * @param {Function} authMiddleware - JWT auth middleware from server.js
 * @param {Function} csrfProtection - CSRF token middleware from server.js
 * @returns {Hono} Hono app instance with agent routes
 */
export function createAgentRoutes(authMiddleware, csrfProtection) {
  const agent = new Hono();

  // ── Session CRUD ────────────────────────────────────────────

  /**
   * GET /sessions — list all sessions for the authenticated user
   */
  agent.get("/sessions", authMiddleware, async (c) => {
    const userID = c.get("userID");
    const sessions = await listSessions(userID);
    return c.json({ sessions });
  });

  /**
   * POST /sessions — create a new session
   */
  agent.post("/sessions", authMiddleware, csrfProtection, async (c) => {
    const userID = c.get("userID");
    const session = await createSession(userID);
    return c.json({ id: session.id, title: session.title, model: session.model });
  });

  /**
   * DELETE /sessions/:id — delete a session (ownership verified)
   */
  agent.delete("/sessions/:id", authMiddleware, csrfProtection, async (c) => {
    const userID = c.get("userID");
    const sessionId = c.req.param("id");
    const result = await deleteSession(sessionId, userID);
    if (result.deletedCount === 0) {
      return c.json({ error: "Session not found" }, 404);
    }
    return c.json({ ok: true });
  });

  // ── Agent Routes (session-scoped) ───────────────────────────

  /**
   * GET /status — Ollama connection status + available models
   *
   * Optionally accepts ?sessionId= to return the model for a specific session.
   */
  agent.get("/status", authMiddleware, async (c) => {
    const status = await getOllamaStatus();
    const userID = c.get("userID");
    const sessionId = c.req.query("sessionId");

    let currentModel = "llama3.3";
    try {
      const session = sessionId
        ? await getSession(sessionId, userID)
        : await getOrCreateDefaultSession(userID);
      if (session) currentModel = session.model;
    } catch {
      // Session may not exist yet
    }

    return c.json({ ...status, currentModel });
  });

  /**
   * GET /history — return conversation messages for a session
   *
   * Requires ?sessionId= query param.
   */
  agent.get("/history", authMiddleware, async (c) => {
    const userID = c.get("userID");
    const sessionId = c.req.query("sessionId");

    try {
      const session = sessionId
        ? await getSession(sessionId, userID)
        : await getOrCreateDefaultSession(userID);
      if (!session) return c.json({ messages: [] });
      const messages = session.messages.filter((m) => m.role !== "system");
      return c.json({ messages, sessionId: session.id });
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
   * Body: { message, sessionId }
   * If sessionId is omitted, uses the user's most recent session.
   */
  agent.post("/chat", authMiddleware, csrfProtection, async (c) => {
    const userID = c.get("userID");
    const body = await c.req.json();
    const { message, sessionId } = body;

    if (!message || typeof message !== "string" || message.trim().length === 0) {
      return c.json({ error: "Message is required" }, 400);
    }

    if (message.length > 10000) {
      return c.json({ error: "Message too long (max 10,000 chars)" }, 400);
    }

    return streamSSE(c, async (stream) => {
      try {
        // Get or resolve session
        const session = sessionId
          ? await getSession(sessionId, userID)
          : await getOrCreateDefaultSession(userID);

        if (!session) {
          await stream.writeSSE({
            event: "error",
            data: JSON.stringify({ type: "error", error: "Session not found" }),
          });
          return;
        }

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
        await saveSession(session.id, messages, session.model);
      } catch (err) {
        if (err.name === "AbortError") {
          // Client disconnected — save what we have
          try {
            const session = sessionId
              ? await getSession(sessionId, userID)
              : await getOrCreateDefaultSession(userID);
            if (session) {
              await saveSession(session.id, session.messages, session.model);
            }
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
   * POST /clear — clear conversation history for a session
   *
   * Body: { sessionId }
   */
  agent.post("/clear", authMiddleware, csrfProtection, async (c) => {
    const userID = c.get("userID");
    const body = await c.req.json();
    const { sessionId } = body;

    if (!sessionId) return c.json({ error: "sessionId required" }, 400);

    // Verify ownership
    const session = await getSession(sessionId, userID);
    if (!session) return c.json({ error: "Session not found" }, 404);

    await clearSession(sessionId);
    return c.json({ ok: true });
  });

  /**
   * POST /model — set the Ollama model for a session
   *
   * Body: { sessionId, model }
   */
  agent.post("/model", authMiddleware, csrfProtection, async (c) => {
    const userID = c.get("userID");
    const body = await c.req.json();
    const { model, sessionId } = body;

    if (!model || typeof model !== "string") {
      return c.json({ error: "Model name is required" }, 400);
    }

    // Resolve session — use provided or most recent
    const session = sessionId
      ? await getSession(sessionId, userID)
      : await getOrCreateDefaultSession(userID);

    if (!session) return c.json({ error: "Session not found" }, 404);

    await setModel(session.id, model);
    return c.json({ ok: true, model });
  });

  return agent;
}

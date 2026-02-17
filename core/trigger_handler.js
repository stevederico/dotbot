/**
 * Trigger handler for dotbot.
 *
 * Extracted from dottie-os server.js to provide a reusable trigger executor
 * that handles event matching, firing, and notification hooks.
 */

import { compactMessages } from './compaction.js';

/**
 * Create a trigger handler function.
 *
 * @param {Object} options
 * @param {Object} options.agent - Agent instance with chat() method
 * @param {Object} options.sessionStore - Session store instance
 * @param {Object} options.triggerStore - Trigger store instance
 * @param {Object} options.memoryStore - Memory store instance (optional)
 * @param {Object} options.providers - Provider API keys for compaction
 * @param {Object} [options.hooks] - Host-specific hooks
 * @param {Function} [options.hooks.onNotification] - async (userId, { title, body, type }) => void
 * @returns {Function} Async function: (eventType, userId, eventData?) => Promise<void>
 */
export function createTriggerHandler({
  agent,
  sessionStore,
  triggerStore,
  memoryStore,
  providers = {},
  hooks = {},
}) {
  /**
   * Fire triggers for an event.
   *
   * @param {string} eventType - Event type (e.g., "user_login", "app_opened")
   * @param {string} userId - User ID
   * @param {Object} [eventData] - Optional event payload
   */
  async function fireTrigger(eventType, userId, eventData = {}) {
    if (!userId) {
      console.warn(`[triggers] fireTrigger called without userId for event ${eventType}`);
      return;
    }

    try {
      // Find matching triggers for this user and event
      const triggers = await triggerStore.findMatchingTriggers(userId, eventType);
      if (triggers.length === 0) {
        console.log(`[triggers] no matching triggers for ${eventType} (user=${userId})`);
        return;
      }

      console.log(`[triggers] found ${triggers.length} trigger(s) for ${eventType}`);

      // Get or create the user's session
      const session = await sessionStore.getOrCreateDefaultSession(userId);
      if (!session) {
        console.warn(`[triggers] could not get/create session for user ${userId}`);
        return;
      }

      // Process each matching trigger
      for (const trigger of triggers) {
        await executeTrigger(trigger, eventType, session, eventData);
      }
    } catch (err) {
      console.error(`[triggers] error handling ${eventType}:`, err.message);
    }
  }

  /**
   * Execute a single trigger.
   *
   * @param {Object} trigger - Trigger object
   * @param {string} eventType - Event type
   * @param {Object} session - User session
   * @param {Object} eventData - Event payload
   */
  async function executeTrigger(trigger, eventType, session, eventData) {
    // Mark trigger as fired (handles cooldown tracking)
    await triggerStore.markTriggerFired(trigger.id);

    // Build the message content
    let messageContent = `[Event: ${eventType}] ${trigger.prompt}`;
    if (Object.keys(eventData).length > 0) {
      messageContent += `\n\nEvent data: ${JSON.stringify(eventData)}`;
    }

    // Add message to session
    await sessionStore.addMessage(session.id, {
      role: 'user',
      content: messageContent,
    });

    // Re-fetch session to pick up the added message
    const updatedSession = await sessionStore.getSessionInternal(session.id);
    const providerId = updatedSession.provider || 'ollama';

    // Compact old messages before running agent loop
    const compacted = await compactMessages(updatedSession.messages, {
      providerId,
      providers,
    });

    if (compacted.compacted) {
      updatedSession.messages = compacted.messages;
      updatedSession.messages.push({
        role: 'user',
        content: '[Compaction] Compressed conversation history',
        _ts: Date.now(),
      });
    }

    // Run the agent chat loop
    let finalText = '';
    for await (const event of agent.chat({
      sessionId: updatedSession.id,
      message: '', // Message already added to session
      provider: providerId,
      model: updatedSession.model,
      context: {
        userID: updatedSession.owner,
        sessionId: updatedSession.id,
        memoryStore,
      },
    })) {
      if (event.type === 'text_delta' && event.text) {
        finalText += event.text;
      }
    }

    // Create notification if the agent produced meaningful output
    const trimmed = finalText.trim();
    if (trimmed && trimmed.length > 10 && updatedSession.owner && hooks.onNotification) {
      try {
        await hooks.onNotification(updatedSession.owner, {
          title: 'Dottie',
          body: trimmed.slice(0, 500),
          type: 'trigger',
        });
        console.log(`[triggers] notification created for ${updatedSession.owner} (${trimmed.length} chars)`);
      } catch (err) {
        console.error(`[triggers] failed to create notification for ${eventType}:`, err.message);
      }
    }
  }

  return fireTrigger;
}

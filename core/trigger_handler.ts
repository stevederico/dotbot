/// <reference types="node" />
/**
 * Trigger handler for dotbot.
 *
 * Reusable trigger executor that handles event matching, firing, and
 * notification hooks.
 */

import { compactMessages } from './compaction.js';
import type {
  AgentContext,
  AgentEvent,
  JsonObject,
  MemoryStore,
  ProvidersMap,
  Session,
  SessionStore,
  TriggerStore,
} from '../types.js';

/** Options passed to agent.chat(). */
export interface AgentChatOptions {
  sessionId: string;
  message: string;
  provider?: string;
  model?: string;
  context?: AgentContext;
}

/** Agent instance with a streaming chat() method. */
export interface Agent {
  chat(options: AgentChatOptions): AsyncGenerator<AgentEvent>;
}

/** An event-driven trigger record. */
export interface Trigger {
  id: string;
  prompt: string;
  [key: string]: unknown;
}

/** Notification payload dispatched via hooks.onNotification. */
export interface NotificationPayload {
  title: string;
  body: string;
  type: string;
}

/** Host-specific hooks for the trigger handler. */
export interface TriggerHandlerHooks {
  onNotification?: (userId: string, payload: NotificationPayload) => Promise<void>;
}

/** Options for createTriggerHandler(). */
export interface TriggerHandlerOptions {
  /** Agent instance with chat() method. */
  agent: Agent;
  /** Session store instance. */
  sessionStore: SessionStore;
  /** Trigger store instance. */
  triggerStore: TriggerStore;
  /** Memory store instance (optional). */
  memoryStore?: MemoryStore;
  /** Provider API keys for compaction. */
  providers?: ProvidersMap;
  /** Title used when dispatching notifications via hooks.onNotification. */
  notificationTitle?: string;
  /** Host-specific hooks. */
  hooks?: TriggerHandlerHooks;
}

/** Async function fired when an event occurs. */
export type TriggerHandler = (
  eventType: string,
  userId: string,
  eventData?: JsonObject,
) => Promise<void>;

/** Read a string-valued field from a Session (whose values are `unknown`). */
function sessionString(session: Session, key: string): string | undefined {
  const value: unknown = session[key];
  return typeof value === 'string' ? value : undefined;
}

/** Narrow an unknown store result to a Trigger. */
function isTrigger(value: unknown): value is Trigger {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'string' &&
    typeof (value as { prompt?: unknown }).prompt === 'string'
  );
}

/**
 * Create a trigger handler function.
 */
export function createTriggerHandler({
  agent,
  sessionStore,
  triggerStore,
  memoryStore,
  providers = {},
  notificationTitle = 'Assistant',
  hooks = {},
}: TriggerHandlerOptions): TriggerHandler {
  /**
   * Fire triggers for an event.
   */
  async function fireTrigger(eventType: string, userId: string, eventData: JsonObject = {}): Promise<void> {
    if (!userId) {
      console.warn(`[triggers] fireTrigger called without userId for event ${eventType}`);
      return;
    }

    try {
      // Find matching triggers for this user and event
      const findMatchingTriggers = triggerStore.findMatchingTriggers;
      let triggers: Trigger[] = [];
      if (typeof findMatchingTriggers === 'function') {
        const result: unknown = await findMatchingTriggers(userId, eventType);
        triggers = Array.isArray(result) ? result.filter(isTrigger) : [];
      }
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
      console.error(`[triggers] error handling ${eventType}:`, err instanceof Error ? err.message : err);
    }
  }

  /**
   * Execute a single trigger.
   */
  async function executeTrigger(
    trigger: Trigger,
    eventType: string,
    session: Session,
    eventData: JsonObject,
  ): Promise<void> {
    // Mark trigger as fired (handles cooldown tracking)
    const markTriggerFired = triggerStore.markTriggerFired;
    if (typeof markTriggerFired === 'function') {
      await markTriggerFired(trigger.id);
    }

    // Build the message content
    let messageContent = `[Event: ${eventType}] ${trigger.prompt}`;
    if (Object.keys(eventData).length > 0) {
      messageContent += `\n\nEvent data: ${JSON.stringify(eventData)}`;
    }

    const sessionId = sessionString(session, 'id');
    if (!sessionId) {
      console.warn('[triggers] session has no id, skipping');
      return;
    }

    // Add message to session
    await sessionStore.addMessage(sessionId, {
      role: 'user',
      content: messageContent,
    });

    // Re-fetch session to pick up the added message
    const updatedSession = await sessionStore.getSessionInternal(sessionId);
    if (!updatedSession) return;
    const updatedSessionId = sessionString(updatedSession, 'id') ?? sessionId;
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
      sessionId: updatedSessionId,
      message: '', // Message already added to session
      provider: providerId,
      model: updatedSession.model,
      context: {
        userID: updatedSession.owner,
        sessionId: updatedSessionId,
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
          title: notificationTitle,
          body: trimmed.slice(0, 500),
          type: 'trigger',
        });
        console.log(`[triggers] notification created for ${updatedSession.owner} (${trimmed.length} chars)`);
      } catch (err) {
        console.error(`[triggers] failed to create notification for ${eventType}:`, err instanceof Error ? err.message : err);
      }
    }
  }

  return fireTrigger;
}

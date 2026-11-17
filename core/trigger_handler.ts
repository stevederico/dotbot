/// <reference types="node" />

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

export interface AgentChatOptions {
  sessionId: string;
  message: string;
  provider?: string;
  model?: string;
  context?: AgentContext;
}

export interface Agent {
  chat(options: AgentChatOptions): AsyncGenerator<AgentEvent>;
}

export interface Trigger {
  id: string;
  prompt: string;
  [key: string]: unknown;
}

export interface NotificationPayload {
  title: string;
  body: string;
  type: string;
}

export interface TriggerHandlerHooks {
  onNotification?: (userId: string, payload: NotificationPayload) => Promise<void>;
}

export interface TriggerHandlerOptions {
  agent: Agent;
  sessionStore: SessionStore;
  triggerStore: TriggerStore;
  memoryStore?: MemoryStore;
  providers?: ProvidersMap;
  notificationTitle?: string;
  hooks?: TriggerHandlerHooks;
}

export type TriggerHandler = (
  eventType: string,
  userId: string,
  eventData?: JsonObject,
) => Promise<void>;

function sessionString(session: Session, key: string): string | undefined {
  const value: unknown = session[key];
  return typeof value === 'string' ? value : undefined;
}

function isTrigger(value: unknown): value is Trigger {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'string' &&
    typeof (value as { prompt?: unknown }).prompt === 'string'
  );
}

export function createTriggerHandler({
  agent,
  sessionStore,
  triggerStore,
  memoryStore,
  providers = {},
  notificationTitle = 'Assistant',
  hooks = {},
}: TriggerHandlerOptions): TriggerHandler {
  async function fireTrigger(eventType: string, userId: string, eventData: JsonObject = {}): Promise<void> {
    if (!userId) {
      console.warn(`[triggers] fireTrigger called without userId for event ${eventType}`);
      return;
    }

    try {
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

      const session = await sessionStore.getOrCreateDefaultSession(userId);
      if (!session) {
        console.warn(`[triggers] could not get/create session for user ${userId}`);
        return;
      }

      for (const trigger of triggers) {
        await executeTrigger(trigger, eventType, session, eventData);
      }
    } catch (err) {
      console.error(`[triggers] error handling ${eventType}:`, err instanceof Error ? err.message : err);
    }
  }

  async function executeTrigger(
    trigger: Trigger,
    eventType: string,
    session: Session,
    eventData: JsonObject,
  ): Promise<void> {
    const markTriggerFired = triggerStore.markTriggerFired;
    if (typeof markTriggerFired === 'function') {
      await markTriggerFired(trigger.id);
    }

    let messageContent = `[Event: ${eventType}] ${trigger.prompt}`;
    if (Object.keys(eventData).length > 0) {
      messageContent += `\n\nEvent data: ${JSON.stringify(eventData)}`;
    }

    const sessionId = sessionString(session, 'id');
    if (!sessionId) {
      console.warn('[triggers] session has no id, skipping');
      return;
    }

    await sessionStore.addMessage(sessionId, {
      role: 'user',
      content: messageContent,
    });

    const updatedSession = await sessionStore.getSessionInternal(sessionId);
    if (!updatedSession) return;
    const updatedSessionId = sessionString(updatedSession, 'id') ?? sessionId;
    const providerId = updatedSession.provider || 'ollama';

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

    let finalText = '';
    for await (const event of agent.chat({
      sessionId: updatedSessionId,
      message: '',
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

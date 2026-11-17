import type { JsonObject } from "../types.js";

export interface TriggerCreateParams {
  userId: string;
  eventType: string;
  prompt: string;
  cooldownMs?: number;
  metadata?: JsonObject;
  enabled?: boolean;
}

export interface TriggerDocument {
  id: string;
  userId: string;
  eventType: string;
  prompt: string;
  cooldownMs: number;
  metadata: JsonObject;
  enabled: boolean;
  lastFiredAt: Date | null;
  fireCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface TriggerListFilters {
  enabled?: boolean;
  eventType?: string;
}

export interface TriggerChangeResult {
  changes: number | bigint;
}

export interface TriggerDeleteResult {
  deletedCount: number | bigint;
}

export class TriggerStore {
  async init(db: unknown, options: JsonObject = {}): Promise<void> {
    throw new Error('TriggerStore.init() must be implemented');
  }

  async createTrigger({ userId, eventType, prompt, cooldownMs, metadata, enabled }: TriggerCreateParams): Promise<TriggerDocument> {
    throw new Error('TriggerStore.createTrigger() must be implemented');
  }

  async listTriggers(userId: string, filters: TriggerListFilters = {}): Promise<TriggerDocument[]> {
    throw new Error('TriggerStore.listTriggers() must be implemented');
  }

  async findMatchingTriggers(userId: string, eventType: string, metadata: JsonObject = {}): Promise<TriggerDocument[]> {
    throw new Error('TriggerStore.findMatchingTriggers() must be implemented');
  }

  async toggleTrigger(userId: string, triggerId: string, enabled: boolean): Promise<TriggerChangeResult> {
    throw new Error('TriggerStore.toggleTrigger() must be implemented');
  }

  async deleteTrigger(userId: string, triggerId: string): Promise<TriggerDeleteResult> {
    throw new Error('TriggerStore.deleteTrigger() must be implemented');
  }

  async markTriggerFired(triggerId: string): Promise<void> {
    throw new Error('TriggerStore.markTriggerFired() must be implemented');
  }
}

/**
 * TriggerStore Interface
 *
 * Abstract interface for event trigger storage. Implementations must provide
 * all methods defined here.
 */
import type { JsonObject } from "../types.js";

/** Parameters for TriggerStore.createTrigger(). */
export interface TriggerCreateParams {
  /** Owner user ID */
  userId: string;
  /** Event type to trigger on */
  eventType: string;
  /** Prompt to inject when event fires */
  prompt: string;
  /** Cooldown period in milliseconds */
  cooldownMs?: number;
  /** Additional metadata (e.g., appName for app_opened events) */
  metadata?: JsonObject;
  /** Whether trigger is enabled (default: true) */
  enabled?: boolean;
}

/** A trigger document with JS-native types. */
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

/** Optional filters for TriggerStore.listTriggers(). */
export interface TriggerListFilters {
  enabled?: boolean;
  eventType?: string;
}

/** Result of a write operation reporting the number of affected rows. */
export interface TriggerChangeResult {
  changes: number | bigint;
}

/** Result of a delete operation reporting the number of removed rows. */
export interface TriggerDeleteResult {
  deletedCount: number | bigint;
}

export class TriggerStore {
  /**
   * Initialize the trigger store
   */
  async init(db: unknown, options: JsonObject = {}): Promise<void> {
    throw new Error('TriggerStore.init() must be implemented');
  }

  /**
   * Create an event trigger
   */
  async createTrigger({ userId, eventType, prompt, cooldownMs, metadata, enabled }: TriggerCreateParams): Promise<TriggerDocument> {
    throw new Error('TriggerStore.createTrigger() must be implemented');
  }

  /**
   * List triggers for a user
   */
  async listTriggers(userId: string, filters: TriggerListFilters = {}): Promise<TriggerDocument[]> {
    throw new Error('TriggerStore.listTriggers() must be implemented');
  }

  /**
   * Find enabled triggers matching userId and eventType, filtering out
   * those still within cooldown period
   */
  async findMatchingTriggers(userId: string, eventType: string, metadata: JsonObject = {}): Promise<TriggerDocument[]> {
    throw new Error('TriggerStore.findMatchingTriggers() must be implemented');
  }

  /**
   * Toggle a trigger on/off
   */
  async toggleTrigger(userId: string, triggerId: string, enabled: boolean): Promise<TriggerChangeResult> {
    throw new Error('TriggerStore.toggleTrigger() must be implemented');
  }

  /**
   * Delete a trigger
   */
  async deleteTrigger(userId: string, triggerId: string): Promise<TriggerDeleteResult> {
    throw new Error('TriggerStore.deleteTrigger() must be implemented');
  }

  /**
   * Record that a trigger has fired by updating its lastFiredAt timestamp
   */
  async markTriggerFired(triggerId: string): Promise<void> {
    throw new Error('TriggerStore.markTriggerFired() must be implemented');
  }
}

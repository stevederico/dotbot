/**
 * EventStore Interface
 *
 * Abstract interface for event/analytics storage. Implementations must provide
 * all methods defined here.
 */
import type {
  JsonObject,
  LogEventParams,
  EventQueryParams,
  EventSummaryParams,
  EventSummary,
  StoredEvent,
} from "../types.js";

export class EventStore {
  /**
   * Initialize the event store
   */
  async init(db: unknown, options: JsonObject = {}): Promise<void> {
    throw new Error('EventStore.init() must be implemented');
  }

  /**
   * Log an event
   */
  async logEvent({ userId, type, data, timestamp }: LogEventParams): Promise<StoredEvent> {
    throw new Error('EventStore.logEvent() must be implemented');
  }

  /**
   * Query events with filters
   */
  async query({ userId, type, startDate, endDate, limit }: EventQueryParams): Promise<StoredEvent[]> {
    throw new Error('EventStore.query() must be implemented');
  }

  /**
   * Get aggregated usage statistics
   */
  async summary({ userId, startDate, endDate, groupBy }: EventSummaryParams): Promise<EventSummary> {
    throw new Error('EventStore.summary() must be implemented');
  }

  /**
   * Delete events older than a given date
   */
  async deleteOldEvents(userId: string, beforeDate: string): Promise<{ deletedCount?: number } & JsonObject> {
    throw new Error('EventStore.deleteOldEvents() must be implemented');
  }
}

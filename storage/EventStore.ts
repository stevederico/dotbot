import type {
  JsonObject,
  LogEventParams,
  EventQueryParams,
  EventSummaryParams,
  EventSummary,
  StoredEvent,
} from "../types.js";

export class EventStore {
  async init(db: unknown, options: JsonObject = {}): Promise<void> {
    throw new Error('EventStore.init() must be implemented');
  }

  async logEvent({ userId, type, data, timestamp }: LogEventParams): Promise<StoredEvent> {
    throw new Error('EventStore.logEvent() must be implemented');
  }

  async query({ userId, type, startDate, endDate, limit }: EventQueryParams): Promise<StoredEvent[]> {
    throw new Error('EventStore.query() must be implemented');
  }

  async summary({ userId, startDate, endDate, groupBy }: EventSummaryParams): Promise<EventSummary> {
    throw new Error('EventStore.summary() must be implemented');
  }

  async deleteOldEvents(userId: string, beforeDate: string): Promise<{ deletedCount?: number } & JsonObject> {
    throw new Error('EventStore.deleteOldEvents() must be implemented');
  }
}

/**
 * CronStore Interface
 *
 * Abstract interface for scheduled task storage. Implementations must provide
 * all methods defined here.
 */

/** A cron task with JS-native types. */
export interface CronTask {
  id: string;
  name: string;
  prompt: string;
  sessionId: string | null;
  userId: string | null;
  taskId: string | null;
  nextRunAt: Date;
  intervalMs: number | null;
  recurring: boolean;
  enabled: boolean;
  createdAt: Date;
  lastRunAt: Date | null;
  /**
   * Adapters persist exactly the fields above, but the structural CronStore
   * contract in types.ts models results as loose `Record<string, unknown>`
   * rows (callers read them dynamically with narrowing). This index signature
   * lets a concrete CronTask satisfy that record contract.
   */
  [key: string]: unknown;
}

/** Callback invoked when a scheduled task fires. */
export type CronTaskFireCallback = (task: CronTask) => Promise<void>;

/** Options for CronStore.init(). */
export interface CronStoreInitOptions {
  onTaskFire?: CronTaskFireCallback | null;
}

/** Parameters for CronStore.createTask(). */
export interface CreateCronTaskParams {
  /** Short task name */
  name: string;
  /** Message to inject when task fires */
  prompt: string;
  /** Session to inject into */
  sessionId?: string;
  /** Owner user ID */
  userId?: string | null;
  /** Datetime for first run */
  runAt: string | number | Date;
  /** Repeat interval in milliseconds */
  intervalMs?: number | null;
  /** Whether task repeats */
  recurring?: boolean;
  /** Associated task ID */
  taskId?: string | null;
}

/** Fields accepted by updateTask(). */
export interface CronTaskUpdates {
  name?: string;
  prompt?: string;
  runAt?: string | number | Date;
  intervalMs?: number | null;
  recurring?: boolean;
}

/** Heartbeat status for a user. */
export interface HeartbeatStatus {
  id: string;
  enabled: boolean;
  nextRunAt: Date;
  lastRunAt: Date | null;
  createdAt: Date;
  intervalMs: number | null;
  prompt: string;
}

export class CronStore {
  /**
   * Initialize the cron store
   */
  async init(dbPath: string, options: CronStoreInitOptions = {}): Promise<void> {
    throw new Error('CronStore.init() must be implemented');
  }

  /**
   * Stop the cron polling loop
   */
  stop(): void {
    throw new Error('CronStore.stop() must be implemented');
  }

  /**
   * Create a scheduled task
   */
  async createTask({ name, prompt, sessionId, userId, runAt, intervalMs, recurring, taskId }: CreateCronTaskParams): Promise<CronTask> {
    throw new Error('CronStore.createTask() must be implemented');
  }

  /**
   * List tasks for a session
   */
  async listTasks(sessionId?: string): Promise<CronTask[]> {
    throw new Error('CronStore.listTasks() must be implemented');
  }

  /**
   * List tasks for multiple session IDs
   */
  async listTasksBySessionIds(sessionIds: string[], userId?: string | null): Promise<CronTask[]> {
    throw new Error('CronStore.listTasksBySessionIds() must be implemented');
  }

  /**
   * Get a task by ID
   */
  async getTask(id: string): Promise<CronTask | null> {
    throw new Error('CronStore.getTask() must be implemented');
  }

  /**
   * Delete a task by its ID
   */
  async deleteTask(id: string): Promise<unknown> {
    throw new Error('CronStore.deleteTask() must be implemented');
  }

  /**
   * Toggle a task's enabled/disabled state
   */
  async toggleTask(id: string, enabled: boolean): Promise<unknown> {
    throw new Error('CronStore.toggleTask() must be implemented');
  }

  /**
   * Update a task's details
   */
  async updateTask(id: string, updates: CronTaskUpdates): Promise<unknown> {
    throw new Error('CronStore.updateTask() must be implemented');
  }

  /**
   * Ensure a single recurring heartbeat task exists for a user
   */
  async ensureHeartbeat(userId: string): Promise<{ id: string } | null> {
    throw new Error('CronStore.ensureHeartbeat() must be implemented');
  }

  /**
   * Get heartbeat status for a user
   */
  async getHeartbeatStatus(userId: string): Promise<HeartbeatStatus | null> {
    throw new Error('CronStore.getHeartbeatStatus() must be implemented');
  }

  /**
   * Reset/update an existing heartbeat to use the latest prompt
   */
  async resetHeartbeat(userId: string): Promise<CronTask | null> {
    throw new Error('CronStore.resetHeartbeat() must be implemented');
  }

  /**
   * Manually trigger the heartbeat task immediately
   */
  async triggerHeartbeatNow(userId: string): Promise<boolean> {
    throw new Error('CronStore.triggerHeartbeatNow() must be implemented');
  }
}

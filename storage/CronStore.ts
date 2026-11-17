
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
  [key: string]: unknown;
}

export type CronTaskFireCallback = (task: CronTask) => Promise<void>;

export interface CronStoreInitOptions {
  onTaskFire?: CronTaskFireCallback | null;
}

export interface CreateCronTaskParams {
  name: string;
  prompt: string;
  sessionId?: string;
  userId?: string | null;
  runAt: string | number | Date;
  intervalMs?: number | null;
  recurring?: boolean;
  taskId?: string | null;
}

export interface CronTaskUpdates {
  name?: string;
  prompt?: string;
  runAt?: string | number | Date;
  intervalMs?: number | null;
  recurring?: boolean;
}

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
  async init(dbPath: string, options: CronStoreInitOptions = {}): Promise<void> {
    throw new Error('CronStore.init() must be implemented');
  }

  stop(): void {
    throw new Error('CronStore.stop() must be implemented');
  }

  async createTask({ name, prompt, sessionId, userId, runAt, intervalMs, recurring, taskId }: CreateCronTaskParams): Promise<CronTask> {
    throw new Error('CronStore.createTask() must be implemented');
  }

  async listTasks(sessionId?: string): Promise<CronTask[]> {
    throw new Error('CronStore.listTasks() must be implemented');
  }

  async listTasksBySessionIds(sessionIds: string[], userId?: string | null): Promise<CronTask[]> {
    throw new Error('CronStore.listTasksBySessionIds() must be implemented');
  }

  async getTask(id: string): Promise<CronTask | null> {
    throw new Error('CronStore.getTask() must be implemented');
  }

  async deleteTask(id: string): Promise<unknown> {
    throw new Error('CronStore.deleteTask() must be implemented');
  }

  async toggleTask(id: string, enabled: boolean): Promise<unknown> {
    throw new Error('CronStore.toggleTask() must be implemented');
  }

  async updateTask(id: string, updates: CronTaskUpdates): Promise<unknown> {
    throw new Error('CronStore.updateTask() must be implemented');
  }

  async ensureHeartbeat(userId: string): Promise<{ id: string } | null> {
    throw new Error('CronStore.ensureHeartbeat() must be implemented');
  }

  async getHeartbeatStatus(userId: string): Promise<HeartbeatStatus | null> {
    throw new Error('CronStore.getHeartbeatStatus() must be implemented');
  }

  async resetHeartbeat(userId: string): Promise<CronTask | null> {
    throw new Error('CronStore.resetHeartbeat() must be implemented');
  }

  async triggerHeartbeatNow(userId: string): Promise<boolean> {
    throw new Error('CronStore.triggerHeartbeatNow() must be implemented');
  }
}

import type { JsonObject } from "../types.js";

export interface TaskCreateParams {
  userId: string;
  description: string;
  steps: Array<string | JsonObject>;
  category?: string;
  priority?: string;
  deadline?: string;
  mode?: string;
}

export class TaskStore<
  Doc = JsonObject,
  CreateParams = TaskCreateParams,
  Filters = JsonObject,
  Updates = JsonObject,
  Stats = JsonObject,
  UpdateResult = JsonObject,
  DeleteResult = JsonObject,
> {
  async init(db: unknown, options: JsonObject = {}): Promise<void> {
    throw new Error('TaskStore.init() must be implemented');
  }

  async createTask(params: CreateParams): Promise<Doc> {
    throw new Error('TaskStore.createTask() must be implemented');
  }

  async getTasks(userId: string, filters?: Filters): Promise<Doc[]> {
    throw new Error('TaskStore.getTasks() must be implemented');
  }

  async getTask(userId: string, taskId: string): Promise<Doc | null> {
    throw new Error('TaskStore.getTask() must be implemented');
  }

  async updateTask(userId: string, taskId: string, updates: Updates): Promise<UpdateResult> {
    throw new Error('TaskStore.updateTask() must be implemented');
  }

  async deleteTask(userId: string, taskId: string): Promise<DeleteResult> {
    throw new Error('TaskStore.deleteTask() must be implemented');
  }

  async searchTasks(userId: string, query: string): Promise<Doc[]> {
    throw new Error('TaskStore.searchTasks() must be implemented');
  }

  async getTaskStats(userId: string): Promise<Stats> {
    throw new Error('TaskStore.getTaskStats() must be implemented');
  }
}

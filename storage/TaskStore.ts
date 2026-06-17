/**
 * TaskStore Interface
 *
 * Abstract interface for task storage. Implementations must provide
 * all methods defined here.
 *
 * Generic over the concrete document/params/stats/result types so that
 * implementations can specialize the shapes they return while remaining
 * structurally compatible with this base contract. Defaults keep the
 * original JsonObject-based behavior for callers that don't specialize.
 */
import type { JsonObject } from "../types.js";

/** Parameters for TaskStore.createTask(). */
export interface TaskCreateParams {
  /** Owner user ID */
  userId: string;
  /** Task description */
  description: string;
  /** Array of step descriptions or step objects */
  steps: Array<string | JsonObject>;
  /** Category (e.g., fitness, learning, productivity) */
  category?: string;
  /** Priority: low, medium, high */
  priority?: string;
  /** ISO 8601 deadline */
  deadline?: string;
  /** Execution mode: manual or auto */
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
  /**
   * Initialize the task store
   */
  async init(db: unknown, options: JsonObject = {}): Promise<void> {
    throw new Error('TaskStore.init() must be implemented');
  }

  /**
   * Create a new task
   */
  async createTask(params: CreateParams): Promise<Doc> {
    throw new Error('TaskStore.createTask() must be implemented');
  }

  /**
   * Get tasks for a user
   */
  async getTasks(userId: string, filters?: Filters): Promise<Doc[]> {
    throw new Error('TaskStore.getTasks() must be implemented');
  }

  /**
   * Get a single task by ID
   */
  async getTask(userId: string, taskId: string): Promise<Doc | null> {
    throw new Error('TaskStore.getTask() must be implemented');
  }

  /**
   * Update a task
   */
  async updateTask(userId: string, taskId: string, updates: Updates): Promise<UpdateResult> {
    throw new Error('TaskStore.updateTask() must be implemented');
  }

  /**
   * Delete a task
   */
  async deleteTask(userId: string, taskId: string): Promise<DeleteResult> {
    throw new Error('TaskStore.deleteTask() must be implemented');
  }

  /**
   * Search tasks by text
   */
  async searchTasks(userId: string, query: string): Promise<Doc[]> {
    throw new Error('TaskStore.searchTasks() must be implemented');
  }

  /**
   * Get task statistics
   */
  async getTaskStats(userId: string): Promise<Stats> {
    throw new Error('TaskStore.getTaskStats() must be implemented');
  }
}

/**
 * Tool Registry
 *
 * Central registry for agent tools with dynamic registration API.
 */

import type { ToolDefinition } from "../types.js";
import { memoryTools } from './memory.js';
import { webTools } from './web.js';
import { codeTools } from './code.js';
import { fileTools } from './files.js';
import { messageTools } from './messages.js';
import { imageTools } from './images.js';
import { weatherTools } from './weather.js';
import { notifyTools } from './notify.js';
import { browserTools, createBrowserTools } from './browser.js';
import { taskTools } from './tasks.js';
import { triggerTools } from './triggers.js';
import { jobTools } from './jobs.js';
import { eventTools } from './events.js';
import { appgenTools } from './appgen.js';

/**
 * Core tools included in the library by default
 */
export const coreTools: ToolDefinition[] = [
  ...memoryTools,
  ...webTools,
  ...codeTools,
  ...fileTools,
  ...messageTools,
  ...imageTools,
  ...weatherTools,
  ...notifyTools,
  ...browserTools,
  ...taskTools,
  ...triggerTools,
  ...jobTools,
  ...eventTools,
  ...appgenTools,
];

/** A tool registry with dynamic registration. */
export interface ToolRegistry {
  /** Register one or more tools. */
  register(...newTools: ToolDefinition[]): void;
  /** Get all registered tools. */
  getAll(): ToolDefinition[];
  /** Clear all registered tools. */
  clear(): void;
}

/**
 * Create a tool registry with dynamic registration
 *
 * @returns Tool registry with register/getAll methods
 */
export function createToolRegistry(): ToolRegistry {
  const tools: ToolDefinition[] = [];

  return {
    /**
     * Register one or more tools
     *
     * @param newTools - Tool definitions to register
     */
    register(...newTools: ToolDefinition[]): void {
      tools.push(...newTools);
    },

    /**
     * Get all registered tools
     *
     * @returns All registered tools
     */
    getAll(): ToolDefinition[] {
      return tools;
    },

    /**
     * Clear all registered tools
     */
    clear(): void {
      tools.length = 0;
    },
  };
}

// Re-export individual tool arrays for direct access
export {
  memoryTools,
  webTools,
  codeTools,
  fileTools,
  messageTools,
  imageTools,
  weatherTools,
  notifyTools,
  browserTools,
  createBrowserTools,
  taskTools,
  triggerTools,
  jobTools,
  eventTools,
  appgenTools,
};

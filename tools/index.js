/**
 * Tool Registry
 *
 * Central registry for agent tools with dynamic registration API.
 */

import { memoryTools } from './memory.js';
import { webTools } from './web.js';
import { codeTools } from './code.js';
import { fileTools } from './files.js';
import { messageTools } from './messages.js';
import { imageTools } from './images.js';
import { weatherTools } from './weather.js';
import { notifyTools } from './notify.js';
import { browserTools, createBrowserTools } from './browser.js';
import { goalTools } from './goals.js';
import { triggerTools } from './triggers.js';
import { jobTools, taskTools, cronTools } from './jobs.js';
import { eventTools } from './events.js';
import { appgenTools } from './appgen.js';

/**
 * Core tools included in the library by default
 */
export const coreTools = [
  ...memoryTools,
  ...webTools,
  ...codeTools,
  ...fileTools,
  ...messageTools,
  ...imageTools,
  ...weatherTools,
  ...notifyTools,
  ...browserTools,
  ...goalTools,
  ...triggerTools,
  ...jobTools,
  ...eventTools,
  ...appgenTools,
];

/**
 * Create a tool registry with dynamic registration
 *
 * @returns {Object} Tool registry with register/getAll methods
 */
export function createToolRegistry() {
  const tools = [];

  return {
    /**
     * Register one or more tools
     *
     * @param {...Object} newTools - Tool definitions to register
     */
    register(...newTools) {
      tools.push(...newTools);
    },

    /**
     * Get all registered tools
     *
     * @returns {Array} All registered tools
     */
    getAll() {
      return tools;
    },

    /**
     * Clear all registered tools
     */
    clear() {
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
  goalTools,
  triggerTools,
  jobTools,
  taskTools,   // backwards compatibility alias
  cronTools,   // backwards compatibility alias
  eventTools,
  appgenTools,
};

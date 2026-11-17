
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

export interface ToolRegistry {
  register(...newTools: ToolDefinition[]): void;
  getAll(): ToolDefinition[];
  clear(): void;
}

export function createToolRegistry(): ToolRegistry {
  const tools: ToolDefinition[] = [];

  return {
    register(...newTools: ToolDefinition[]): void {
      tools.push(...newTools);
    },

    getAll(): ToolDefinition[] {
      return tools;
    },

    clear(): void {
      tools.length = 0;
    },
  };
}

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

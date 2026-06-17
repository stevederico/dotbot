/**
 * Image generation and management tools
 */

import type { ToolDefinition, JsonObject, AgentContext } from "../types.js";

/**
 * Default model for Grok Imagine image generation
 */
export const GROK_IMAGINE_MODEL = 'grok-imagine-image-beta';

/** Options accepted by the image helpers. */
export interface ImageGenerateOptions {
  /** Abort signal. */
  signal?: AbortSignal;
  /** Model override. */
  model?: string;
}

/** Result of generateImage(). */
export interface GenerateImageResult {
  success: boolean;
  url?: string;
  prompt?: string;
  error?: string;
}

/** Result of extractVisualPrompt(). */
export interface ExtractVisualPromptResult {
  success: boolean;
  prompt?: string;
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** A stored agent-activity entry (image generation log row). */
interface AgentActivityEntry {
  prompt?: string;
  url?: string;
  source?: string;
  timestamp?: number;
}

/** databaseManager surface used by the image tools (not part of DatabaseManager). */
interface ImageActivityManager {
  getAgentActivity(
    dbType: string,
    db: string,
    connectionString: string,
    userID: string,
    options: { type: string; limit: number },
  ): Promise<AgentActivityEntry[]>;
}

function hasGetAgentActivity(value: unknown): value is ImageActivityManager {
  return isRecord(value) && typeof value.getAgentActivity === "function";
}

/**
 * Generate an image using Grok Imagine API.
 * Shared helper that can be used by both agent tools and HTTP endpoints.
 *
 * @param prompt - Image description
 * @param apiKey - xAI API key
 * @param options - Generation options
 */
export async function generateImage(
  prompt: string | undefined,
  apiKey: string | undefined,
  options: ImageGenerateOptions = {},
): Promise<GenerateImageResult> {
  const { signal, model = GROK_IMAGINE_MODEL } = options;

  if (!prompt) {
    return { success: false, error: 'Prompt is required' };
  }

  if (!apiKey) {
    return { success: false, error: 'xAI API key not configured' };
  }

  try {
    const response = await fetch('https://api.x.ai/v1/images/generations', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ prompt, model, n: 1 }),
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      return { success: false, error: `Grok Imagine API error: ${response.status} - ${errorText.slice(0, 200)}` };
    }

    const data: unknown = await response.json();
    const dataArr = isRecord(data) && Array.isArray(data.data) ? data.data : undefined;
    const first = dataArr?.[0];
    const url = isRecord(first) && typeof first.url === 'string' ? first.url : undefined;

    if (!url) {
      return { success: false, error: 'No image URL in response' };
    }

    return { success: true, url, prompt };
  } catch (error) {
    if (isRecord(error) && error.name === 'AbortError') {
      return { success: false, error: 'Request was cancelled' };
    }
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Extract visual themes from text and generate an image prompt.
 * Uses Grok to summarize text into a visual description.
 *
 * @param text - Text to extract visual themes from
 * @param apiKey - xAI API key
 * @param options - Extraction options
 */
export async function extractVisualPrompt(
  text: string | undefined,
  apiKey: string | undefined,
  options: ImageGenerateOptions = {},
): Promise<ExtractVisualPromptResult> {
  const { signal, model = 'grok-4-1-fast-non-reasoning' } = options;

  if (!text) {
    return { success: false, error: 'Text is required' };
  }

  if (!apiKey) {
    return { success: false, error: 'xAI API key not configured' };
  }

  try {
    const response = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{
          role: 'user',
          content: `Extract visual themes from this text for an image.
Output ONLY a brief image prompt (1-2 sentences). No explanation.
Style: cinematic, high quality, detailed.

Text: "${text.slice(0, 500)}"`
        }],
        max_tokens: 100
      }),
      signal,
    });

    if (!response.ok) {
      return { success: false, error: `Failed to extract visual themes: ${response.status}` };
    }

    const data: unknown = await response.json();
    const choices = isRecord(data) && Array.isArray(data.choices) ? data.choices : undefined;
    const firstChoice = choices?.[0];
    const message = isRecord(firstChoice) && isRecord(firstChoice.message) ? firstChoice.message : undefined;
    const prompt = message && typeof message.content === 'string' ? message.content : undefined;

    if (!prompt) {
      return { success: false, error: 'No visual prompt generated' };
    }

    return { success: true, prompt };
  } catch (error) {
    if (isRecord(error) && error.name === 'AbortError') {
      return { success: false, error: 'Request was cancelled' };
    }
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Generate an image from text, optionally extracting visual themes first.
 * Convenience wrapper combining extractVisualPrompt + generateImage.
 *
 * @param input - Direct prompt and/or source text
 * @param apiKey - xAI API key
 * @param options - Generation options
 */
export async function generateImageFromText(
  { prompt, text }: { prompt?: string; text?: string },
  apiKey: string | undefined,
  options: ImageGenerateOptions = {},
): Promise<GenerateImageResult> {
  let imagePrompt = prompt;

  // If text provided without prompt, extract visual themes first
  if (text && !prompt) {
    const extracted = await extractVisualPrompt(text, apiKey, options);
    if (!extracted.success) {
      return extracted;
    }
    imagePrompt = extracted.prompt;
  }

  if (!imagePrompt) {
    return { success: false, error: 'Either prompt or text is required' };
  }

  return generateImage(imagePrompt, apiKey, options);
}

export const imageTools: ToolDefinition[] = [
  {
    name: "image_generate",
    description: "Generate an AI image from a text prompt.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Description of the image to generate" },
      },
      required: ["prompt"],
    },
    execute: async (input: JsonObject, signal: AbortSignal | undefined, context: AgentContext): Promise<string> => {
      const providers = context?.providers;
      const apiKey = providers?.xai?.apiKey;
      const prompt = String(input.prompt);
      const result = await generateImage(prompt, apiKey, { signal });

      if (!result.success) {
        return result.error ?? '';
      }

      return JSON.stringify({ type: 'image', url: result.url, prompt });
    },
  },

  {
    name: "image_list",
    description: "List the user's photos and generated images. Returns the most recent images with their prompts and dates.",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max number of photos to return (default 20)" },
      },
    },
    execute: async (input: JsonObject, signal: AbortSignal | undefined, context: AgentContext): Promise<string> => {
      if (!context?.databaseManager) return "Error: database not available";
      try {
        const { databaseManager, dbConfig, userID } = context;
        if (!dbConfig || !userID || !hasGetAgentActivity(databaseManager)) return "Error: database not available";
        const limit = typeof input.limit === 'number' ? input.limit : 20;
        const activity = await databaseManager.getAgentActivity(
          dbConfig.dbType, dbConfig.db, dbConfig.connectionString, userID,
          { type: 'image_generation', limit: limit || 20 }
        );
        if (!activity || activity.length === 0) return "No photos found.";
        return activity.map((entry, i) => {
          const date = entry.timestamp ? new Date(entry.timestamp).toLocaleDateString() : '';
          const source = entry.source || 'user';
          return `${i + 1}. "${entry.prompt || 'Untitled'}" — ${source} — ${date}\n   ${entry.url || '(no url)'}`;
        }).join('\n\n');
      } catch (err) {
        return `Error listing photos: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  },

  {
    name: "image_search",
    description: "Search the user's photos and generated images by prompt text.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search term to match against image prompts" },
      },
      required: ["query"],
    },
    execute: async (input: JsonObject, signal: AbortSignal | undefined, context: AgentContext): Promise<string> => {
      if (!context?.databaseManager) return "Error: database not available";
      try {
        const { databaseManager, dbConfig, userID } = context;
        if (!dbConfig || !userID || !hasGetAgentActivity(databaseManager)) return "Error: database not available";
        const activity = await databaseManager.getAgentActivity(
          dbConfig.dbType, dbConfig.db, dbConfig.connectionString, userID,
          { type: 'image_generation', limit: 100 }
        );
        if (!activity || activity.length === 0) return "No photos found.";
        const query = String(input.query).toLowerCase();
        const matches = activity.filter((e) => (e.prompt || '').toLowerCase().includes(query));
        if (matches.length === 0) return `No photos matching "${String(input.query)}".`;
        return matches.map((entry, i) => {
          const date = entry.timestamp ? new Date(entry.timestamp).toLocaleDateString() : '';
          return `${i + 1}. "${entry.prompt || 'Untitled'}" — ${entry.source || 'user'} — ${date}\n   ${entry.url || '(no url)'}`;
        }).join('\n\n');
      } catch (err) {
        return `Error searching photos: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  },
];

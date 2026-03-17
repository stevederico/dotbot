/**
 * Image generation and management tools
 */

/**
 * Default model for Grok Imagine image generation
 */
export const GROK_IMAGINE_MODEL = 'grok-imagine-image-beta';

/**
 * Generate an image using Grok Imagine API.
 * Shared helper that can be used by both agent tools and HTTP endpoints.
 *
 * @param {string} prompt - Image description
 * @param {string} apiKey - xAI API key
 * @param {Object} [options]
 * @param {AbortSignal} [options.signal] - Abort signal
 * @param {string} [options.model] - Model override (default: grok-imagine-image-beta)
 * @returns {Promise<{ success: boolean, url?: string, prompt?: string, error?: string }>}
 */
export async function generateImage(prompt, apiKey, options = {}) {
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

    const data = await response.json();
    const url = data.data?.[0]?.url;

    if (!url) {
      return { success: false, error: 'No image URL in response' };
    }

    return { success: true, url, prompt };
  } catch (error) {
    if (error.name === 'AbortError') {
      return { success: false, error: 'Request was cancelled' };
    }
    return { success: false, error: error.message };
  }
}

/**
 * Extract visual themes from text and generate an image prompt.
 * Uses Grok to summarize text into a visual description.
 *
 * @param {string} text - Text to extract visual themes from
 * @param {string} apiKey - xAI API key
 * @param {Object} [options]
 * @param {AbortSignal} [options.signal] - Abort signal
 * @param {string} [options.model] - Chat model override (default: grok-4-1-fast-non-reasoning)
 * @returns {Promise<{ success: boolean, prompt?: string, error?: string }>}
 */
export async function extractVisualPrompt(text, apiKey, options = {}) {
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
      const errorText = await response.text();
      return { success: false, error: `Failed to extract visual themes: ${response.status}` };
    }

    const data = await response.json();
    const prompt = data.choices?.[0]?.message?.content;

    if (!prompt) {
      return { success: false, error: 'No visual prompt generated' };
    }

    return { success: true, prompt };
  } catch (error) {
    if (error.name === 'AbortError') {
      return { success: false, error: 'Request was cancelled' };
    }
    return { success: false, error: error.message };
  }
}

/**
 * Generate an image from text, optionally extracting visual themes first.
 * Convenience wrapper combining extractVisualPrompt + generateImage.
 *
 * @param {Object} input
 * @param {string} [input.prompt] - Direct image prompt (takes precedence)
 * @param {string} [input.text] - Text to extract visual themes from
 * @param {string} apiKey - xAI API key
 * @param {Object} [options]
 * @param {AbortSignal} [options.signal] - Abort signal
 * @returns {Promise<{ success: boolean, url?: string, prompt?: string, error?: string }>}
 */
export async function generateImageFromText({ prompt, text }, apiKey, options = {}) {
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

export const imageTools = [
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
    execute: async (input, signal, context) => {
      const apiKey = context?.providers?.xai?.apiKey;
      const result = await generateImage(input.prompt, apiKey, { signal });

      if (!result.success) {
        return result.error;
      }

      return JSON.stringify({ type: 'image', url: result.url, prompt: input.prompt });
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
    execute: async (input, signal, context) => {
      if (!context?.databaseManager) return "Error: database not available";
      try {
        const { databaseManager, dbConfig, userID } = context;
        const activity = await databaseManager.getAgentActivity(
          dbConfig.dbType, dbConfig.db, dbConfig.connectionString, userID,
          { type: 'image_generation', limit: input.limit || 20 }
        );
        if (!activity || activity.length === 0) return "No photos found.";
        return activity.map((entry, i) => {
          const date = entry.timestamp ? new Date(entry.timestamp).toLocaleDateString() : '';
          const source = entry.source || 'user';
          return `${i + 1}. "${entry.prompt || 'Untitled'}" — ${source} — ${date}\n   ${entry.url || '(no url)'}`;
        }).join('\n\n');
      } catch (err) {
        return `Error listing photos: ${err.message}`;
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
    execute: async (input, signal, context) => {
      if (!context?.databaseManager) return "Error: database not available";
      try {
        const { databaseManager, dbConfig, userID } = context;
        const activity = await databaseManager.getAgentActivity(
          dbConfig.dbType, dbConfig.db, dbConfig.connectionString, userID,
          { type: 'image_generation', limit: 100 }
        );
        if (!activity || activity.length === 0) return "No photos found.";
        const query = input.query.toLowerCase();
        const matches = activity.filter(e => (e.prompt || '').toLowerCase().includes(query));
        if (matches.length === 0) return `No photos matching "${input.query}".`;
        return matches.map((entry, i) => {
          const date = entry.timestamp ? new Date(entry.timestamp).toLocaleDateString() : '';
          return `${i + 1}. "${entry.prompt || 'Untitled'}" — ${entry.source || 'user'} — ${date}\n   ${entry.url || '(no url)'}`;
        }).join('\n\n');
      } catch (err) {
        return `Error searching photos: ${err.message}`;
      }
    },
  },
];

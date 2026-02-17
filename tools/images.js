/**
 * Image generation and management tools
 */
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
      try {
        const apiKey = context?.providers?.xai?.apiKey;
        if (!apiKey) return 'Image generation unavailable: xAI API key not configured';

        const res = await fetch('https://api.x.ai/v1/images/generations', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ prompt: input.prompt, model: 'grok-imagine-image-beta', n: 1 }),
          signal,
        });
        if (!res.ok) return `Image generation failed: ${res.status} ${res.statusText}`;
        const data = await res.json();
        const url = data.data?.[0]?.url;
        if (!url) return 'No image URL in response';

        if (context?.databaseManager) {
          try {
            await context.databaseManager.logAgentActivity(
              context.dbConfig.dbType, context.dbConfig.db, context.dbConfig.connectionString,
              context.userID, { type: 'image_generation', prompt: input.prompt, url, source: 'agent' }
            );
          } catch (e) { /* best effort */ }
        }

        return JSON.stringify({ type: 'image', url, prompt: input.prompt });
      } catch (err) {
        return `Error generating image: ${err.message}`;
      }
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

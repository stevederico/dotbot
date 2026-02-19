/**
 * App Generation Tools
 *
 * Generate React components from natural language prompts using AI providers.
 * Returns executable JavaScript code using React.createElement() (no JSX).
 */

import { AI_PROVIDERS } from '../utils/providers.js';

/**
 * System prompt for app generation.
 * Instructs AI to generate React components with specific constraints.
 */
export const APP_GENERATION_PROMPT = `Create a React component named "App" for a desktop window.

CRITICAL: Use React.createElement() - NO JSX allowed. JSX like <div> will fail.

Requirements:
- FIRST LINE: Window size directive // @window WIDTHxHEIGHT
- Choose size based on app type:
  - Small utilities/timers: 400x500 to 500x600
  - Calculators/forms: 500x600 to 650x700
  - Lists/content apps: 650x700 to 800x700
  - Dashboards/editors: 900x750 to 1200x800
- Use: useState, useEffect, useRef (NOT React.useState)
- Styling: Tailwind classes via className with DARK MODE support
- Dark mode: Use dark: prefix for all colors
- Backgrounds: bg-white dark:bg-gray-800
- Text: text-gray-900 dark:text-white
- Borders: border-gray-200 dark:border-gray-700
- Buttons: bg-blue-500 hover:bg-blue-600 dark:bg-blue-600 dark:hover:bg-blue-700
- NEVER use alert(), prompt(), confirm() or any native browser dialogs
- For user input, build inline forms/modals using React state and createElement
- Return ONLY JavaScript code
- NO markdown, NO explanations, NO import/export

Example with window size and dark mode:
// @window 500x600
const App = () => {
  const [count, setCount] = useState(0);
  return React.createElement('div', { className: 'p-6 bg-white dark:bg-gray-800 h-full' },
    React.createElement('h1', { className: 'text-2xl font-bold text-gray-900 dark:text-white mb-4' }, 'Counter App'),
    React.createElement('button', {
      onClick: () => setCount(count + 1),
      className: 'bg-blue-500 hover:bg-blue-600 dark:bg-blue-600 dark:hover:bg-blue-700 text-white px-4 py-2 rounded'
    }, 'Count: ', count)
  );
};`;

/**
 * Clean generated code by removing markdown, normalizing hooks, extracting window size.
 *
 * @param {string} code - Raw AI-generated code
 * @returns {{ code: string, windowSize: { width: number, height: number } }}
 */
export function cleanGeneratedCode(code) {
  if (!code) return { code: '', windowSize: { width: 800, height: 650 } };

  let cleanCode = code
    // Remove markdown code blocks
    .replace(/```javascript/gi, '')
    .replace(/```jsx/gi, '')
    .replace(/```js/gi, '')
    .replace(/```react/gi, '')
    .replace(/```typescript/gi, '')
    .replace(/```tsx/gi, '')
    .replace(/```/g, '')
    // Remove HTML document wrappers
    .replace(/<html[^>]*>[\s\S]*<\/html>/gi, '')
    .replace(/<head[^>]*>[\s\S]*<\/head>/gi, '')
    .replace(/<body[^>]*>([\s\S]*)<\/body>/gi, '$1')
    .replace(/<script[^>]*>[\s\S]*<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*<\/style>/gi, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '')
    .trim();

  // Find component start
  const componentPatterns = [
    /const\s+App\s*=/,
    /function\s+App\s*\(/,
    /export\s+default\s+function/,
    /export\s+function/
  ];

  for (const pattern of componentPatterns) {
    const match = cleanCode.match(pattern);
    if (match && match.index > 0) {
      cleanCode = cleanCode.substring(match.index);
      break;
    }
  }

  // Normalize React hooks (remove React. prefix)
  cleanCode = cleanCode
    .replace(/React\.useState/g, 'useState')
    .replace(/React\.useEffect/g, 'useEffect')
    .replace(/React\.useRef/g, 'useRef')
    .replace(/React\.useCallback/g, 'useCallback')
    .replace(/React\.useMemo/g, 'useMemo')
    .replace(/React\.useContext/g, 'useContext')
    // Remove full-screen classes that break windowed layout
    .replace(/min-h-screen/g, '')
    .replace(/h-screen/g, '')
    .replace(/w-screen/g, '')
    .replace(/fixed\s+inset-0/g, '');

  // Extract window size directive
  const windowMatch = cleanCode.match(/\/\/\s*@window\s+(\d+)x(\d+)/i);
  let windowSize = { width: 800, height: 650 };

  if (windowMatch) {
    windowSize = {
      width: parseInt(windowMatch[1]),
      height: parseInt(windowMatch[2])
    };
    cleanCode = cleanCode.replace(/\/\/\s*@window\s+\d+x\d+\n?/i, '').trim();
  }

  return { code: cleanCode, windowSize };
}

/**
 * Validate that code looks like a valid React component.
 *
 * @param {string} code - Generated code to validate
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateGeneratedCode(code) {
  if (!code || typeof code !== 'string') {
    return { valid: false, error: 'Generated code is empty or invalid' };
  }

  const hasHTMLDoctype = code.includes('<!DOCTYPE') || code.includes('<html') || code.includes('<body');
  if (hasHTMLDoctype) {
    return { valid: false, error: 'Generated code appears to be HTML document instead of React component' };
  }

  const hasReactComponent = code.includes('=>') || code.includes('function') || code.includes('const') || code.includes('return');
  if (!hasReactComponent) {
    return { valid: false, error: 'Generated code is not valid JavaScript' };
  }

  return { valid: true };
}

/**
 * Extract app name from prompt (first 2-3 words).
 *
 * @param {string} prompt - User prompt
 * @returns {string}
 */
export function extractAppName(prompt) {
  const words = prompt.trim().split(/\s+/);
  // Skip action words like "create", "build", "make"
  const actionWords = ['create', 'build', 'make', 'generate', 'write', 'design', 'a', 'an', 'the'];
  const filtered = words.filter(w => !actionWords.includes(w.toLowerCase()));
  return filtered.slice(0, 2).join(' ') || 'Generated App';
}

/**
 * App generation tools array
 */
export const appgenTools = [
  {
    name: 'app_generate',
    description: 'Generate a React app component from a natural language description. Returns executable JavaScript code that uses React.createElement() (no JSX). The code can be executed in a browser with React and hooks in scope.',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Description of the app to generate (e.g., "a todo list app with dark mode" or "a pomodoro timer with sound alerts")'
        },
        provider: {
          type: 'string',
          description: 'AI provider to use for generation (anthropic, openai, xai, cerebras, ollama). Defaults to xai.',
          enum: ['anthropic', 'openai', 'xai', 'cerebras', 'ollama']
        },
        model: {
          type: 'string',
          description: 'Specific model to use. If not provided, uses the provider default.'
        }
      },
      required: ['prompt']
    },
    execute: async (input, signal, context) => {
      const { prompt, provider: providerId = 'xai', model: modelOverride } = input;

      if (!prompt || !prompt.trim()) {
        return JSON.stringify({ success: false, error: 'Prompt is required' });
      }

      // Get provider config
      const provider = AI_PROVIDERS[providerId];
      if (!provider) {
        return JSON.stringify({ success: false, error: `Unknown provider: ${providerId}` });
      }

      // Get API key from context.providers
      const apiKey = context?.providers?.[providerId]?.apiKey;
      if (!provider.local && !apiKey) {
        return JSON.stringify({ success: false, error: `No API key configured for ${provider.name}` });
      }

      const model = modelOverride || provider.defaultModel;

      // Build messages based on provider (Anthropic has no system role)
      const isAnthropic = providerId === 'anthropic';
      const messages = isAnthropic
        ? [{ role: 'user', content: `${APP_GENERATION_PROMPT}\n\nCreate a desktop app: ${prompt}` }]
        : [{ role: 'system', content: APP_GENERATION_PROMPT }, { role: 'user', content: `Create a desktop app: ${prompt}` }];

      try {
        // Make API request with 60s timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 60000);

        // Combine user signal with timeout
        if (signal) {
          signal.addEventListener('abort', () => controller.abort());
        }

        const requestBody = provider.formatRequest(messages, model);
        const headers = provider.headers(apiKey);

        const response = await fetch(`${provider.apiUrl}${provider.endpoint}`, {
          method: 'POST',
          headers,
          body: JSON.stringify(requestBody),
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          const errorText = await response.text();
          return JSON.stringify({
            success: false,
            error: `${provider.name} API error: ${response.status} - ${errorText.slice(0, 200)}`
          });
        }

        const data = await response.json();
        const generatedCode = provider.formatResponse(data);

        if (!generatedCode) {
          return JSON.stringify({ success: false, error: 'No code generated' });
        }

        // Clean and validate code
        const { code: cleanCode, windowSize } = cleanGeneratedCode(generatedCode);
        const validation = validateGeneratedCode(cleanCode);

        if (!validation.valid) {
          return JSON.stringify({ success: false, error: validation.error });
        }

        const appName = extractAppName(prompt);

        return JSON.stringify({
          success: true,
          code: cleanCode,
          appName,
          windowSize,
          provider: providerId,
          model
        });

      } catch (error) {
        if (error.name === 'AbortError') {
          // Could be timeout or user cancellation
          return JSON.stringify({ success: false, error: 'Request timed out or was cancelled' });
        }
        return JSON.stringify({ success: false, error: error.message });
      }
    }
  },

  {
    name: 'app_validate',
    description: 'Validate that generated React component code is syntactically correct and follows the expected structure.',
    parameters: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'The generated React component code to validate'
        }
      },
      required: ['code']
    },
    execute: async (input) => {
      const { code } = input;
      const validation = validateGeneratedCode(code);

      if (!validation.valid) {
        return JSON.stringify({ valid: false, error: validation.error });
      }

      // Additional syntax check - try to parse as function
      try {
        new Function('React', 'useState', 'useEffect', 'useRef', 'useCallback', 'useMemo', code);
        return JSON.stringify({ valid: true });
      } catch (syntaxError) {
        return JSON.stringify({ valid: false, error: `Syntax error: ${syntaxError.message}` });
      }
    }
  }
];

export default appgenTools;

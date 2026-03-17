// tools/browser.js
// Headless browser automation tools for the DotBot agent.
// Provides 7 tools: navigate, read_page, click, type, screenshot, extract, close.
// Uses a singleton Chromium instance with per-user browser contexts (isolated cookies/storage).
// Zero npm dependencies - uses Chrome DevTools Protocol directly.

import { CDPClient } from '../core/cdp.js';
import { launchBrowser, createBrowserContext, closeBrowserContext, killBrowser } from '../core/browser-launcher.js';
import { writeFile, mkdir, readdir, unlink, stat } from 'node:fs/promises';

// ── Constants ──

const MAX_CONTEXTS = 10;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const NAV_TIMEOUT_MS = 30_000;
const SCREENSHOT_DIR = '/tmp/dotbot_screenshots';
const MAX_CONTENT_CHARS = 8000;
const MAX_SCREENSHOTS_PER_USER = 20;
const SCREENSHOT_TTL_MS = 60 * 60 * 1000; // 1 hour
const STALE_SCREENSHOT_MS = 24 * 60 * 60 * 1000; // 24 hours

// ── SSRF Validation ──

/**
 * Validate a URL is safe to navigate to (blocks SSRF).
 * Rejects non-http(s) schemes, localhost, and private IP ranges.
 *
 * @param {string} url - URL to validate
 * @returns {{ valid: boolean, error?: string }} Validation result
 */
function validateUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { valid: false, error: 'Only http and https URLs are allowed' };
    }
    const hostname = parsed.hostname;
    if (
      hostname === 'localhost' ||
      hostname.startsWith('127.') ||
      hostname.startsWith('192.168.') ||
      hostname.startsWith('10.') ||
      hostname.startsWith('172.16.') ||
      hostname.startsWith('172.17.') ||
      hostname.startsWith('172.18.') ||
      hostname.startsWith('172.19.') ||
      hostname.startsWith('172.2') ||
      hostname.startsWith('172.30.') ||
      hostname.startsWith('172.31.') ||
      hostname === '0.0.0.0' ||
      hostname === '[::1]'
    ) {
      return { valid: false, error: 'Private/local URLs are not allowed' };
    }
    return { valid: true };
  } catch {
    return { valid: false, error: 'Invalid URL' };
  }
}

// ── BrowserSessionManager (singleton) ──

/**
 * Manages a shared Chromium browser instance with per-user contexts.
 * LRU eviction at MAX_CONTEXTS, idle timeout per context, graceful shutdown.
 */
class BrowserSessionManager {
  constructor() {
    /** @type {{ process: ChildProcess, port: number, wsUrl: string }|null} */
    this.browser = null;
    /** @type {Map<string, { cdp: CDPClient, targetWsUrl: string, lastUsed: number, idleTimer: NodeJS.Timeout }>} */
    this.contexts = new Map();
  }

  /**
   * Launch the shared Chromium instance if not already running.
   * @returns {Promise<{ process: ChildProcess, port: number, wsUrl: string }>}
   */
  async ensureBrowser() {
    if (!this.browser || this.browser.process.killed) {
      this.browser = await launchBrowser();
      console.log('[browser] Chromium launched');
    }
    return this.browser;
  }

  /**
   * Get or create a browser context + CDP client for a user.
   * Resets idle timer on each access. Evicts LRU context if at capacity.
   *
   * @param {string} userID - User identifier for context isolation
   * @returns {Promise<CDPClient>} The user's CDP client
   */
  async getClient(userID) {
    const existing = this.contexts.get(userID);
    if (existing) {
      existing.lastUsed = Date.now();
      clearTimeout(existing.idleTimer);
      existing.idleTimer = setTimeout(() => this.closeContext(userID), IDLE_TIMEOUT_MS);
      return existing.cdp;
    }

    // Evict LRU if at capacity
    if (this.contexts.size >= MAX_CONTEXTS) {
      let oldest = null;
      let oldestId = null;
      for (const [id, entry] of this.contexts) {
        if (!oldest || entry.lastUsed < oldest.lastUsed) {
          oldest = entry;
          oldestId = id;
        }
      }
      if (oldestId) await this.closeContext(oldestId);
    }

    const browser = await this.ensureBrowser();

    // Create new tab/context
    const targetWsUrl = await createBrowserContext(browser.wsUrl);

    // Connect CDP client to the new target
    const cdp = new CDPClient(targetWsUrl);
    await cdp.connect();

    // Set viewport and user agent
    await cdp.setViewport(1280, 720);
    await cdp.send('Network.setUserAgentOverride', {
      userAgent: 'DotBot/1.0 (Headless Browser)'
    });

    const idleTimer = setTimeout(() => this.closeContext(userID), IDLE_TIMEOUT_MS);
    this.contexts.set(userID, { cdp, targetWsUrl, lastUsed: Date.now(), idleTimer });

    return cdp;
  }

  /**
   * Close a single user's browser context and clean up.
   * @param {string} userID - User whose context to close
   */
  async closeContext(userID) {
    const entry = this.contexts.get(userID);
    if (!entry) return;

    clearTimeout(entry.idleTimer);
    this.contexts.delete(userID);

    try {
      entry.cdp.close();
      await closeBrowserContext(entry.targetWsUrl);
    } catch {
      // Context may already be closed
    }

    console.log(`[browser] context closed for user ${userID}`);
  }

  /**
   * Close all contexts and the browser instance. Called during graceful shutdown.
   */
  async closeAll() {
    for (const [userID] of this.contexts) {
      await this.closeContext(userID);
    }
    if (this.browser) {
      try {
        killBrowser(this.browser.process);
      } catch {
        // Browser may already be closed
      }
      this.browser = null;
      console.log('[browser] Chromium closed');
    }
  }
}

export const sessionManager = new BrowserSessionManager();

// ── Screenshot Cleanup ──

/**
 * Prune old screenshots for a specific user.
 * Deletes files older than SCREENSHOT_TTL_MS, then enforces MAX_SCREENSHOTS_PER_USER
 * by removing oldest files first. Best-effort — errors are logged, not thrown.
 *
 * @param {string} userID - User whose screenshots to prune
 */
async function pruneScreenshots(userID) {
  try {
    const files = await readdir(SCREENSHOT_DIR);
    const userFiles = files.filter(f => f.startsWith(`${userID}_`) && f.endsWith('.png'));
    if (userFiles.length === 0) return;

    const now = Date.now();
    const withStats = await Promise.all(
      userFiles.map(async (name) => {
        const path = `${SCREENSHOT_DIR}/${name}`;
        const s = await stat(path).catch(() => null);
        return s ? { name, path, mtimeMs: s.mtimeMs } : null;
      })
    );
    const valid = withStats.filter(Boolean).sort((a, b) => b.mtimeMs - a.mtimeMs);

    // Delete files older than TTL
    const expired = valid.filter(f => now - f.mtimeMs > SCREENSHOT_TTL_MS);
    for (const f of expired) {
      await unlink(f.path).catch(() => {});
    }

    // Enforce per-user cap on remaining files
    const remaining = valid.filter(f => now - f.mtimeMs <= SCREENSHOT_TTL_MS);
    if (remaining.length > MAX_SCREENSHOTS_PER_USER) {
      const excess = remaining.slice(MAX_SCREENSHOTS_PER_USER);
      for (const f of excess) {
        await unlink(f.path).catch(() => {});
      }
    }

    const deleted = expired.length + Math.max(0, remaining.length - MAX_SCREENSHOTS_PER_USER);
    if (deleted > 0) {
      console.log(`[browser] pruned ${deleted} screenshot(s) for user ${userID}`);
    }
  } catch {
    // Directory may not exist yet — that's fine
  }
}

/**
 * Remove stale screenshots (>24h) from the screenshot directory.
 * Called once at server startup to reclaim disk space from previous runs.
 */
export async function cleanupStaleScreenshots() {
  try {
    const files = await readdir(SCREENSHOT_DIR);
    const now = Date.now();
    let deleted = 0;

    for (const name of files) {
      if (!name.endsWith('.png')) continue;
      const path = `${SCREENSHOT_DIR}/${name}`;
      const s = await stat(path).catch(() => null);
      if (s && now - s.mtimeMs > STALE_SCREENSHOT_MS) {
        await unlink(path).catch(() => {});
        deleted++;
      }
    }

    if (deleted > 0) {
      console.log(`[browser] startup cleanup: removed ${deleted} stale screenshot(s)`);
    }
  } catch {
    // Directory may not exist — that's fine
  }
}

// ── Helpers ──

/**
 * Build a structured summary of interactive elements on the page via DOM evaluation.
 *
 * @param {CDPClient} cdp - CDP client instance
 * @returns {Promise<string>} Formatted element tree
 */
async function getPageStructure(cdp) {
  return await cdp.evaluate(`
    (() => {
      const INTERACTIVE = 'a,button,input,select,textarea,[role=button],[role=link],[role=tab],[role=menuitem]';
      const lines = [];
      const els = document.querySelectorAll(INTERACTIVE);
      for (const el of els) {
        if (el.offsetParent === null && el.tagName !== 'INPUT') continue;
        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute('role') || tag;
        const name =
          el.getAttribute('aria-label') ||
          el.innerText?.slice(0, 60).replace(/\\n/g, ' ').trim() ||
          el.getAttribute('placeholder') ||
          el.getAttribute('name') ||
          '';
        const type = el.getAttribute('type') || '';
        const href = el.getAttribute('href') || '';
        let line = '[' + role + ']';
        if (name) line += ' "' + name + '"';
        if (type) line += ' type=' + type;
        if (href) line += ' href="' + href.slice(0, 80) + '"';
        lines.push(line);
      }
      const headings = document.querySelectorAll('h1,h2,h3');
      for (const h of headings) {
        const text = h.innerText?.trim();
        if (text) lines.push('[' + h.tagName.toLowerCase() + '] "' + text.slice(0, 80) + '"');
      }
      return lines.length > 0 ? lines.join('\\n') : 'No interactive elements found.';
    })()
  `);
}

// ── Tool Definitions ──

/**
 * Create browser automation tools with configurable screenshot URL pattern
 *
 * @param {Function} screenshotUrlPattern - Function (filename) => URL string
 * @returns {Array} Browser tool definitions
 */
export function createBrowserTools(screenshotUrlPattern = (filename) => `/api/agent/screenshots/${filename}`) {
  return [
    {
      name: 'browser_navigate',
      description:
        'Navigate a headless browser to a URL and return the page title and text content. PREFERRED tool for reading web pages — renders JavaScript so it works on dynamic sites (live scores, SPAs, dashboards). Use this instead of calling web_search multiple times.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The URL to navigate to (must be http or https)'
          }
        },
        required: ['url']
      },
      execute: async (input, signal, context) => {
        const check = validateUrl(input.url);
        if (!check.valid) return `Error: ${check.error}`;

        try {
          const cdp = await sessionManager.getClient(context.userID);
          await cdp.navigate(input.url);

          // Wait for load event then network idle for SPAs
          await cdp.waitForLoad(NAV_TIMEOUT_MS).catch(() => {});
          await cdp.waitForNetworkIdle({ timeout: 5000, idleTime: 300 });

          const title = await cdp.getTitle();
          const currentUrl = await cdp.getUrl();
          let text = await cdp.getBodyText();

          if (text.length > MAX_CONTENT_CHARS) {
            text = text.slice(0, MAX_CONTENT_CHARS) + `\n\n... [truncated, ${text.length} chars total]`;
          }

          return JSON.stringify({
            action: 'browser_update',
            url: currentUrl,
            title,
            content: text
          });
        } catch (err) {
          return `Error navigating to ${input.url}: ${err.message}`;
        }
      }
    },

    {
      name: 'browser_read_page',
      description:
        "Read the current page content or a specific section. Use 'text' mode for readable text, 'accessibility' mode for a structured element tree (useful before clicking or typing).",
      parameters: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            description: "'text' for page text content, 'accessibility' for element tree. Default: 'text'"
          },
          selector: {
            type: 'string',
            description: 'Optional CSS selector to scope reading to a specific element'
          }
        }
      },
      execute: async (input, signal, context) => {
        try {
          const cdp = await sessionManager.getClient(context.userID);
          const currentUrl = await cdp.getUrl();

          if (currentUrl === 'about:blank') {
            return 'No page loaded. Use browser_navigate first.';
          }

          if (input.mode === 'accessibility') {
            const tree = await getPageStructure(cdp);
            if (!tree) return 'No page structure available.';
            if (tree.length > MAX_CONTENT_CHARS) {
              return `Page: ${currentUrl}\n\n${tree.slice(0, MAX_CONTENT_CHARS)}\n... [truncated]`;
            }
            return `Page: ${currentUrl}\n\n${tree}`;
          }

          // Default: text mode
          let text;
          if (input.selector) {
            text = await cdp.getText(input.selector);
          } else {
            text = await cdp.getBodyText();
          }

          if (!text) {
            return `No text content found${input.selector ? ` for selector "${input.selector}"` : ''}.`;
          }

          if (text.length > MAX_CONTENT_CHARS) {
            text = text.slice(0, MAX_CONTENT_CHARS) + `\n\n... [truncated, ${text.length} chars total]`;
          }

          return `Page: ${currentUrl}\n\n${text}`;
        } catch (err) {
          return `Error reading page: ${err.message}`;
        }
      }
    },

    {
      name: 'browser_click',
      description:
        "Click an element on the current page by CSS selector or visible text. Use browser_read_page with 'accessibility' mode first to find the right selector or text.",
      parameters: {
        type: 'object',
        properties: {
          selector: {
            type: 'string',
            description: "CSS selector of the element to click (e.g. 'button.submit', '#login-btn')"
          },
          text: {
            type: 'string',
            description: "Visible text of the element to click (e.g. 'Sign In', 'Next'). Used if selector is not provided."
          }
        }
      },
      execute: async (input, signal, context) => {
        if (!input.selector && !input.text) {
          return "Error: provide either 'selector' or 'text' to identify the element.";
        }

        try {
          const cdp = await sessionManager.getClient(context.userID);
          const currentUrl = await cdp.getUrl();

          if (currentUrl === 'about:blank') {
            return 'No page loaded. Use browser_navigate first.';
          }

          // Use retry helpers for more reliable clicking
          if (input.selector) {
            await cdp.clickWithRetry(input.selector);
          } else {
            // For text-based clicking, use retry wrapper
            await cdp.retry(async () => {
              const el = await cdp.getByText(input.text);
              if (!el) throw new Error(`Element with text "${input.text}" not found`);
              await cdp.click(el.x, el.y);
            });
          }

          // Wait for network to settle after click
          await cdp.waitForNetworkIdle({ timeout: 5000, idleTime: 300 });

          const title = await cdp.getTitle();
          const newUrl = await cdp.getUrl();

          return JSON.stringify({
            action: 'browser_update',
            url: newUrl,
            title,
            clicked: input.selector || input.text
          });
        } catch (err) {
          return `Error clicking element: ${err.message}`;
        }
      }
    },

    {
      name: 'browser_type',
      description:
        'Type text into an input field on the current page. Finds the field by CSS selector, label, or placeholder text.',
      parameters: {
        type: 'object',
        properties: {
          selector: {
            type: 'string',
            description: "CSS selector of the input (e.g. 'input[name=email]', '#search')"
          },
          label: {
            type: 'string',
            description: 'Label text of the input field. Used if selector is not provided.'
          },
          placeholder: {
            type: 'string',
            description: 'Placeholder text of the input field. Used if selector and label are not provided.'
          },
          text: {
            type: 'string',
            description: 'Text to type into the field'
          },
          submit: {
            type: 'boolean',
            description: 'Press Enter after typing (to submit a form). Default: false'
          }
        },
        required: ['text']
      },
      execute: async (input, signal, context) => {
        try {
          const cdp = await sessionManager.getClient(context.userID);
          const currentUrl = await cdp.getUrl();

          if (currentUrl === 'about:blank') {
            return 'No page loaded. Use browser_navigate first.';
          }

          // Determine selector to use
          let selector;
          if (input.selector) {
            selector = input.selector;
          } else if (input.label) {
            // Find input by label
            const labelSelector = await cdp.evaluate(`
              (() => {
                const label = Array.from(document.querySelectorAll('label')).find(l =>
                  l.textContent.toLowerCase().includes('${input.label.toLowerCase().replace(/'/g, "\\'")}')
                );
                if (label && label.htmlFor) {
                  return '#' + label.htmlFor;
                }
                const input = label?.querySelector('input,textarea');
                if (input) {
                  return input.tagName.toLowerCase() + (input.id ? '#' + input.id : '[name="' + input.name + '"]');
                }
                return null;
              })()
            `);
            if (!labelSelector) {
              return `No input found with label "${input.label}"`;
            }
            selector = labelSelector;
          } else if (input.placeholder) {
            selector = `input[placeholder*="${input.placeholder}"],textarea[placeholder*="${input.placeholder}"]`;
          } else {
            // Fallback: first visible input
            selector = 'input:not([type=hidden]),textarea';
          }

          await cdp.fillWithRetry(selector, input.text);

          if (input.submit) {
            await cdp.press('Enter');
            await cdp.waitForNetworkIdle({ timeout: 5000, idleTime: 300 });
          }

          const title = await cdp.getTitle();
          const newUrl = await cdp.getUrl();

          return JSON.stringify({
            action: 'browser_update',
            url: newUrl,
            title,
            typed: input.text.slice(0, 50),
            submitted: input.submit || false
          });
        } catch (err) {
          return `Error typing into field: ${err.message}`;
        }
      }
    },

    {
      name: 'browser_screenshot',
      description:
        'Take a screenshot of the current page and save it as a PNG. Returns an accessibility summary of the page and the screenshot URL.',
      parameters: {
        type: 'object',
        properties: {
          full_page: {
            type: 'boolean',
            description: 'Capture the full scrollable page instead of just the viewport. Default: false'
          },
          selector: {
            type: 'string',
            description: 'CSS selector to screenshot a specific element instead of the whole page'
          }
        }
      },
      execute: async (input, signal, context) => {
        try {
          const cdp = await sessionManager.getClient(context.userID);
          const currentUrl = await cdp.getUrl();

          if (currentUrl === 'about:blank') {
            return 'No page loaded. Use browser_navigate first.';
          }

          await mkdir(SCREENSHOT_DIR, { recursive: true });
          const filename = `${context.userID}_${Date.now()}.png`;
          const filepath = `${SCREENSHOT_DIR}/${filename}`;

          let buffer;
          if (input.selector) {
            buffer = await cdp.screenshotElement(input.selector);
          } else {
            buffer = await cdp.screenshot({ fullPage: input.full_page || false });
          }

          await writeFile(filepath, buffer);

          // Prune old screenshots (best-effort, non-blocking)
          pruneScreenshots(context.userID).catch(() => {});

          // Build page summary for the agent LLM
          const title = await cdp.getTitle();
          const screenshotUrl = screenshotUrlPattern(filename);
          let pageSummary = `Page: ${title} (${currentUrl})`;

          const tree = await getPageStructure(cdp).catch(() => null);
          if (tree) {
            const trimmed = tree.length > 2000 ? tree.slice(0, 2000) + '\n... [truncated]' : tree;
            pageSummary += `\n\nPage structure:\n${trimmed}`;
          }

          // Return image JSON so frontend renders the screenshot inline
          return JSON.stringify({ type: 'image', url: screenshotUrl, prompt: pageSummary });
        } catch (err) {
          return `Error taking screenshot: ${err.message}`;
        }
      }
    },

    {
      name: 'browser_extract',
      description:
        'Extract structured data from the current page using CSS selectors. Returns an array of objects with the requested fields.',
      parameters: {
        type: 'object',
        properties: {
          selector: {
            type: 'string',
            description: "CSS selector for the repeating container elements (e.g. '.product-card', 'tr.result')"
          },
          fields: {
            type: 'object',
            description:
              'Map of field names to CSS selectors relative to each container (e.g. { "title": "h3", "price": ".price" })'
          },
          limit: {
            type: 'number',
            description: 'Max number of items to extract. Default: 20'
          }
        },
        required: ['selector', 'fields']
      },
      execute: async (input, signal, context) => {
        try {
          const cdp = await sessionManager.getClient(context.userID);
          const currentUrl = await cdp.getUrl();

          if (currentUrl === 'about:blank') {
            return 'No page loaded. Use browser_navigate first.';
          }

          const limit = input.limit || 20;
          const fieldsJson = JSON.stringify(input.fields);

          const results = await cdp.evaluate(`
            (() => {
              const containers = document.querySelectorAll('${input.selector.replace(/'/g, "\\'")}');
              const fields = ${fieldsJson};
              const limit = ${limit};
              const results = [];

              for (let i = 0; i < Math.min(containers.length, limit); i++) {
                const container = containers[i];
                const item = {};
                for (const [fieldName, fieldSelector] of Object.entries(fields)) {
                  const el = container.querySelector(fieldSelector);
                  item[fieldName] = el?.innerText || '';
                }
                results.push(item);
              }

              return results;
            })()
          `);

          if (!results || results.length === 0) {
            return `No elements found matching "${input.selector}".`;
          }

          const json = JSON.stringify(results, null, 2);
          if (json.length > MAX_CONTENT_CHARS) {
            return json.slice(0, MAX_CONTENT_CHARS) + '\n... [truncated]';
          }
          return json;
        } catch (err) {
          return `Error extracting data: ${err.message}`;
        }
      }
    },

    {
      name: 'browser_close',
      description: "Close the current browser session. Use this when you're done browsing to free resources.",
      parameters: {
        type: 'object',
        properties: {}
      },
      execute: async (input, signal, context) => {
        await sessionManager.closeContext(context.userID);
        return JSON.stringify({ action: 'browser_closed' });
      }
    }
  ];
}

// Export default tools with default screenshot pattern
export const browserTools = createBrowserTools();

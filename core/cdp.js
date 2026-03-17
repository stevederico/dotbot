// core/cdp.js
// Minimal Chrome DevTools Protocol client using Node.js built-in WebSocket.
// Zero external dependencies - requires Node.js 22+.

/**
 * Lightweight CDP client for browser automation.
 * Communicates with Chrome via DevTools Protocol over WebSocket.
 */
export class CDPClient {
  /**
   * Create a CDP client instance.
   * @param {string} wsUrl - WebSocket debugger URL from Chrome
   */
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.id = 0;
    this.pending = new Map();
    this.eventHandlers = new Map();
  }

  /**
   * Connect to the browser's WebSocket debugger endpoint.
   * @returns {Promise<void>}
   */
  async connect() {
    return new Promise((resolve, reject) => {
      // Use Node.js 22+ native WebSocket (global, browser-compatible API)
      this.ws = new WebSocket(this.wsUrl);

      this.ws.addEventListener('open', () => {
        resolve();
      });

      this.ws.addEventListener('error', (event) => {
        reject(new Error(`CDP connection failed: ${event.message || 'Unknown error'}`));
      });

      this.ws.addEventListener('message', (event) => {
        const msg = JSON.parse(event.data);

        // Handle responses to our requests
        if (msg.id !== undefined) {
          const handler = this.pending.get(msg.id);
          if (handler) {
            this.pending.delete(msg.id);
            if (msg.error) {
              handler.reject(new Error(msg.error.message));
            } else {
              handler.resolve(msg.result);
            }
          }
        }

        // Handle events
        if (msg.method) {
          const handlers = this.eventHandlers.get(msg.method);
          if (handlers) {
            for (const fn of handlers) {
              fn(msg.params);
            }
          }
        }
      });

      this.ws.addEventListener('close', () => {
        // Reject all pending requests
        for (const [, handler] of this.pending) {
          handler.reject(new Error('CDP connection closed'));
        }
        this.pending.clear();
      });
    });
  }

  /**
   * Send a CDP command and wait for response.
   * @param {string} method - CDP method name (e.g., 'Page.navigate')
   * @param {Object} params - Command parameters
   * @param {number} timeout - Timeout in ms (default 30s)
   * @returns {Promise<Object>} Command result
   */
  async send(method, params = {}, timeout = 30000) {
    if (!this.ws || this.ws.readyState !== 1) { // 1 = OPEN
      throw new Error('CDP not connected');
    }

    const id = ++this.id;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, timeout);

      this.pending.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        }
      });

      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /**
   * Subscribe to a CDP event.
   * @param {string} event - Event name (e.g., 'Page.loadEventFired')
   * @param {Function} handler - Event handler function
   */
  on(event, handler) {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event).add(handler);
  }

  /**
   * Unsubscribe from a CDP event.
   * @param {string} event - Event name
   * @param {Function} handler - Handler to remove
   */
  off(event, handler) {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      handlers.delete(handler);
    }
  }

  /**
   * Navigate to a URL.
   * @param {string} url - URL to navigate to
   * @returns {Promise<Object>} Navigation result with frameId
   */
  async navigate(url) {
    await this.send('Page.enable');
    return this.send('Page.navigate', { url });
  }

  /**
   * Wait for the page to finish loading.
   * @param {number} timeout - Timeout in ms
   * @returns {Promise<void>}
   */
  async waitForLoad(timeout = 30000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('Page.loadEventFired', handler);
        reject(new Error('Page load timed out'));
      }, timeout);

      const handler = () => {
        clearTimeout(timer);
        this.off('Page.loadEventFired', handler);
        resolve();
      };

      this.on('Page.loadEventFired', handler);
    });
  }

  /**
   * Evaluate JavaScript in the page context.
   * @param {string} expression - JavaScript expression to evaluate
   * @returns {Promise<any>} Result value
   */
  async evaluate(expression) {
    await this.send('Runtime.enable');
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    });

    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || 'Evaluation failed');
    }

    return result.result?.value;
  }

  /** Get the page title. */
  async getTitle() {
    return this.evaluate('document.title');
  }

  /** Get the current URL. */
  async getUrl() {
    return this.evaluate('window.location.href');
  }

  /** Get text content of the page body. */
  async getBodyText() {
    return this.evaluate('document.body?.innerText || ""');
  }

  /** Get text content of an element by CSS selector. */
  async getText(selector) {
    const escaped = selector.replace(/"/g, '\\"');
    return this.evaluate(`document.querySelector("${escaped}")?.innerText || ""`);
  }

  /**
   * Query a selector and return element info for clicking.
   * @param {string} selector - CSS selector
   * @returns {Promise<{x: number, y: number}|null>} Element center coordinates
   */
  async querySelector(selector) {
    await this.send('DOM.enable');
    const doc = await this.send('DOM.getDocument');
    const result = await this.send('DOM.querySelector', {
      nodeId: doc.root.nodeId,
      selector
    });

    if (!result.nodeId) return null;

    const boxes = await this.send('DOM.getBoxModel', { nodeId: result.nodeId });
    if (!boxes.model) return null;

    // Get center point of the content box
    const content = boxes.model.content;
    const x = (content[0] + content[2] + content[4] + content[6]) / 4;
    const y = (content[1] + content[3] + content[5] + content[7]) / 4;

    return { x, y, nodeId: result.nodeId };
  }

  /**
   * Find element by text content.
   * @param {string} text - Text to search for
   * @param {boolean} exact - Exact match (default: false)
   * @returns {Promise<{x: number, y: number}|null>}
   */
  async getByText(text, exact = false) {
    const escaped = text.replace(/"/g, '\\"').replace(/\n/g, '\\n');
    const xpath = exact
      ? `//*[text()="${escaped}"]`
      : `//*[contains(text(), "${escaped}")]`;

    await this.send('DOM.enable');
    const doc = await this.send('DOM.getDocument');

    const result = await this.send('DOM.performSearch', {
      query: xpath,
      includeUserAgentShadowDOM: false
    });

    if (!result.resultCount) return null;

    const nodes = await this.send('DOM.getSearchResults', {
      searchId: result.searchId,
      fromIndex: 0,
      toIndex: 1
    });

    await this.send('DOM.discardSearchResults', { searchId: result.searchId });

    if (!nodes.nodeIds?.length) return null;

    const boxes = await this.send('DOM.getBoxModel', { nodeId: nodes.nodeIds[0] });
    if (!boxes.model) return null;

    const content = boxes.model.content;
    const x = (content[0] + content[2] + content[4] + content[6]) / 4;
    const y = (content[1] + content[3] + content[5] + content[7]) / 4;

    return { x, y, nodeId: nodes.nodeIds[0] };
  }

  /**
   * Click at specific coordinates.
   * @param {number} x - X coordinate
   * @param {number} y - Y coordinate
   */
  async click(x, y) {
    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      clickCount: 1
    });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      clickCount: 1
    });
  }

  /**
   * Type text character by character.
   * @param {string} text - Text to type
   */
  async type(text) {
    for (const char of text) {
      await this.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        text: char
      });
      await this.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        text: char
      });
    }
  }

  /**
   * Press a special key (Enter, Tab, etc).
   * @param {string} key - Key name
   */
  async press(key) {
    const keyMap = {
      'Enter': { key: 'Enter', code: 'Enter', keyCode: 13 },
      'Tab': { key: 'Tab', code: 'Tab', keyCode: 9 },
      'Escape': { key: 'Escape', code: 'Escape', keyCode: 27 },
      'Backspace': { key: 'Backspace', code: 'Backspace', keyCode: 8 }
    };

    const keyInfo = keyMap[key] || { key, code: key };

    await this.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      ...keyInfo
    });
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      ...keyInfo
    });
  }

  /**
   * Focus an input element and fill it with text.
   * @param {string} selector - CSS selector for the input
   * @param {string} text - Text to fill
   */
  async fill(selector, text) {
    const el = await this.querySelector(selector);
    if (!el) throw new Error(`Input not found: ${selector}`);

    // Focus the element
    await this.send('DOM.focus', { nodeId: el.nodeId });

    // Clear existing value
    await this.evaluate(`document.querySelector("${selector.replace(/"/g, '\\"')}").value = ""`);

    // Type the text
    await this.type(text);
  }

  /**
   * Take a screenshot of the page.
   * @param {Object} options - Screenshot options
   * @param {boolean} options.fullPage - Capture full scrollable page
   * @returns {Promise<Buffer>} PNG image buffer
   */
  async screenshot(options = {}) {
    const params = { format: 'png' };

    if (options.fullPage) {
      // Get full page dimensions
      const metrics = await this.send('Page.getLayoutMetrics');
      params.clip = {
        x: 0,
        y: 0,
        width: metrics.contentSize.width,
        height: metrics.contentSize.height,
        scale: 1
      };
      params.captureBeyondViewport = true;
    }

    const result = await this.send('Page.captureScreenshot', params);
    return Buffer.from(result.data, 'base64');
  }

  /**
   * Screenshot a specific element.
   * @param {string} selector - CSS selector
   * @returns {Promise<Buffer>} PNG image buffer
   */
  async screenshotElement(selector) {
    const el = await this.querySelector(selector);
    if (!el) throw new Error(`Element not found: ${selector}`);

    const boxes = await this.send('DOM.getBoxModel', { nodeId: el.nodeId });
    const border = boxes.model.border;

    const x = Math.min(border[0], border[2], border[4], border[6]);
    const y = Math.min(border[1], border[3], border[5], border[7]);
    const width = Math.max(border[0], border[2], border[4], border[6]) - x;
    const height = Math.max(border[1], border[3], border[5], border[7]) - y;

    const result = await this.send('Page.captureScreenshot', {
      format: 'png',
      clip: { x, y, width, height, scale: 1 }
    });

    return Buffer.from(result.data, 'base64');
  }

  /**
   * Set viewport size.
   * @param {number} width - Viewport width
   * @param {number} height - Viewport height
   */
  async setViewport(width, height) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false
    });
  }

  /** Close the CDP connection. */
  close() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  // ── Retry & Wait Helpers ──

  /**
   * Retry a function with exponential backoff.
   * @param {Function} fn - Async function to retry
   * @param {Object} options - Retry options
   * @param {number} options.retries - Max retry attempts (default: 3)
   * @param {number} options.delay - Initial delay in ms (default: 100)
   * @param {number} options.maxDelay - Max delay in ms (default: 2000)
   * @returns {Promise<any>} Function result
   */
  async retry(fn, { retries = 3, delay = 100, maxDelay = 2000 } = {}) {
    let lastError;
    for (let i = 0; i <= retries; i++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        if (i < retries) {
          const wait = Math.min(delay * Math.pow(2, i), maxDelay);
          await new Promise(r => setTimeout(r, wait));
        }
      }
    }
    throw lastError;
  }

  /**
   * Wait for network to be idle (no requests for a period).
   * @param {Object} options - Wait options
   * @param {number} options.timeout - Timeout in ms (default: 10000)
   * @param {number} options.idleTime - Idle time to wait in ms (default: 500)
   * @returns {Promise<void>}
   */
  async waitForNetworkIdle({ timeout = 10000, idleTime = 500 } = {}) {
    await this.send('Network.enable');

    return new Promise((resolve, reject) => {
      let pending = 0;
      let idleTimer = null;
      const timeoutTimer = setTimeout(() => {
        cleanup();
        resolve(); // Don't reject on timeout, just continue
      }, timeout);

      const checkIdle = () => {
        if (pending === 0) {
          idleTimer = setTimeout(() => {
            cleanup();
            resolve();
          }, idleTime);
        }
      };

      const onRequestWillBeSent = () => {
        pending++;
        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = null;
        }
      };

      const onLoadingFinished = () => {
        pending = Math.max(0, pending - 1);
        checkIdle();
      };

      const onLoadingFailed = () => {
        pending = Math.max(0, pending - 1);
        checkIdle();
      };

      const cleanup = () => {
        clearTimeout(timeoutTimer);
        if (idleTimer) clearTimeout(idleTimer);
        this.off('Network.requestWillBeSent', onRequestWillBeSent);
        this.off('Network.loadingFinished', onLoadingFinished);
        this.off('Network.loadingFailed', onLoadingFailed);
      };

      this.on('Network.requestWillBeSent', onRequestWillBeSent);
      this.on('Network.loadingFinished', onLoadingFinished);
      this.on('Network.loadingFailed', onLoadingFailed);

      // Check if already idle
      checkIdle();
    });
  }

  /**
   * Wait for element to be visible (has dimensions).
   * @param {string} selector - CSS selector
   * @param {Object} options - Wait options
   * @param {number} options.timeout - Timeout in ms (default: 5000)
   * @returns {Promise<{x: number, y: number, nodeId: number}>} Element info
   */
  async waitForVisible(selector, { timeout = 5000 } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        const el = await this.querySelector(selector);
        if (el && el.x > 0 && el.y > 0) return el;
      } catch {
        // Element may not exist yet
      }
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error(`Timeout waiting for visible element: ${selector}`);
  }

  /**
   * Click an element with auto-retry and wait.
   * @param {string} selector - CSS selector
   * @param {Object} options - Click options
   * @param {number} options.timeout - Wait timeout in ms (default: 5000)
   * @param {number} options.retries - Retry attempts (default: 2)
   */
  async clickWithRetry(selector, { timeout = 5000, retries = 2 } = {}) {
    const el = await this.waitForVisible(selector, { timeout });
    await this.retry(() => this.click(el.x, el.y), { retries });
  }

  /**
   * Fill an input with auto-retry and wait.
   * @param {string} selector - CSS selector
   * @param {string} text - Text to fill
   * @param {Object} options - Fill options
   * @param {number} options.timeout - Wait timeout in ms (default: 5000)
   */
  async fillWithRetry(selector, text, { timeout = 5000 } = {}) {
    await this.waitForVisible(selector, { timeout });
    await this.retry(() => this.fill(selector, text));
  }
}

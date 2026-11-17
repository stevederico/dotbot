
/// <reference types="node" />

interface PendingRequest {
  resolve: (result: CDPResult) => void;
  reject: (err: Error) => void;
}

type CDPResult = Record<string, unknown>;

type CDPEventParams = Record<string, unknown>;

type CDPEventHandler = (params: CDPEventParams) => void;

interface CDPMessage {
  id?: number;
  error?: { message: string };
  result?: CDPResult;
  method?: string;
  params?: CDPEventParams;
}

interface ElementInfo {
  x: number;
  y: number;
  nodeId: number;
}

interface ScreenshotOptions {
  fullPage?: boolean;
}

interface RetryOptions {
  retries?: number;
  delay?: number;
  maxDelay?: number;
}

interface NetworkIdleOptions {
  timeout?: number;
  idleTime?: number;
}

interface WaitOptions {
  timeout?: number;
}

interface ClickWithRetryOptions {
  timeout?: number;
  retries?: number;
}

interface KeyInfo {
  key: string;
  code: string;
  keyCode?: number;
}

type Quad = [number, number, number, number, number, number, number, number];

interface BoxModel {
  content: Quad;
  border: Quad;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asQuad(value: unknown): Quad | null {
  if (!Array.isArray(value) || value.length < 8) return null;
  for (let i = 0; i < 8; i++) {
    if (typeof value[i] !== "number") return null;
  }
  return [
    value[0], value[1], value[2], value[3],
    value[4], value[5], value[6], value[7],
  ];
}

function asBoxModel(boxes: CDPResult): BoxModel | null {
  const model = boxes.model;
  if (!isRecord(model)) return null;
  const content = asQuad(model.content);
  const border = asQuad(model.border);
  if (!content || !border) return null;
  return { content, border };
}

function asCDPMessage(value: unknown): CDPMessage {
  if (!isRecord(value)) {
    return {};
  }
  const obj = value;
  const msg: CDPMessage = {};
  if (typeof obj.id === "number") msg.id = obj.id;
  if (typeof obj.method === "string") msg.method = obj.method;
  if (isRecord(obj.error)) {
    const err = obj.error;
    msg.error = { message: typeof err.message === "string" ? err.message : "" };
  }
  if (isRecord(obj.result)) {
    msg.result = obj.result;
  }
  if (isRecord(obj.params)) {
    msg.params = obj.params;
  }
  return msg;
}

function numField(obj: unknown, key: string, fallback: number): number {
  if (isRecord(obj)) {
    const v = obj[key];
    if (typeof v === "number") return v;
  }
  return fallback;
}

export class CDPClient {
  wsUrl: string;
  ws: WebSocket | null;
  id: number;
  pending: Map<number, PendingRequest>;
  eventHandlers: Map<string, Set<CDPEventHandler>>;

  constructor(wsUrl: string) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.id = 0;
    this.pending = new Map();
    this.eventHandlers = new Map();
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);

      this.ws.addEventListener('open', () => {
        resolve();
      });

      this.ws.addEventListener('error', (event: Event) => {
        const maybeMessage = (event as { message?: unknown }).message;
        const message = typeof maybeMessage === "string" ? maybeMessage : 'Unknown error';
        reject(new Error(`CDP connection failed: ${message}`));
      });

      this.ws.addEventListener('message', (event: MessageEvent) => {
        const data: unknown =
          typeof event.data === "string" ? JSON.parse(event.data) : null;
        const msg = asCDPMessage(data);

        if (msg.id !== undefined) {
          const handler = this.pending.get(msg.id);
          if (handler) {
            this.pending.delete(msg.id);
            if (msg.error) {
              handler.reject(new Error(msg.error.message));
            } else {
              handler.resolve(msg.result ?? {});
            }
          }
        }

        if (msg.method) {
          const handlers = this.eventHandlers.get(msg.method);
          if (handlers) {
            for (const fn of handlers) {
              fn(msg.params ?? {});
            }
          }
        }
      });

      this.ws.addEventListener('close', () => {
        for (const [, handler] of this.pending) {
          handler.reject(new Error('CDP connection closed'));
        }
        this.pending.clear();
      });
    });
  }

  async send(
    method: string,
    params: CDPEventParams = {},
    timeout = 30000,
  ): Promise<CDPResult> {
    if (!this.ws || this.ws.readyState !== 1) {
      throw new Error('CDP not connected');
    }
    const ws = this.ws;

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

      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(event: string, handler: CDPEventHandler): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      handlers.add(handler);
    }
  }

  off(event: string, handler: CDPEventHandler): void {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      handlers.delete(handler);
    }
  }

  async navigate(url: string): Promise<CDPResult> {
    await this.send('Page.enable');
    return this.send('Page.navigate', { url });
  }

  async waitForLoad(timeout = 30000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('Page.loadEventFired', handler);
        reject(new Error('Page load timed out'));
      }, timeout);

      const handler: CDPEventHandler = () => {
        clearTimeout(timer);
        this.off('Page.loadEventFired', handler);
        resolve();
      };

      this.on('Page.loadEventFired', handler);
    });
  }

  async evaluate(expression: string): Promise<unknown> {
    await this.send('Runtime.enable');
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    });

    const exceptionDetails = result.exceptionDetails;
    if (exceptionDetails) {
      const text =
        typeof exceptionDetails === "object" &&
        exceptionDetails !== null &&
        typeof (exceptionDetails as { text?: unknown }).text === "string"
          ? (exceptionDetails as { text: string }).text
          : 'Evaluation failed';
      throw new Error(text);
    }

    const inner = result.result;
    if (typeof inner === "object" && inner !== null && "value" in inner) {
      return (inner as { value: unknown }).value;
    }
    return undefined;
  }

  async getTitle(): Promise<unknown> {
    return this.evaluate('document.title');
  }

  async getUrl(): Promise<unknown> {
    return this.evaluate('window.location.href');
  }

  async getBodyText(): Promise<unknown> {
    return this.evaluate('document.body?.innerText || ""');
  }

  async getText(selector: string): Promise<unknown> {
    const escaped = selector.replace(/"/g, '\\"');
    return this.evaluate(`document.querySelector("${escaped}")?.innerText || ""`);
  }

  async querySelector(selector: string): Promise<ElementInfo | null> {
    await this.send('DOM.enable');
    const doc = await this.send('DOM.getDocument');
    const rootNodeId = numField(doc.root, "nodeId", -1);
    const result = await this.send('DOM.querySelector', {
      nodeId: rootNodeId,
      selector
    });

    const nodeId = result.nodeId;
    if (typeof nodeId !== "number" || !nodeId) return null;

    const boxes = await this.send('DOM.getBoxModel', { nodeId });
    const model = asBoxModel(boxes);
    if (!model) return null;

    const content = model.content;
    const x = (content[0] + content[2] + content[4] + content[6]) / 4;
    const y = (content[1] + content[3] + content[5] + content[7]) / 4;

    return { x, y, nodeId };
  }

  async getByText(text: string, exact = false): Promise<ElementInfo | null> {
    const escaped = text.replace(/"/g, '\\"').replace(/\n/g, '\\n');
    const xpath = exact
      ? `//*[text()="${escaped}"]`
      : `//*[contains(text(), "${escaped}")]`;

    await this.send('DOM.enable');
    await this.send('DOM.getDocument');

    const result = await this.send('DOM.performSearch', {
      query: xpath,
      includeUserAgentShadowDOM: false
    });

    if (!result.resultCount) return null;

    const searchId = result.searchId;
    const nodes = await this.send('DOM.getSearchResults', {
      searchId,
      fromIndex: 0,
      toIndex: 1
    });

    await this.send('DOM.discardSearchResults', { searchId });

    const nodeIds = nodes.nodeIds;
    if (!Array.isArray(nodeIds) || !nodeIds.length) return null;
    const firstNodeId: unknown = nodeIds[0];
    if (typeof firstNodeId !== "number") return null;

    const boxes = await this.send('DOM.getBoxModel', { nodeId: firstNodeId });
    const model = asBoxModel(boxes);
    if (!model) return null;

    const content = model.content;
    const x = (content[0] + content[2] + content[4] + content[6]) / 4;
    const y = (content[1] + content[3] + content[5] + content[7]) / 4;

    return { x, y, nodeId: firstNodeId };
  }

  async click(x: number, y: number): Promise<void> {
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

  async type(text: string): Promise<void> {
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

  async press(key: string): Promise<void> {
    const keyMap: Record<string, KeyInfo> = {
      'Enter': { key: 'Enter', code: 'Enter', keyCode: 13 },
      'Tab': { key: 'Tab', code: 'Tab', keyCode: 9 },
      'Escape': { key: 'Escape', code: 'Escape', keyCode: 27 },
      'Backspace': { key: 'Backspace', code: 'Backspace', keyCode: 8 }
    };

    const keyInfo: KeyInfo = keyMap[key] || { key, code: key };

    await this.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      ...keyInfo
    });
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      ...keyInfo
    });
  }

  async fill(selector: string, text: string): Promise<void> {
    const el = await this.querySelector(selector);
    if (!el) throw new Error(`Input not found: ${selector}`);

    await this.send('DOM.focus', { nodeId: el.nodeId });

    await this.evaluate(`document.querySelector("${selector.replace(/"/g, '\\"')}").value = ""`);

    // Type the text
    await this.type(text);
  }

  /**
   * Take a screenshot of the page.
   * @param options - Screenshot options
   * @returns PNG image buffer
   */
  async screenshot(options: ScreenshotOptions = {}): Promise<Buffer> {
    const params: CDPEventParams = { format: 'png' };

    if (options.fullPage) {
      // Get full page dimensions
      const metrics = await this.send('Page.getLayoutMetrics');
      params.clip = {
        x: 0,
        y: 0,
        width: numField(metrics.contentSize, "width", 0),
        height: numField(metrics.contentSize, "height", 0),
        scale: 1
      };
      params.captureBeyondViewport = true;
    }

    const result = await this.send('Page.captureScreenshot', params);
    const data = typeof result.data === "string" ? result.data : "";
    return Buffer.from(data, 'base64');
  }

  /**
   * Screenshot a specific element.
   * @param selector - CSS selector
   * @returns PNG image buffer
   */
  async screenshotElement(selector: string): Promise<Buffer> {
    const el = await this.querySelector(selector);
    if (!el) throw new Error(`Element not found: ${selector}`);

    const boxes = await this.send('DOM.getBoxModel', { nodeId: el.nodeId });
    const model = asBoxModel(boxes);
    if (!model) throw new Error(`Element not found: ${selector}`);
    const border = model.border;

    const x = Math.min(border[0], border[2], border[4], border[6]);
    const y = Math.min(border[1], border[3], border[5], border[7]);
    const width = Math.max(border[0], border[2], border[4], border[6]) - x;
    const height = Math.max(border[1], border[3], border[5], border[7]) - y;

    const result = await this.send('Page.captureScreenshot', {
      format: 'png',
      clip: { x, y, width, height, scale: 1 }
    });

    const data = typeof result.data === "string" ? result.data : "";
    return Buffer.from(data, 'base64');
  }

  /**
   * Set viewport size.
   * @param width - Viewport width
   * @param height - Viewport height
   */
  async setViewport(width: number, height: number): Promise<void> {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false
    });
  }

  /** Close the CDP connection. */
  close(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  // ── Retry & Wait Helpers ──

  /**
   * Retry a function with exponential backoff.
   * @param fn - Async function to retry
   * @param options - Retry options
   * @returns Function result
   */
  async retry<T>(
    fn: () => Promise<T> | T,
    { retries = 3, delay = 100, maxDelay = 2000 }: RetryOptions = {},
  ): Promise<T> {
    let lastError: unknown;
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
   * @param options - Wait options
   */
  async waitForNetworkIdle({ timeout = 10000, idleTime = 500 }: NetworkIdleOptions = {}): Promise<void> {
    await this.send('Network.enable');

    return new Promise((resolve) => {
      let pending = 0;
      let idleTimer: ReturnType<typeof setTimeout> | null = null;
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
   * @param selector - CSS selector
   * @param options - Wait options
   * @returns Element info
   */
  async waitForVisible(selector: string, { timeout = 5000 }: WaitOptions = {}): Promise<ElementInfo> {
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
   * @param selector - CSS selector
   * @param options - Click options
   */
  async clickWithRetry(selector: string, { timeout = 5000, retries = 2 }: ClickWithRetryOptions = {}): Promise<void> {
    const el = await this.waitForVisible(selector, { timeout });
    await this.retry(() => this.click(el.x, el.y), { retries });
  }

  /**
   * Fill an input with auto-retry and wait.
   * @param selector - CSS selector
   * @param text - Text to fill
   * @param options - Fill options
   */
  async fillWithRetry(selector: string, text: string, { timeout = 5000 }: WaitOptions = {}): Promise<void> {
    await this.waitForVisible(selector, { timeout });
    await this.retry(() => this.fill(selector, text));
  }
}

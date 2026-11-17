
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, createWriteStream, rmSync, chmodSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

export interface LaunchedBrowser {
  process: ChildProcess;
  port: number;
  wsUrl: string;
  userDataDir: string;
}

export interface LaunchBrowserOptions {
  chromePath?: string;
  port?: number;
  userDataDir?: string;
}

const CHROME_VERSION = '131.0.6778.204';

const DOWNLOAD_URLS: Record<string, string> = {
  darwin: `https://storage.googleapis.com/chrome-for-testing-public/${CHROME_VERSION}/mac-x64/chrome-headless-shell-mac-x64.zip`,
  'darwin-arm64': `https://storage.googleapis.com/chrome-for-testing-public/${CHROME_VERSION}/mac-arm64/chrome-headless-shell-mac-arm64.zip`,
  linux: `https://storage.googleapis.com/chrome-for-testing-public/${CHROME_VERSION}/linux64/chrome-headless-shell-linux64.zip`,
  win32: `https://storage.googleapis.com/chrome-for-testing-public/${CHROME_VERSION}/win64/chrome-headless-shell-win64.zip`
};

const BROWSER_DIR = join(homedir(), '.dotbot', 'browsers');

function getChromePath(): string {
  const plat = platform();
  const arch = process.arch;

  if (plat === 'darwin') {
    const archDir = arch === 'arm64' ? 'chrome-headless-shell-mac-arm64' : 'chrome-headless-shell-mac-x64';
    return join(BROWSER_DIR, archDir, 'chrome-headless-shell');
  } else if (plat === 'linux') {
    return join(BROWSER_DIR, 'chrome-headless-shell-linux64', 'chrome-headless-shell');
  } else if (plat === 'win32') {
    return join(BROWSER_DIR, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe');
  }

  throw new Error(`Unsupported platform: ${plat}`);
}

function getDownloadUrl(): string | undefined {
  const plat = platform();
  const arch = process.arch;

  if (plat === 'darwin' && arch === 'arm64') {
    return DOWNLOAD_URLS['darwin-arm64'];
  }

  return DOWNLOAD_URLS[plat];
}

async function downloadChrome(): Promise<string> {
  const url = getDownloadUrl();
  if (!url) {
    throw new Error(`No Chrome download available for ${platform()}`);
  }

  console.log('[browser] Downloading Chrome for Testing (~50MB)...');

  mkdirSync(BROWSER_DIR, { recursive: true });

  const zipPath = join(BROWSER_DIR, 'chrome.zip');

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download Chrome: ${response.status}`);
  }

  if (!response.body) {
    throw new Error('Failed to download Chrome: empty response body');
  }

  const fileStream = createWriteStream(zipPath);
  await pipeline(Readable.fromWeb(response.body), fileStream);

  console.log('[browser] Extracting Chrome...');

  try {
    execSync(`unzip -o -q "${zipPath}" -d "${BROWSER_DIR}"`, { stdio: 'pipe' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to extract Chrome: ${message}`);
  }

  rmSync(zipPath, { force: true });

  const chromePath = getChromePath();

  if (platform() !== 'win32') {
    chmodSync(chromePath, 0o755);
  }

  console.log('[browser] Chrome installed successfully');
  return chromePath;
}

export async function ensureBrowser(): Promise<string> {
  const chromePath = getChromePath();

  if (existsSync(chromePath)) {
    return chromePath;
  }

  return downloadChrome();
}

async function findFreePort(): Promise<number> {
  const { createServer } = await import('node:net');

  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, () => {
      const address = server.address();
      const port = address !== null && typeof address === "object" ? address.port : 0;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

export async function launchBrowser(options: LaunchBrowserOptions = {}): Promise<LaunchedBrowser> {
  const envChromePath = process.env.DOTBOT_CHROME_PATH;
  const chromePath = options.chromePath
    || (envChromePath && existsSync(envChromePath) ? envChromePath : await ensureBrowser());
  const port = options.port
    || (process.env.DOTBOT_BROWSER_PORT ? Number(process.env.DOTBOT_BROWSER_PORT) : await findFreePort());
  const userDataDir = options.userDataDir
    || process.env.DOTBOT_BROWSER_USER_DATA_DIR
    || `/tmp/dotbot-browser-${Date.now()}`;

  mkdirSync(userDataDir, { recursive: true });

  const headed = !chromePath.includes('chrome-headless-shell');
  const args = headed
    ? [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${userDataDir}`,
        '--no-first-run',
        '--no-default-browser-check'
      ]
    : [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${userDataDir}`,
        '--disable-gpu',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-sync',
        '--no-first-run',
        '--disable-default-apps'
      ];

  const proc = spawn(chromePath, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: false
  });

  const wsUrl = await waitForDevTools(port, 10000);

  return {
    process: proc,
    port,
    wsUrl,
    userDataDir
  };
}

async function waitForDevTools(port: number, timeout = 10000): Promise<string> {
  const start = Date.now();
  const url = `http://127.0.0.1:${port}/json/version`;

  while (Date.now() - start < timeout) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        const data: unknown = await response.json();
        const wsUrl =
          typeof data === "object" &&
          data !== null &&
          typeof (data as { webSocketDebuggerUrl?: unknown }).webSocketDebuggerUrl === "string"
            ? (data as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl
            : undefined;
        if (wsUrl !== undefined) {
          return wsUrl;
        }
      }
    } catch {
    }
    await new Promise(r => setTimeout(r, 100));
  }

  throw new Error('Chrome DevTools did not start in time');
}

export async function createBrowserContext(wsUrl: string): Promise<string> {
  // Chromium >=92 requires PUT here (was GET before — CSRF mitigation), so try
  // PUT first and fall back to GET for older builds / chrome-headless-shell.
  const port = new URL(wsUrl).port;
  let response = await fetch(`http://127.0.0.1:${port}/json/new`, { method: 'PUT' });
  if (!response.ok) {
    response = await fetch(`http://127.0.0.1:${port}/json/new`);
  }
  if (!response.ok) {
    throw new Error('Failed to create browser context');
  }
  const target: unknown = await response.json();
  const targetWsUrl =
    typeof target === "object" &&
    target !== null &&
    typeof (target as { webSocketDebuggerUrl?: unknown }).webSocketDebuggerUrl === "string"
      ? (target as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl
      : undefined;
  if (targetWsUrl === undefined) {
    throw new Error('Failed to create browser context');
  }
  return targetWsUrl;
}

export async function closeBrowserContext(targetWsUrl: string): Promise<void> {
  const url = new URL(targetWsUrl);
  const port = url.port;
  const targetId = url.pathname.split('/').pop();

  await fetch(`http://127.0.0.1:${port}/json/close/${targetId}`);
}

export function killBrowser(proc: ChildProcess): void {
  if (proc && !proc.killed) {
    proc.kill('SIGTERM');
  }
}

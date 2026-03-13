// core/browser-launcher.js
// Browser launcher and downloader for CDP automation.
// Downloads Chrome for Testing on first use, zero npm dependencies.

import { spawn, execSync } from 'node:child_process';
import { existsSync, mkdirSync, createWriteStream, rmSync, chmodSync, readdirSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';

// Chrome for Testing version (stable channel)
const CHROME_VERSION = '131.0.6778.204';

const DOWNLOAD_URLS = {
  darwin: `https://storage.googleapis.com/chrome-for-testing-public/${CHROME_VERSION}/mac-x64/chrome-headless-shell-mac-x64.zip`,
  'darwin-arm64': `https://storage.googleapis.com/chrome-for-testing-public/${CHROME_VERSION}/mac-arm64/chrome-headless-shell-mac-arm64.zip`,
  linux: `https://storage.googleapis.com/chrome-for-testing-public/${CHROME_VERSION}/linux64/chrome-headless-shell-linux64.zip`,
  win32: `https://storage.googleapis.com/chrome-for-testing-public/${CHROME_VERSION}/win64/chrome-headless-shell-win64.zip`
};

const BROWSER_DIR = join(homedir(), '.dotbot', 'browsers');

/**
 * Get the expected Chrome executable path for this platform.
 * @returns {string} Path to Chrome executable
 */
function getChromePath() {
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

/**
 * Get the download URL for this platform.
 * @returns {string} Download URL
 */
function getDownloadUrl() {
  const plat = platform();
  const arch = process.arch;

  if (plat === 'darwin' && arch === 'arm64') {
    return DOWNLOAD_URLS['darwin-arm64'];
  }

  return DOWNLOAD_URLS[plat];
}

/**
 * Download and extract Chrome for Testing.
 * @returns {Promise<string>} Path to Chrome executable
 */
async function downloadChrome() {
  const url = getDownloadUrl();
  if (!url) {
    throw new Error(`No Chrome download available for ${platform()}`);
  }

  console.log('[browser] Downloading Chrome for Testing (~50MB)...');

  mkdirSync(BROWSER_DIR, { recursive: true });

  const zipPath = join(BROWSER_DIR, 'chrome.zip');

  // Download zip file
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download Chrome: ${response.status}`);
  }

  const fileStream = createWriteStream(zipPath);
  await pipeline(response.body, fileStream);

  console.log('[browser] Extracting Chrome...');

  // Extract using system unzip (available on all platforms)
  try {
    execSync(`unzip -o -q "${zipPath}" -d "${BROWSER_DIR}"`, { stdio: 'pipe' });
  } catch (err) {
    throw new Error(`Failed to extract Chrome: ${err.message}`);
  }

  // Clean up zip file
  rmSync(zipPath, { force: true });

  const chromePath = getChromePath();

  // Make executable on Unix
  if (platform() !== 'win32') {
    chmodSync(chromePath, 0o755);
  }

  console.log('[browser] Chrome installed successfully');
  return chromePath;
}

/**
 * Ensure Chrome is available, downloading if necessary.
 * @returns {Promise<string>} Path to Chrome executable
 */
export async function ensureBrowser() {
  const chromePath = getChromePath();

  if (existsSync(chromePath)) {
    return chromePath;
  }

  return downloadChrome();
}

/**
 * Find a free port for Chrome debugging.
 * @returns {Promise<number>} Available port number
 */
async function findFreePort() {
  const { createServer } = await import('node:net');

  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

/**
 * Launch Chrome with remote debugging enabled.
 * @param {Object} options - Launch options
 * @param {number} options.port - Debugging port (auto-assigned if not specified)
 * @param {string} options.userDataDir - User data directory for isolation
 * @returns {Promise<{process: ChildProcess, port: number, wsUrl: string}>}
 */
export async function launchBrowser(options = {}) {
  const chromePath = await ensureBrowser();
  const port = options.port || await findFreePort();
  const userDataDir = options.userDataDir || `/tmp/dotbot-browser-${Date.now()}`;

  mkdirSync(userDataDir, { recursive: true });

  const args = [
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

  // Wait for DevTools to be ready
  const wsUrl = await waitForDevTools(port, 10000);

  return {
    process: proc,
    port,
    wsUrl,
    userDataDir
  };
}

/**
 * Wait for Chrome DevTools to be ready and return WebSocket URL.
 * @param {number} port - Debugging port
 * @param {number} timeout - Timeout in ms
 * @returns {Promise<string>} WebSocket debugger URL
 */
async function waitForDevTools(port, timeout = 10000) {
  const start = Date.now();
  const url = `http://127.0.0.1:${port}/json/version`;

  while (Date.now() - start < timeout) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        const data = await response.json();
        return data.webSocketDebuggerUrl;
      }
    } catch {
      // Chrome not ready yet
    }
    await new Promise(r => setTimeout(r, 100));
  }

  throw new Error('Chrome DevTools did not start in time');
}

/**
 * Create a new browser context (tab) via CDP.
 * @param {string} wsUrl - Browser WebSocket URL
 * @returns {Promise<string>} Target WebSocket URL for the new context
 */
export async function createBrowserContext(wsUrl) {
  // Connect to browser endpoint to create new target
  const port = new URL(wsUrl).port;
  const response = await fetch(`http://127.0.0.1:${port}/json/new`);

  if (!response.ok) {
    throw new Error('Failed to create browser context');
  }

  const target = await response.json();
  return target.webSocketDebuggerUrl;
}

/**
 * Close a browser context (tab) via CDP.
 * @param {string} targetWsUrl - Target WebSocket URL
 */
export async function closeBrowserContext(targetWsUrl) {
  const url = new URL(targetWsUrl);
  const port = url.port;
  const targetId = url.pathname.split('/').pop();

  await fetch(`http://127.0.0.1:${port}/json/close/${targetId}`);
}

/**
 * Kill the browser process.
 * @param {ChildProcess} proc - Browser process
 */
export function killBrowser(proc) {
  if (proc && !proc.killed) {
    proc.kill('SIGTERM');
  }
}

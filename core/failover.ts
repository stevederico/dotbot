
import { AI_PROVIDERS } from "../utils/providers.js";
import type { Provider } from "../types.js";

interface ProviderRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

interface FailoverAttempt {
  provider: string;
  status: number;
  body: string;
}

type BuildRequest = (targetProvider: Provider) => ProviderRequest;

interface FailoverLogger {
  info: (message: string) => void;
  error: (message: string) => void;
}

interface FetchWithFailoverOptions {
  provider: Provider;
  buildRequest: BuildRequest;
  signal?: AbortSignal;
  logger?: FailoverLogger;
}

const FALLBACK_ORDER = ['xai', 'anthropic', 'openai'];

const COOLDOWN_MS = 5 * 60 * 1000;

const DEFAULT_RETRY_DELAY_MS = 1500;

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

const cooldownMap = new Map<string, number>();

function extractErrorHint(body: string): string {
  if (!body || typeof body !== 'string') return '';
  const trimmed = body.trim();
  if (!trimmed) return '';
  try {
    const j = JSON.parse(trimmed) as Record<string, unknown>;
    if (typeof j.error === 'string' && j.error.trim()) {
      return j.error.trim().slice(0, 80);
    }
    if (j.error && typeof j.error === 'object') {
      const nested = (j.error as Record<string, unknown>).message;
      if (typeof nested === 'string' && nested.trim()) {
        return nested.trim().slice(0, 80);
      }
    }
    if (typeof j.message === 'string' && j.message.trim()) {
      return j.message.trim().slice(0, 80);
    }
  } catch {
  }
  return trimmed.replace(/\s+/g, ' ').slice(0, 80);
}

function formatFailoverAttempt(a: FailoverAttempt): string {
  const hint = extractErrorHint(a.body || '');
  return hint ? `${a.provider}(${a.status}): ${hint}` : `${a.provider}(${a.status})`;
}

function formatFailoverMessage(attempts: FailoverAttempt[]): string {
  if (!attempts.length) return 'All providers failed';
  return `All providers failed: ${attempts.map(formatFailoverAttempt).join(', ')}`;
}

class FailoverError extends Error {
  attempts: FailoverAttempt[];

  constructor(message: string, attempts: FailoverAttempt[]) {
    super(message);
    this.name = 'FailoverError';
    this.attempts = attempts;
  }
}

function isProviderCooledDown(providerId: string): boolean {
  const expiresAt = cooldownMap.get(providerId);
  if (!expiresAt) return false;
  if (Date.now() >= expiresAt) {
    cooldownMap.delete(providerId);
    return false;
  }
  return true;
}

function markProviderFailed(providerId: string): void {
  cooldownMap.set(providerId, Date.now() + COOLDOWN_MS);
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function fetchWithFailover(
  { provider, buildRequest, signal, logger }: FetchWithFailoverOptions,
): Promise<{ response: Response; activeProvider: Provider }> {
  const attempts: FailoverAttempt[] = [];

  const providersToTry: Provider[] = [provider];
  for (const id of FALLBACK_ORDER) {
    if (id === provider.id) continue;
    const p = AI_PROVIDERS[id];
    if (p && !p.local) providersToTry.push(p);
  }

  for (const targetProvider of providersToTry) {
    if (targetProvider !== provider && isProviderCooledDown(targetProvider.id)) {
      continue;
    }

    if (targetProvider.envKey && !process.env[targetProvider.envKey]) {
      continue;
    }

    const { url, headers, body } = buildRequest(targetProvider);
    let lastStatus = 0;
    let lastBody = '';

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers,
          body,
          signal,
        });

        if (response.ok) {
          return { response, activeProvider: targetProvider };
        }

        lastStatus = response.status;
        lastBody = await response.text();

        if (!RETRYABLE_STATUSES.has(lastStatus)) {
          console.error(`[failover] ${targetProvider.name} returned ${lastStatus}`);
          console.error(`[failover] Error body:`, lastBody);
          console.error(`[failover] Request URL:`, url);
          console.error(`[failover] Request body:`, body.slice(0, 500));
          throw new FailoverError(
            `${targetProvider.name} returned ${lastStatus}: ${lastBody}`,
            [{ provider: targetProvider.id, status: lastStatus, body: lastBody }]
          );
        }

        if (attempt === 0) {
          const retryAfter = response.headers.get('retry-after');
          const delayMs = retryAfter
            ? Math.min(parseInt(retryAfter, 10) * 1000 || DEFAULT_RETRY_DELAY_MS, 10000)
            : DEFAULT_RETRY_DELAY_MS;

          if (logger) {
            logger.info(`[failover] ${targetProvider.name} returned ${lastStatus}, retrying in ${delayMs}ms`);
          }
          await abortableSleep(delayMs, signal);
        }
      } catch (err) {
        if ((err instanceof Error && err.name === 'AbortError') || err instanceof FailoverError) throw err;

        lastStatus = 0;
        lastBody = err instanceof Error ? err.message : String(err);
        if (attempt === 0) {
          await abortableSleep(DEFAULT_RETRY_DELAY_MS, signal);
        }
      }
    }

    attempts.push({ provider: targetProvider.id, status: lastStatus, body: lastBody });

    markProviderFailed(targetProvider.id);

    if (logger) {
      logger.error(`[failover] ${targetProvider.name} exhausted (${lastStatus}), trying next provider`);
    }
  }

  throw new FailoverError(formatFailoverMessage(attempts), attempts);
}

export {
  fetchWithFailover,
  FailoverError,
  extractErrorHint,
  formatFailoverAttempt,
  formatFailoverMessage,
};

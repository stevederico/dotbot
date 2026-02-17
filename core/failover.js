// failover.js
// Model failover: retry on transient errors, fall back to alternative providers.

import { AI_PROVIDERS } from "../utils/providers.js";

/** Ordered list of cloud providers to try during failover. Local providers excluded. */
const FALLBACK_ORDER = ['xai', 'anthropic', 'openai'];

/** How long (ms) a failed provider stays cooled down. */
const COOLDOWN_MS = 5 * 60 * 1000;

/** Default retry delay (ms) when Retry-After header is absent. */
const DEFAULT_RETRY_DELAY_MS = 1500;

/** HTTP status codes that warrant a retry/failover. */
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

/** In-memory cooldown map: providerId -> expiresAt timestamp. Resets on restart. */
const cooldownMap = new Map();

/**
 * Custom error thrown when all providers (primary + fallbacks) are exhausted.
 * @extends Error
 */
class FailoverError extends Error {
  /**
   * @param {string} message - Error summary.
   * @param {Array<{provider: string, status: number, body: string}>} attempts - Record of each failed attempt.
   */
  constructor(message, attempts) {
    super(message);
    this.name = 'FailoverError';
    this.attempts = attempts;
  }
}

/**
 * Check whether a provider is currently in cooldown.
 * @param {string} providerId - Provider identifier (e.g. 'anthropic').
 * @returns {boolean}
 */
function isProviderCooledDown(providerId) {
  const expiresAt = cooldownMap.get(providerId);
  if (!expiresAt) return false;
  if (Date.now() >= expiresAt) {
    cooldownMap.delete(providerId);
    return false;
  }
  return true;
}

/**
 * Mark a provider as failed, placing it in cooldown for COOLDOWN_MS.
 * @param {string} providerId - Provider identifier.
 */
function markProviderFailed(providerId) {
  cooldownMap.set(providerId, Date.now() + COOLDOWN_MS);
}

/**
 * Sleep for a given duration, respecting an AbortSignal.
 * @param {number} ms - Milliseconds to sleep.
 * @param {AbortSignal} [signal] - Optional abort signal.
 * @returns {Promise<void>}
 */
function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
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

/**
 * Attempt a fetch with retry and cross-provider failover.
 *
 * On retryable HTTP errors (429, 5xx): waits Retry-After or 1.5s, retries once.
 * If still failing: marks the provider cooled down, tries the next cloud provider.
 * On non-retryable errors (400, 401, 403): throws immediately (no failover).
 * On all providers exhausted: throws FailoverError with attempts array.
 *
 * @param {Object} options
 * @param {Object} options.provider - Primary provider config from AI_PROVIDERS.
 * @param {function(Object): {url: string, headers: Object, body: string}} options.buildRequest
 *   Callback that builds fetch params for any target provider.
 * @param {AbortSignal} [options.signal] - Optional abort signal.
 * @param {Object} [options.logger] - Optional logger with .info() and .error().
 * @returns {Promise<{response: Response, activeProvider: Object}>}
 *   The successful HTTP response and the provider that served it.
 * @throws {FailoverError} When all providers are exhausted.
 * @throws {DOMException} When aborted via signal (name: 'AbortError').
 */
async function fetchWithFailover({ provider, buildRequest, signal, logger }) {
  const attempts = [];

  // Build ordered list: primary first, then fallbacks (skip local, skip duplicates)
  const providersToTry = [provider];
  for (const id of FALLBACK_ORDER) {
    if (id === provider.id) continue;
    const p = AI_PROVIDERS[id];
    if (p && !p.local) providersToTry.push(p);
  }

  for (const targetProvider of providersToTry) {
    // Skip cooled-down providers (unless it's the primary — always try primary once)
    if (targetProvider !== provider && isProviderCooledDown(targetProvider.id)) {
      continue;
    }

    // Check that the target provider has an API key configured
    if (targetProvider.envKey && !process.env[targetProvider.envKey]) {
      continue;
    }

    const { url, headers, body } = buildRequest(targetProvider);
    let lastStatus = 0;
    let lastBody = '';

    // Up to 2 attempts per provider (initial + 1 retry)
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

        // Non-retryable — throw immediately, no failover
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

        // Retryable — wait and retry (only on first attempt)
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
        // Re-throw abort errors and non-retryable FailoverErrors
        if (err.name === 'AbortError' || err instanceof FailoverError) throw err;

        // Network error — treat as retryable
        lastStatus = 0;
        lastBody = err.message;
        if (attempt === 0) {
          await abortableSleep(DEFAULT_RETRY_DELAY_MS, signal);
        }
      }
    }

    // Both attempts failed for this provider
    attempts.push({ provider: targetProvider.id, status: lastStatus, body: lastBody });

    markProviderFailed(targetProvider.id);

    if (logger) {
      logger.error(`[failover] ${targetProvider.name} exhausted (${lastStatus}), trying next provider`);
    }
  }

  throw new FailoverError('All providers exhausted', attempts);
}

export { fetchWithFailover, FailoverError };

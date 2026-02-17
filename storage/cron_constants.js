/**
 * Shared constants and utilities for cron stores
 *
 * Used by both MongoCronStore and SQLiteCronStore to ensure consistent
 * behavior across storage backends.
 */

/** Heartbeat interval in milliseconds (15 minutes) */
export const HEARTBEAT_INTERVAL_MS = 15 * 60 * 1000;

/** Max heartbeats processed in parallel per poll cycle */
export const HEARTBEAT_CONCURRENCY = 5;

/** The current heartbeat prompt — defines proactive agent behavior */
export const HEARTBEAT_PROMPT = "Review your active goals and take action on the highest priority one. Use tools to make real progress — search for information, execute tasks, send notifications. If no goals exist, check memories for pending tasks. IMPORTANT: If you have nothing actionable, respond with exactly 'No action needed.' and nothing else. Do NOT ask if help is needed. Do NOT summarize status. Either take meaningful action or stay silent.";

/**
 * Run an array of async functions with a concurrency limit
 *
 * @param {Array<Function>} fns - Async functions to execute
 * @param {number} limit - Max concurrent executions
 */
export async function runWithConcurrency(fns, limit) {
  const executing = new Set();
  for (const fn of fns) {
    const p = fn().finally(() => executing.delete(p));
    executing.add(p);
    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }
  await Promise.all(executing);
}

/**
 * Parse a human-friendly interval string to milliseconds
 *
 * @param {string} str - Interval string e.g. "5m", "2h", "1d", "1w"
 * @returns {number|null} Milliseconds or null if invalid
 */
export function parseInterval(str) {
  const match = str.match(/^(\d+)\s*(s|m|h|d|w)$/i);
  if (!match) return null;
  const num = parseInt(match[1]);
  const unit = match[2].toLowerCase();
  const multipliers = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 };
  return num * multipliers[unit];
}

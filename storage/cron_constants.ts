/**
 * Shared constants and utilities for cron stores
 *
 * Used by both MongoCronStore and SQLiteCronStore to ensure consistent
 * behavior across storage backends.
 */

/** Heartbeat interval in milliseconds (15 minutes) */
export const HEARTBEAT_INTERVAL_MS: number = 15 * 60 * 1000;

/** Max heartbeats processed in parallel per poll cycle */
export const HEARTBEAT_CONCURRENCY: number = 5;

/** The current heartbeat prompt — defines proactive agent behavior */
export const HEARTBEAT_PROMPT: string = "Review your active tasks and take action on the highest priority one. Use tools to make real progress — search for information, execute steps, send notifications. If no tasks exist, check memories for pending work.";

/**
 * Run an array of async functions with a concurrency limit
 *
 * @param fns - Async functions to execute
 * @param limit - Max concurrent executions
 */
export async function runWithConcurrency(fns: Array<() => Promise<unknown>>, limit: number): Promise<void> {
  const executing = new Set<Promise<unknown>>();
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
 * @param str - Interval string e.g. "5m", "2h", "1d", "1w"
 * @returns Milliseconds or null if invalid
 */
export function parseInterval(str: string): number | null {
  const match = str.match(/^(\d+)\s*(s|m|h|d|w)$/i);
  if (!match) return null;
  const numStr = match[1];
  const unitStr = match[2];
  if (numStr === undefined || unitStr === undefined) return null;
  const num = parseInt(numStr);
  const unit = unitStr.toLowerCase();
  const multipliers: Record<string, number> = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 };
  const multiplier = multipliers[unit];
  if (multiplier === undefined) return null;
  return num * multiplier;
}

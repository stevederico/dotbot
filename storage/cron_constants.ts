
export const HEARTBEAT_INTERVAL_MS: number = 15 * 60 * 1000;

export const HEARTBEAT_CONCURRENCY: number = 5;

export const HEARTBEAT_PROMPT: string = "Review your active tasks and take action on the highest priority one. Use tools to make real progress — search for information, execute steps, send notifications. If no tasks exist, check memories for pending work.";

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

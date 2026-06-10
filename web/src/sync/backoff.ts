// Exponential backoff shared between the write-side outbox and the read-side
// fetch retry helper. Attempt 1 waits 250ms, doubling each time, capped at
// 30s (the same ceiling the outbox uses for transient HTTP failures).
// ±20% jitter so clients that failed together (deploy blip, shared outage)
// don't retry in lockstep.
export function backoffMs(attempts: number): number {
  const base = Math.min(30_000, 250 * 2 ** Math.max(0, attempts - 1));
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

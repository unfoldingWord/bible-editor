// Exponential backoff shared between the write-side outbox and the read-side
// fetch retry helper. Attempt 1 waits 250ms, doubling each time, capped at
// 30s (the same ceiling the outbox uses for transient HTTP failures).
export function backoffMs(attempts: number): number {
  return Math.min(30_000, 250 * 2 ** Math.max(0, attempts - 1));
}

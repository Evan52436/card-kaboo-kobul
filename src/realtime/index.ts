import type { Realtime } from './types';
import { createAblyRealtime } from './ably';
import { createMemoryRealtime, type MemoryRealtime } from './memory';

export type { Realtime } from './types';
export type { MemoryRealtime } from './memory';

/**
 * Pick a realtime adapter once per process, the same way `getStore()` picks a
 * store: Ably when configured, otherwise an in-process emitter that the client
 * compensates for by polling.
 *
 * The singleton lives on `globalThis` so Next's dev-server module reloads do
 * not drop the subscribers attached to it.
 */
const globalRealtime = globalThis as typeof globalThis & { __kabooRealtime?: Realtime };

export function getRealtime(): Realtime {
  if (globalRealtime.__kabooRealtime) return globalRealtime.__kabooRealtime;

  const apiKey = process.env.ABLY_API_KEY;
  const realtime = apiKey ? createAblyRealtime(apiKey) : createMemoryRealtime();

  globalRealtime.__kabooRealtime = realtime;
  return realtime;
}

/** Test seam: a fresh in-memory adapter whose publishes a test can inspect. */
export function createTestRealtime(): MemoryRealtime {
  return createMemoryRealtime();
}

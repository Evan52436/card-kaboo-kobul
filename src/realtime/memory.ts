import { roomChannel, type SyncResponse } from '@/protocol';
import type { Realtime } from './types';

/**
 * The in-memory Realtime: an in-process pub/sub, for dev and for tests.
 *
 * Nothing can subscribe over the network, so `tokenFor` returns `null` and the
 * client polls instead. That is not a degraded mode for local play — it is the
 * reason a room works on one machine with no accounts, and it keeps the whole
 * test suite off the network.
 */

export interface MemoryRealtime extends Realtime {
  /** Everything published, newest last: the fan-out a test wants to inspect. */
  readonly sent: { channel: string; message: SyncResponse }[];
  /** Returns an unsubscribe. */
  subscribe(channel: string, listener: (message: SyncResponse) => void): () => void;
  reset(): void;
}

export function createMemoryRealtime(): MemoryRealtime {
  const listeners = new Map<string, Set<(message: SyncResponse) => void>>();
  const sent: { channel: string; message: SyncResponse }[] = [];

  return {
    kind: 'memory',
    sent,

    async publish(code, messages) {
      for (const { playerId, message } of messages) {
        const channel = roomChannel(code, playerId);
        sent.push({ channel, message });
        for (const listener of listeners.get(channel) ?? []) listener(message);
      }
    },

    async tokenFor() {
      // No transport to authenticate to. The client polls.
      return null;
    },

    subscribe(channel, listener) {
      const set = listeners.get(channel) ?? new Set();
      set.add(listener);
      listeners.set(channel, set);
      return () => {
        set.delete(listener);
      };
    },

    reset() {
      listeners.clear();
      sent.length = 0;
    },
  };
}

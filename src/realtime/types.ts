import type { PlayerId } from '@/engine/types';
import type { SyncResponse } from '@/protocol';

/**
 * The realtime seam.
 *
 * Deliberately tiny: fan a per-player message out, and mint a credential that
 * lets one device subscribe to one channel. Everything the game needs to say
 * to a player fits through those two holes, which is what makes the Ably
 * adapter swappable for the in-memory one without the game noticing.
 */
export interface Realtime {
  /**
   * One message per player. MUST NOT throw.
   *
   * Publishing happens after the action has already been committed, so a failed
   * push cannot un-commit it — turning that into a request error would tell a
   * player their move failed when it is sitting in the log. The reliable path
   * is the per-player event queue plus polling; this is the fast path.
   */
  publish(code: string, messages: { playerId: PlayerId; message: SyncResponse }[]): Promise<void>;

  /**
   * A subscribe-only credential for exactly this player's channel, or `null`
   * when the adapter cannot issue one (the in-memory adapter, and the case
   * where Ably is unconfigured) — the client then falls back to polling.
   */
  tokenFor(code: string, playerId: PlayerId): Promise<unknown | null>;

  readonly kind: 'ably' | 'memory';
}

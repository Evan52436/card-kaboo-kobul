'use client';

import type { SyncResponse } from '@/protocol';
import { isRoomError, roomChannel, SYNC_EVENT, type RoomErrorCode } from '@/protocol';
import { readState, realtimeToken } from './api';
import type { StoredSession } from './session';

/**
 * ============================================================================
 *  THE STREAM — push when it is available, polling always
 * ============================================================================
 *  Two mechanisms, and neither replaces the other:
 *
 *  * **Push** (Ably) to this player's own private channel, so a move lands in
 *    well under a second. One channel per player, subscribe-only, capability
 *    scoped — a player cannot listen to another seat even knowing its name.
 *  * **Polling**, always. A serverless function holds no timer, so DEADLINES
 *    ONLY RESOLVE WHEN SOMEBODY TOUCHES THE ROOM. A table where every device is
 *    purely push-driven would sit in one phase forever the moment nobody acts.
 *    With push healthy the poll slows to a heartbeat; without it, the poll is
 *    the transport.
 *
 *  Delivery is at-least-once and order-free on purpose. The caller keeps a
 *  cursor and dedupes on `eventSeq`, so a replayed or duplicated push is
 *  harmless — which is what lets push stay best-effort on the server.
 * ============================================================================
 */

/** The latency when nothing is pushing. Fast enough to feel live, cheap in reads. */
const POLL_MS = 2000;
/**
 * The heartbeat when push IS healthy. Slower, because its only jobs are
 * resolving deadlines and noticing a push that never arrived.
 */
const HEARTBEAT_MS = 8000;

/**
 * Reasons to stop watching. Both mean this seat will never be answered again:
 * the room expired, or it is not this device's seat any more. Polling on would
 * be a silent, permanent failure — the player would stare at a frozen table.
 */
const FATAL: ReadonlySet<RoomErrorCode> = new Set<RoomErrorCode>(['E_NOT_FOUND', 'E_BAD_SESSION']);

export interface StreamOptions {
  session: StoredSession;
  /** The cursor this client has already seen. Read at each poll, never cached. */
  since: () => number;
  onSync: (sync: SyncResponse) => void;
  /** Push availability changed, for a "reconnecting" indicator. */
  onTransport?: (kind: 'push' | 'poll') => void;
  /** The seat is gone. The stream has already stopped itself. */
  onLost?: (code: RoomErrorCode) => void;
}

/**
 * Start watching the room. Returns the function that stops it.
 *
 * Everything is torn down by that one call — the timer, the listeners, the Ably
 * connection — so a React effect can own the whole lifetime without leaking.
 */
export function startStream(options: StreamOptions): () => void {
  const { session, since, onSync, onTransport, onLost } = options;

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pushing = false;
  let closeAbly: (() => void) | null = null;
  let teardown: () => void = () => {};

  /** Stop watching, and tell the caller why. */
  function giveUp(code: RoomErrorCode): void {
    teardown();
    onLost?.(code);
  }

  function deliver(payload: unknown): void {
    if (stopped) return;
    // The push body is written by our own server, but it crossed a network, so
    // it is checked rather than trusted.
    const sync = payload as Partial<SyncResponse> | null;
    if (typeof sync !== 'object' || sync === null) return;
    if (typeof sync.room !== 'object' || sync.room === null) return;
    onSync({ room: sync.room, events: sync.events ?? [], eventSeq: sync.eventSeq ?? 0 });
  }

  /** One poll. Always re-arms, so a single failure never ends the stream. */
  async function poll(): Promise<void> {
    if (stopped) return;
    const result = await readState(session, since());
    if (stopped) return;

    if (isRoomError(result)) {
      if (FATAL.has(result.code)) {
        giveUp(result.code);
        return;
      }
    } else {
      onSync(result);
    }
    schedule();
  }

  function schedule(): void {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(() => void poll(), pushing ? HEARTBEAT_MS : POLL_MS);
  }

  /** Poll immediately — for a tab coming back, or a network coming back. */
  function wake(): void {
    if (stopped || document.visibilityState === 'hidden') return;
    clearTimeout(timer);
    void poll();
  }

  /**
   * Ably, imported only once we know there is a push service to talk to.
   *
   * The landing screen and the lobby should not pay for a realtime SDK they may
   * never use, and a deployment with no Ably key must not fetch it at all.
   */
  async function connectPush(): Promise<void> {
    const tokenRequest = await realtimeToken(session);
    if (stopped || !tokenRequest) return;

    const Ably = (await import('ably')).default;
    if (stopped) return;

    const client = new Ably.Realtime({
      clientId: session.playerId,
      // Called again whenever the credential expires, so the token is re-minted
      // rather than replayed — a TokenRequest is single-use.
      authCallback: (_params, callback) => {
        void realtimeToken(session).then(
          (fresh) => callback(null, (fresh ?? null) as never),
          () => callback('kaboo: could not renew the realtime token', null),
        );
      },
    });

    client.connection.on('connected', () => {
      pushing = true;
      onTransport?.('push');
      schedule();
    });
    client.connection.on('failed', () => {
      // Polling is already running, so a push outage costs latency, not the game.
      pushing = false;
      onTransport?.('poll');
      schedule();
    });

    const channel = client.channels.get(roomChannel(session.code, session.playerId));
    await channel.subscribe(SYNC_EVENT, (message) => deliver(message.data));

    closeAbly = () => client.close();
  }

  const onVisibility = () => {
    if (document.visibilityState === 'visible') wake();
  };
  const onNetwork = () => wake();

  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('online', onNetwork);

  teardown = () => {
    stopped = true;
    clearTimeout(timer);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('online', onNetwork);
    closeAbly?.();
    closeAbly = null;
  };

  // Poll at once rather than waiting a full interval, so the first paint has
  // real data instead of a spinner.
  void poll();
  void connectPush();

  return teardown;
}

'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Action, PlayerId, PublicCard } from '@/engine/types';
import { isRoomError, type DealOptions, type DeliveredEvent, type RoomError, type RoomErrorCode, type RoomView, type SyncResponse } from '@/protocol';
import { leaveRoom, sendAction, startRoom } from './api';
import { clearSession, saveSession, sessionSnapshot, subscribeSession, type StoredSession } from './session';
import { startStream } from './stream';

/**
 * ============================================================================
 *  THE GAME, AS THIS DEVICE SEES IT
 * ============================================================================
 *  The engine is gone from the client entirely. Every fact on screen arrived
 *  from the server as a `RoomView`, already projected for this one player, so
 *  the UI cannot show a card the seat is not entitled to — it was never sent.
 *
 *  What is left for the client to own:
 *
 *  * **The cursor.** A monotonic `eventSeq` the client advances itself. Push and
 *    poll are two paths to the same fact, so the cursor is what makes delivery
 *    at-least-once instead of duplicated.
 *  * **Peeks.** Private events become transient notices and are then forgotten.
 *    Nothing is stored, so a notice that is dropped is gone — the server keeps a
 *    queue precisely so it is not dropped, but the client keeps no memory of a
 *    card it was once shown.
 *  * **A display clock.** For counting deadlines down. The server decides when
 *    they actually fire; this only animates the number.
 * ============================================================================
 */

/** A card the viewer was told about, and must now remember. */
export interface Peek {
  /** The server's `seq`, so a push, a poll and a replay all agree it is one peek. */
  key: number;
  card: PublicCard;
  /** What the look was about, for the label: "your card", "P2's card". */
  label: string;
  /**
   * The round the notice arrived in.
   *
   * A notice is only kept for the round it belongs to, which is what stops the
   * tray growing without limit. Nothing is lost by dropping it: at the reveal
   * every card on the table is face-up, so a reminder of what you privately saw
   * a moment earlier has stopped being information and become a pile of cards
   * sitting on top of the table — and the next round deals a fresh hand anyway.
   * Before this, a player who never tapped "Remember it" accumulated every peek
   * and every draw of the entire game.
   */
  round: number;
}

export interface Game {
  room: RoomView;
  /** Browser time, for animating a countdown. Never used to decide anything. */
  now: number;
  peeks: Peek[];
  /** A move was refused. Deliberately a bare flag: the reason is hidden info. */
  refused: boolean;
  /** `poll` means push is unavailable and a move takes longer to appear. */
  transport: 'push' | 'poll';
  busy: boolean;
  send(action: Action): void;
  deal(options?: DealOptions): void;
  dismissPeeks(): void;
}

/**
 * A human label for a private notice, built from the event alone.
 *
 * Deliberately takes no view and no state: the label must depend only on what
 * this viewer was just told, or it becomes somewhere for extra information to
 * creep in unnoticed.
 */
function labelFor(event: DeliveredEvent, viewerId: PlayerId): string {
  if (event.type === 'reveal') return 'the reveal';
  if (event.type === 'deckOut') return 'the last card — only you saw it';
  // Your own draw and the card a Queen handed you are private looks too, and
  // they used to fall through to the bare fallback below: a notice reading
  // "a card" next to a picture of a card says nothing at all.
  if (event.type === 'drew') return 'the card you drew';
  if (event.type === 'revealed') return 'the card you were given';
  if (event.type === 'peeked') {
    const mine = event.playerId === viewerId;
    const who = mine ? 'your' : `${String(event.playerId)}'s`;
    // Named by slot, 1-based, because that is how the table counts them: every
    // hand prints 1..4 under its cards and the footnote calls the bottom two
    // "3 and 4". Two notices both reading "your card" was the whole of what the
    // peek phase told you about which was which, and it told you nothing.
    //
    // Bare "slot 3" for your own card, because the tray's own heading already
    // says whose it is and this is the ONE case where two notices arrive at
    // once. The caption is what sets the tray's width — a 13ch caption makes a
    // 94px item around a 40px card, which was 21px too wide for the head and
    // the cards to share a row on a 360px phone, so the head wrapped above them
    // and the tray went from 122px tall to 208. That cost the bottom row of the
    // player's own hand, which is the row the whole phase is about.
    //
    // Only `peeked` gets a slot. A Queen's `revealed` also carries one, but it
    // is the slot the card came FROM — the card is in the viewer's own hand by
    // then, so printing that number would point at the wrong card.
    //
    // `EngineEvent` carries an index signature, so the field is `unknown` and
    // has to be narrowed. Falls back to the bare label rather than printing
    // "slot NaN" if a future event ever arrives without one.
    if (typeof event.slot !== 'number') return `${who} card`;
    return mine ? `slot ${event.slot + 1}` : `${who} card · slot ${event.slot + 1}`;
  }
  if (event.type === 'effectUsed') {
    const target = typeof event.targetPlayerId === 'string' ? event.targetPlayerId : null;
    if (target) return target === viewerId ? 'your card' : `${target}'s card`;
  }
  return 'a card';
}

export interface Seat {
  /** The stored seat. Null means "not seated", which is a real answer here. */
  session: StoredSession | null;
  /**
   * False until the browser has taken over from the server-rendered HTML.
   *
   * The server cannot read `localStorage`, so it renders the join form; a seated
   * player must not be shown that form and then yanked off it. One "one moment"
   * frame is the price, and it is cheaper than a form they might start typing in.
   */
  ready: boolean;
  signIn(session: StoredSession): void;
  forget(): void;
}

/** A store that never changes, for the constant-snapshot read below. */
const NOTHING_TO_WATCH = (): (() => void) => () => {};
/** On the client this is simply true; on the server and at hydration, false. */
const hydrated = () => true;
const notHydrated = () => false;

/**
 * The seat this device holds, read straight from `localStorage`.
 *
 * Not copied into `useState` by an effect: the seat is external state, and a copy
 * would need a render to catch up — one that shows the wrong screen. See the note
 * at the top of `session.ts`.
 */
export function useSeat(): Seat {
  const session = useSyncExternalStore(subscribeSession, sessionSnapshot, () => null);
  const ready = useSyncExternalStore(NOTHING_TO_WATCH, hydrated, notHydrated);

  const signIn = useCallback((next: StoredSession) => saveSession(next), []);
  const forget = useCallback(() => clearSession(), []);

  return { session, ready, signIn, forget };
}

/** Reasons to drop a seat: the room expired, or this seat is not ours any more. */
const FATAL: ReadonlySet<RoomErrorCode> = new Set<RoomErrorCode>(['E_NOT_FOUND', 'E_BAD_SESSION']);

export function useGame(session: StoredSession, onLost?: () => void): Game | null {
  const [room, setRoom] = useState<RoomView | null>(null);
  const [peeks, setPeeks] = useState<Peek[]>([]);
  const [refused, setRefused] = useState(false);
  const [transport, setTransport] = useState<'push' | 'poll'>('poll');
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  /** The cursor. A ref, not state: it is read by the poll loop every tick. */
  const cursor = useRef(0);
  /** Kept in a ref so `apply` never has to depend on it and change identity. */
  const onLostRef = useRef(onLost);
  useEffect(() => {
    // Written in an effect rather than during render, which is the only place a
    // ref may be written. One render behind is harmless: it is a "the seat is
    // gone" notice, and the value it calls out to is stable anyway.
    onLostRef.current = onLost;
  });

  /**
   * Take one payload. Stable for the lifetime of the seat — deliberately, since
   * the stream effect depends on it, and a changing callback would tear down and
   * rebuild the Ably connection (and reset the cursor) on every single update.
   */
  const apply = useCallback((sync: SyncResponse) => {
    const seen = cursor.current;
    // Only what this client has not already been told. `seq` is per event
    // precisely so a push and a poll cannot double-report the same peek.
    const fresh = sync.events.filter((e) => e.seq > seen && e.card !== undefined);
    if (fresh.length > 0) {
      const round = sync.room.status === 'playing' ? sync.room.view.round : 0;
      setPeeks((prev) => [
        // Notices from an earlier round are dropped here rather than held: see
        // `Peek.round`. Written as a prune-on-insert rather than an effect on the
        // round number, so there is exactly one place the tray can change shape.
        ...prev.filter((p) => p.round === round),
        ...fresh.map((e) => ({ key: e.seq, card: e.card!, label: labelFor(e, sync.room.you), round })),
      ]);
    }
    // `eventSeq` is room-wide, so advancing to it is correct: every event
    // addressed to this player carries a seq at or below it.
    if (sync.eventSeq > cursor.current) cursor.current = sync.eventSeq;
    setRoom(sync.room);
  }, []);

  useEffect(() => {
    // The cursor starts at zero for this seat. The seat is a mount-time fact —
    // the UI renders this hook only while one exists, so losing a seat unmounts
    // it and takes its state with it, and the next seat starts here clean. An
    // old cursor would swallow the new player's first peek.
    cursor.current = 0;
    return startStream({
      session,
      since: () => cursor.current,
      onSync: apply,
      onTransport: setTransport,
      onLost: () => onLostRef.current?.(),
    });
  }, [session, apply]);

  // The display clock. Cheap, and only for the countdown.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  /**
   * Keep the screen awake while this player has something to do.
   *
   * The brief asks for it and the game needs it: a Kaboo table can sit for two
   * minutes waiting on one person, and a phone that sleeps mid-turn looks like a
   * hang to everybody else. Not every browser has the API, and it must be
   * re-acquired after the tab is hidden, so this is best-effort throughout.
   */
  const myTurn =
    room?.status === 'playing' && room.view.turnPlayerId === room.you && room.view.phase !== 'gameOver';
  useEffect(() => {
    if (!myTurn) return;
    let sentinel: { release: () => Promise<void> } | null = null;
    let cancelled = false;

    const acquire = async () => {
      try {
        const wakeLock = (
          navigator as Navigator & {
            wakeLock?: { request(type: 'screen'): Promise<{ release: () => Promise<void> }> };
          }
        ).wakeLock;
        if (!wakeLock || document.visibilityState !== 'visible') return;
        const lock = await wakeLock.request('screen');
        if (cancelled) void lock.release();
        else sentinel = lock;
      } catch {
        // Denied, unsupported, or the tab is not visible. Nothing to fix.
      }
    };

    void acquire();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void acquire();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      void sentinel?.release().catch(() => {});
    };
  }, [myTurn]);

  const run = useCallback(
    (work: Promise<SyncResponse | RoomError>) => {
      setBusy(true);
      // Not awaited by the caller: the UI has nothing useful to do with the
      // promise, and the push that follows another player's move is what
      // actually moves this screen.
      void work
        .then((result) => {
          if (isRoomError(result)) {
            setRefused(true);
            if (FATAL.has(result.code)) onLostRef.current?.();
            return;
          }
          // A refusal still carries the fresh view — that is what tells us our
          // own view was stale. Show it, and say nothing more about why.
          setRefused((result as { refusal?: unknown }).refusal !== undefined);
          apply(result);
        })
        .finally(() => setBusy(false));
    },
    [apply],
  );

  const send = useCallback(
    (action: Action) => run(sendAction(session, action)),
    [session, run],
  );

  const deal = useCallback(
    (options?: DealOptions) => run(startRoom(session, options)),
    [session, run],
  );

  const dismissPeeks = useCallback(() => setPeeks([]), []);

  if (!room) return null;
  return { room, now, peeks, refused, transport, busy, send, deal, dismissPeeks };
}

/** Leaving is a courtesy to the table, so it must never block the button. */
export function useLeave(session: StoredSession, forget: () => void): () => void {
  return useCallback(() => {
    forget();
    void leaveRoom(session);
  }, [session, forget]);
}

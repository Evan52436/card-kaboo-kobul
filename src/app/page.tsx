'use client';

import { useCallback, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { MAX_PLAYERS, MIN_PLAYERS } from '@/engine/state';
import { createRoom, joinRoom } from '@/lib/api';
import { normalizeRoomCode } from '@/lib/random';
import type { StoredSession } from '@/lib/session';
import { useGame, useLeave, useSeat, type Game } from '@/lib/useGame';
import { GameScreen } from './GameScreen';

/**
 * ============================================================================
 *  THREE SCREENS: join, lobby, table
 * ============================================================================
 *  There is no fourth. Everybody is on their own device, so there is no
 *  "pass the phone" gate and no second name to hand over — a seat is proven by
 *  the token in `localStorage`, and two players on one machine are two browser
 *  windows, which is the same code path as two countries.
 *
 *  The screens are driven by ONE question — is there a stored seat? — and then
 *  by the server's own answer about the room. Nothing here decides how far
 *  along the game is: the room view says "lobby" or "playing", and that is all
 *  this file branches on.
 * ============================================================================
 */

export default function Page() {
  const seat = useSeat();
  /** Why the last seat was dropped. Shown once, on the way back to join. */
  const [notice, setNotice] = useState<string | null>(null);

  const lost = useCallback(() => {
    seat.forget();
    setNotice('That room is no longer open. Start a new one, or join with a fresh code.');
  }, [seat]);

  if (!seat.ready) {
    return (
      <Screen>
        <p className="kb-label" role="status">
          One moment…
        </p>
      </Screen>
    );
  }

  if (!seat.session) return <Join notice={notice} onSeated={seat.signIn} />;

  return <Room session={seat.session} onLeave={seat.forget} onLost={lost} />;
}

/**
 * The live connection, from the moment a seat exists until it is given up.
 *
 * `useGame` is called here and nowhere else, so the lobby and the table are two
 * renders of the same stream. The deal flips `room.status` on the server and
 * this component swaps which screen it returns — the socket, the cursor and the
 * peek queue all survive that, because none of them were rebuilt.
 */
function Room({
  session,
  onLeave,
  onLost,
}: {
  session: StoredSession;
  onLeave: () => void;
  onLost: () => void;
}) {
  const game = useGame(session, onLost);
  const leave = useLeave(session, onLeave);

  if (!game) {
    return (
      <Screen>
        <p className="kb-label" role="status">
          Finding the table…
        </p>
      </Screen>
    );
  }

  return game.room.status === 'lobby' ? (
    <Lobby game={game} onLeave={leave} />
  ) : (
    <GameScreen game={game} onQuit={leave} />
  );
}

/**
 * The lobby: read the code out, and wait.
 *
 * The code is the only thing anybody has to communicate, so it is the largest
 * element on the screen and it is set in the mono face the tokens give it. The
 * roster is shown rather than a count, because "has Dave arrived yet" is the
 * actual question at this point in a game.
 */
function Lobby({ game, onLeave }: { game: Game; onLeave: () => void }) {
  const view = game.room.status === 'lobby' ? game.room : null;
  if (!view) return null;

  const host = view.roster.find((r) => r.id === view.hostId);
  const needed = MIN_PLAYERS - view.roster.length;

  return (
    <Screen>
      <h1 className="kb-title">Kaboo</h1>
      <p className="kb-gate__body">Read this out. Everyone joins from their own phone.</p>

      <span className="kb-chip kb-chip--dark kb-chip--room" aria-label={`Room code ${view.code}`}>
        {view.code}
      </span>

      <section className="kb-panel" aria-label="Players">
        <h2 className="kb-panel__title kb-header">
          {view.roster.length} of {MAX_PLAYERS} here
        </h2>
        <ol className="kb-scores">
          {view.roster.map((r) => (
            <li key={r.id} className={`kb-scores__row${r.id === view.you ? ' kb-scores__row--you' : ''}`}>
              <span className="kb-scores__name">
                {r.name}
                {r.id === view.you && <span className="kb-chip kb-chip--soft">you</span>}
                {r.id === host?.id && <span className="kb-chip kb-chip--dark">host</span>}
              </span>
            </li>
          ))}
        </ol>
        <p className="kb-panel__note">
          {needed > 0
            ? `Waiting for ${needed} more ${needed === 1 ? 'player' : 'players'}.`
            : view.host
              ? 'Everyone is here.'
              : `Waiting for ${host?.name ?? 'the host'} to deal.`}
        </p>
      </section>

      {view.host ? (
        <button
          type="button"
          className="kb-btn kb-btn--primary"
          onClick={game.deal}
          disabled={needed > 0 || game.busy}
        >
          {needed > 0 ? `Need ${needed} more` : 'Deal the cards'}
        </button>
      ) : (
        <p className="kb-label" role="status">
          Waiting for the host…
        </p>
      )}

      {game.refused && (
        <p className="kb-error" role="alert">
          That did not work.
        </p>
      )}

      <button type="button" className="kb-btn kb-btn--small" onClick={onLeave}>
        Leave
      </button>
    </Screen>
  );
}

/**
 * Name, then a code.
 *
 * A blank code means "make me a room", which is why it is one form and not two
 * buttons: the difference between hosting and joining is one field, and asking
 * the player to classify themselves first is a worse question than the one they
 * can already answer.
 */
function Join({ notice, onSeated }: { notice: string | null; onSeated: (s: StoredSession) => void }) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const ready = name.trim().length > 0 && (code.length === 0 || code.length === 4);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);

    const result = code.length === 0 ? await createRoom(name.trim()) : await joinRoom(code, name.trim());

    setBusy(false);
    // The server's own message, which is written to be safe to show: it names a
    // room state, never a card. See `ROOM_ERROR_MESSAGES`.
    if ('ok' in result && result.ok === false) setError(result.message);
    else onSeated(result as StoredSession);
  }

  return (
    <Screen>
      <h1 className="kb-title">Kaboo</h1>
      <p className="kb-gate__body">
        A memory card game for two to eight people, each on their own device.
      </p>

      <form className="kb-form" onSubmit={submit}>
        <label className="kb-label" htmlFor="kb-name">
          Your name
        </label>
        <input
          id="kb-name"
          className="kb-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={12}
          autoComplete="nickname"
          enterKeyHint="next"
          placeholder="What should the table call you?"
        />

        <label className="kb-label" htmlFor="kb-code">
          Room code — leave blank to start a new game
        </label>
        <input
          id="kb-code"
          className="kb-input"
          value={code}
          // Reduced as it is typed, so a code pasted in lowercase, or with the
          // hyphen somebody wrote down, arrives in the one form the server
          // recognises. See `normalizeRoomCode`.
          onChange={(e) => setCode(normalizeRoomCode(e.target.value).slice(0, 4))}
          inputMode="text"
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="go"
          placeholder="ABCD"
        />

        <button type="submit" className="kb-btn kb-btn--primary" disabled={!ready || busy}>
          {busy ? 'One moment…' : code.length === 0 ? 'Start a game' : 'Join the game'}
        </button>
      </form>

      {(error ?? notice) && (
        <p className="kb-error" role="alert">
          {error ?? notice}
        </p>
      )}
    </Screen>
  );
}

/** The shared shell, so every screen sits in the same centred column. */
function Screen({ children }: { children: ReactNode }) {
  return <main className="kb-table kb-table--gate">{children}</main>;
}

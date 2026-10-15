'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CardRef, PlayerId } from '@/engine/types';
import { ActionBar } from '@/components/ActionBar';
import type { Intent } from '@/components/ActionBar';
import { Card } from '@/components/Card';
import { CardFlights } from '@/components/CardFlights';
import { Hand } from '@/components/Hand';
import { GameLog, PeekTray, Scoreboard, StatusPill } from '@/components/Panels';
import type { Game } from '@/lib/useGame';

/**
 * The game surface — mobile-first, then a three-column desktop layout.
 *
 * Everything it renders comes from the projection the SERVER sent for this one
 * seat. It never reads `GameState`, and it could not: there is no `GameState` in
 * the browser at all. A card this player may not see was never transmitted, so
 * no amount of clicking can reveal one. See AGENTS.md §4 and §9.
 *
 * The `Game` is a prop rather than something this component subscribes to: the
 * lobby and the table are two views of ONE live connection, so the deal must not
 * tear down the stream and rebuild it.
 */
/**
 * The intents whose every choice is a card of the player's own.
 *
 * Used only for deciding what to highlight. Deliberately not `tapChoose`,
 * `effectOther`, `blindFirst/Second`, `kingFirst/Second` or `queenTarget` — each
 * of those can be answered from any hand on the table, so there is no one set to
 * point at.
 */
const OWN_HAND_DECISIONS: ReadonlySet<Intent> = new Set<Intent>([
  'swap',
  'finalSwap',
  'tapPlace',
  'effectOwn',
  'queenOwn',
]);

export function GameScreen({ game, onQuit }: { game: Game; onQuit: () => void }) {
  const [intent, setIntent] = useState<Intent>('none');
  const [picks, setPicks] = useState<CardRef[]>([]);

  const view = game.room.status === 'playing' ? game.room.view : null;
  const youId = view?.youId ?? null;

  /**
   * The intent actually in force.
   *
   * The tap is the one decision a player does not start with a button: claiming
   * puts them in it, and `legalActions` then reads TAP_CHOOSE. So its intent is
   * derived from the view rather than kept in the state the buttons write, and
   * it wins while it lasts — a claimed tap owns the table until it resolves, and
   * the engine refuses everything else meanwhile.
   *
   * Without this the tap had no intent at all, and the flow was unplayable: the
   * bar said "pick the card that matches the top of the pile" while every card
   * on the table stayed inert, so a claimed tap could only ever end on the 8s
   * deadline — which counts as a wrong tap, and a penalty card.
   */
  const tapIntent: Intent =
    view?.tap?.playerId === youId
      ? view.tap.awaitingPlacement
        ? 'tapPlace'
        : 'tapChoose'
      : 'none';
  const activeIntent: Intent = tapIntent === 'none' ? intent : tapIntent;

  /**
   * A card the player was just shown has to be closed before they act again.
   *
   * The notice ("Remember it") is the only record they get of what they saw, and a
   * move made while it is still open is a move made before the card has been
   * taken in. So until it is closed no turn action is offered and no card on the
   * table can be picked.
   *
   * Not during the opening peek, where notices pile up by design and the Ready
   * button has its own gate, and not during a tap: that is a race against a
   * deadline and must never wait on a dialog. A King's swap decision is exempt in
   * `ActionBar` for the opposite reason: the two cards are what it is a decision
   * about, and closing the notice would take them away.
   */
  const blocked = game.peeks.length > 0 && view?.phase !== 'peek' && tapIntent === 'none';

  const can = useCallback(
    (action: string) => (view ? view.legalActions.includes(action as never) : false),
    [view],
  );

  /** Which slots are tappable right now, given the pending intent. */
  const selectable = useMemo<Map<PlayerId, number[]>>(() => {
    const map = new Map<PlayerId, number[]>();
    if (!view || !youId) return map;
    // Nothing on the table is pickable while a notice is still open.
    if (blocked) return map;
    const occupied = (id: PlayerId) =>
      (view.players.find((p) => p.id === id)?.hand ?? [])
        .filter((s) => s.occupied)
        .map((s) => s.index);

    const own = occupied(youId);

    switch (activeIntent) {
      case 'swap':
      case 'finalSwap':
      case 'tapPlace':
      case 'effectOwn':
      case 'queenOwn':
        return new Map([[youId, own]]);
      case 'effectOther':
        // Another player's card — never your own.
        for (const p of view.players) if (p.id !== youId) map.set(p.id, occupied(p.id));
        return map;
      // A tap may match from ANY hand, including your own, and so may a blind
      // swap or a King look. See AGENTS.md §5.
      case 'tapChoose':
      case 'blindFirst':
      case 'blindSecond':
      case 'kingFirst':
      case 'kingSecond':
      case 'queenTarget':
        for (const p of view.players) map.set(p.id, occupied(p.id));
        return map;
      default:
        return map;
    }
  }, [view, youId, activeIntent, blocked]);

  const onSlotClick = useCallback(
    (ref: CardRef) => {
      if (!view || blocked) return;
      const send = game.send;
      setIntent('none');
      const first = picks[0];

      switch (activeIntent) {
        case 'swap':
          send({ type: 'SWAP', playerId: view.youId, slot: ref.slot });
          break;
        case 'finalSwap':
          send({ type: 'FINAL_SWAP', playerId: view.youId, slot: ref.slot });
          break;
        case 'tapChoose':
          send({ type: 'TAP_CHOOSE', playerId: view.youId, target: ref });
          break;
        case 'tapPlace':
          send({ type: 'TAP_PLACE', playerId: view.youId, slot: ref.slot });
          break;
        case 'effectOwn':
          send({ type: 'EFFECT_PEEK_OWN', playerId: view.youId, slot: ref.slot });
          break;
        case 'effectOther':
          send({
            type: 'EFFECT_PEEK_OTHER',
            playerId: view.youId,
            targetPlayerId: ref.playerId,
            slot: ref.slot,
          });
          break;
        case 'queenOwn':
          setPicks([ref]);
          setIntent('queenTarget');
          return;
        case 'queenTarget':
          if (first) {
            send({ type: 'EFFECT_QUEEN_SWAP', playerId: view.youId, slot: first.slot, target: ref });
          }
          break;
        case 'blindFirst':
          setPicks([ref]);
          setIntent('blindSecond');
          return;
        case 'blindSecond':
          if (first) {
            send({ type: 'EFFECT_BLIND_SWAP', playerId: view.youId, a: first, b: ref });
          }
          break;
        case 'kingFirst':
          setPicks([ref]);
          setIntent('kingSecond');
          return;
        case 'kingSecond':
          if (first) {
            send({ type: 'EFFECT_KING_PEEK', playerId: view.youId, a: first, b: ref });
          }
          break;
        default:
          break;
      }
      setPicks([]);
    },
    [game.send, view, activeIntent, picks, blocked],
  );

  const setIntentAndClear = useCallback((next: Intent) => {
    setPicks([]);
    setIntent(next);
  }, []);

  /**
   * Bring the player's own cards into view when it becomes their move.
   *
   * The table is measured to fit one phone screen, but "one screen" is the screen
   * a four-card hand needs — a hand that has taken a penalty card is taller, and
   * the row that falls off the bottom is the row they are being asked to act on.
   * Trimming the layout until the worst case fits would mean shrinking the cards
   * every player looks at all game to serve the rare one.
   *
   * So the fix is a scroll, of the least amount that works: `block: 'nearest'`
   * scrolls only when the element is not already fully visible, which makes this
   * a no-op on every screen that already fits. Deliberately instant rather than
   * smooth — a control the player cannot see is worse than a jump they did not
   * ask for, and a 40px correction does not want 300ms of animation on top.
   */
  const ownCardsRef = useRef<HTMLElement>(null);
  /**
   * The peek tray is open, which takes about 180px off the board.
   *
   * Not just a render condition: the row the tray pushes off the bottom is the
   * row the player was told to look at, so it is a trigger for the scroll below
   * as well. The board is its own scroll region and the dock sits outside it,
   * so this scroll can never push the tray out of reach.
   */
  const dockPanel = game.peeks.length > 0;
  const acting =
    view?.phase === 'peek' ||
    view?.turnPlayerId === youId ||
    view?.tap?.playerId === youId ||
    view?.drawn?.isYours === true;
  const ownCardCount = view?.players.find((p) => p.id === youId)?.hand.filter((s) => s.occupied).length ?? 0;

  useEffect(() => {
    if (!acting) return;
    ownCardsRef.current?.scrollIntoView({ block: 'nearest' });
  }, [acting, ownCardCount, dockPanel]);

  if (!view || !youId) {
    return (
      <main className="kb-table kb-table--gate">
        <p className="kb-label" role="status">
          Dealing…
        </p>
      </main>
    );
  }

  const me = view.players.find((p) => p.id === youId);
  const turnPlayer = view.players.find((p) => p.id === view.turnPlayerId);

  /** The cards in this hand the player may act on right now. */
  const ownSelectable =
    selectable.get(youId) ?? (view.phase === 'peek' ? view.peekableSlots : []);

  /**
   * The cards to draw attention to: this hand, and only when the question is
   * about this hand.
   *
   * "Which of these" is the whole question for a swap, the peek, a look at your
   * own card, a Queen's half of the swap, and the card you drop into a hole you
   * just made. It is not the question for a tap or a blind swap, where the whole
   * table is in play — and there the cue does real harm rather than none: a
   * player who sees only their own cards lit may conclude only their own cards
   * are pickable, fail the tap, and take a penalty card for being misled by us.
   *
   * So an empty set is the honest answer for those, not a whole-table pulse.
   */
  const ownHandDecided =
    activeIntent === 'none' ? view.phase === 'peek' : OWN_HAND_DECISIONS.has(activeIntent);
  const liveSlots = ownHandDecided ? ownSelectable : [];

  return (
    <main className="kb-table kb-table--game">
      <CardFlights view={view} />
      <header className="kb-topbar">
        <span className="kb-chip kb-chip--dark">Room {view.roomCode}</span>
        <span className="kb-label">
          Round {view.round}/{view.rounds}
        </span>
        {/* Honest about the transport: without a push service a move takes a
            couple of seconds to appear, and that is worth saying out loud. */}
        <span
          className="kb-chip"
          title={
            game.transport === 'push'
              ? 'Live updates are on.'
              : 'Live updates are unavailable, so the table refreshes every couple of seconds.'
          }
        >
          {game.transport === 'push' ? 'live' : 'polling'}
        </span>
        <button type="button" className="kb-btn kb-btn--small" onClick={onQuit}>
          Leave
        </button>
      </header>

      <StatusPill
        view={view}
        viewerId={youId}
        deadline={deadlineFor(view)}
        now={game.now}
        canTap={view.canTap && view.tap === null}
        onTap={() => game.send({ type: 'TAP', playerId: youId, seenSeq: view.discardSeq })}
      />

      <div className="kb-board">
        <Scoreboard view={view} viewerId={youId} />

        <section className="kb-centre" aria-label="Table">
          <div className="kb-opponents">
            {view.players
              .filter((p) => p.id !== youId)
              .map((p) => (
                <article className="kb-seat" key={p.id}>
                  <h3 className="kb-label">
                    {p.name} {p.handCount === 0 ? '· empty' : `· ${p.handCount} cards`}
                  </h3>
                  <Hand
                    slots={p.hand}
                    label={`${p.name}'s cards`}
                    ownerId={p.id}
                    compact
                    selectableSlots={selectable.get(p.id) ?? []}
                    onSelect={(slot) => onSlotClick({ playerId: p.id, slot })}
                  />
                </article>
              ))}
          </div>

          <div className="kb-piles">
            {/* The count rides beside the label rather than under the card. Both
                piles carry one, and a stacked chip made every pile 30px taller
                than the card it describes — a third of a card's height spent on
                two digits. */}
            <div className="kb-pile">
              <div className="kb-pile__head">
                <span className="kb-label">Draw</span>
                {/* Hidden from the reader: the count is already the pile card's
                    own name, and a number read out on its own is not a sentence. */}
                <span className="kb-chip kb-chip--count" aria-hidden="true">
                  {view.drawPileCount}
                </span>
              </div>
              <div className="kb-pile__stack" data-flight="draw">
                {view.drawPileCount > 0 ? (
                  <Card faceDown label={`draw pile, ${view.drawPileCount} cards left`} />
                ) : (
                  <Card empty />
                )}
              </div>
            </div>

            <div className="kb-pile kb-pile--discard">
              <div className="kb-pile__head">
                <span className="kb-label">Discard</span>
                <span className="kb-chip kb-chip--count" aria-hidden="true">
                  {view.discardCount}
                </span>
              </div>
              <div className="kb-pile__stack" data-flight="discard">
                {view.discardTop ? (
                  <Card card={view.discardTop} label="top of the discard pile — tap to match" />
                ) : (
                  <Card empty />
                )}
              </div>
            </div>

            <div className="kb-pile">
              <div className="kb-pile__head">
                <span className="kb-label">Drawn card</span>
              </div>
              <div className="kb-pile__stack" data-flight="drawn">
              {view.drawn?.isYours && view.drawn.card ? (
                // The card you drew is the live one while you hold it: it is the
                // only thing on the table you are deciding about.
                <Card card={view.drawn.card} label="the card you drew" live />
              ) : view.drawn ? (
                <Card faceDown label="a card drawn by another player" />
              ) : view.heldCard?.isYours && view.heldCard.card ? (
                <Card card={view.heldCard.card} label="the last card" />
              ) : (
                <Card empty />
              )}
              </div>
            </div>
          </div>

          <section className="kb-you" aria-label="Your cards" ref={ownCardsRef}>
            <h3 className="kb-label">
              {/* Kept to one line: it wrapped at 390px, and a wrapped heading
                  costs a whole row of cards off the bottom of the screen. */}
              {me?.name} {view.phase === 'peek' ? '· peek at cards 3 and 4' : ''}
            </h3>
            <Hand
              slots={me?.hand ?? []}
              label="your cards"
              ownerId={youId}
              selectableSlots={ownSelectable}
              liveSlots={liveSlots}
              selectedSlot={picks[0]?.playerId === youId ? (picks[0]?.slot ?? null) : null}
              onSelect={(slot) => {
                if (view.phase === 'peek' && selectable.get(youId) === undefined) {
                  game.send({ type: 'PEEK', playerId: youId, slot });
                  return;
                }
                onSlotClick({ playerId: youId, slot });
              }}
            />
          </section>
        </section>

        <GameLog view={view} />
      </div>

      <p className="kb-footnote">
        Peek at cards 3 and 4 at the start. Card positions never move — that is the memory game.
      </p>

      {/* Everything you can do, and anything the server just refused, in one bar
          pinned to the bottom of the screen — where your thumb already is on a
          phone, and the shortest trip from a mouse on a desktop. See `.kb-dock`. */}
      <div className="kb-dock">
        <PeekTray peeks={game.peeks} onDismiss={game.dismissPeeks} />

        {game.refused && (
          <p className="kb-error" role="alert">
            That did not work. {/* Deliberately generic: the reason may be hidden info. */}
          </p>
        )}

        <ActionBar
          view={view}
          isYourTurn={view.turnPlayerId === youId}
          can={can}
          intent={activeIntent}
          onIntent={setIntentAndClear}
          onDraw={(from) => game.send({ type: 'DRAW', playerId: youId, from })}
          onDiscard={() => game.send({ type: 'DISCARD', playerId: youId })}
          onKaboo={() => game.send({ type: 'CALL_KABOO', playerId: youId })}
          onCounterKaboo={() => game.send({ type: 'COUNTER_KABOO', playerId: youId })}
          onReady={() => game.send({ type: 'READY', playerId: youId })}
          mustAcknowledge={game.peeks.length > 0}
          onSkipEffect={() => game.send({ type: 'EFFECT_SKIP', playerId: youId })}
          onKingDecide={(swap) => game.send({ type: 'EFFECT_KING_DECIDE', playerId: youId, swap })}
          onFinalDecline={() => game.send({ type: 'FINAL_DECLINE', playerId: youId })}
          onDeclinePlacement={() => game.send({ type: 'TAP_DECLINE_PLACE', playerId: youId })}
          onContinue={() => game.send({ type: 'CONTINUE', playerId: youId })}
          waitingOn={turnPlayer && view.turnPlayerId !== youId ? turnPlayer.name : null}
        />
      </div>
    </main>
  );
}

/** Which countdown this phase is actually on. Only one is ever live. */
function deadlineFor(view: {
  phase: string;
  deadlines: { turn: number; peek: number; tap: number; finalSwap: number };
}): number {
  switch (view.phase) {
    case 'peek':
      return view.deadlines.peek;
    case 'finalSwap':
      return view.deadlines.finalSwap;
    default:
      return view.deadlines.turn;
  }
}

import { publicCard } from './cards';
import { emit } from './events';
import { scoreRound } from './scoring';
import { addLog, appendSlot, getPlayer, nextEligibleSeat } from './state';
import type { Ctx, EngineEvent, GameState, PlayerId, PublicCard } from './types';

/**
 * Take `id` out of the queue of players still owed a final turn.
 *
 * Removing them from the list is what makes "exactly one final turn" true: the
 * seat ring skips anyone no longer in it.
 */
export function markFinalTurnDone(state: GameState, id: PlayerId): void {
  const i = state.finalTurnsRemaining.indexOf(id);
  if (i >= 0) state.finalTurnsRemaining.splice(i, 1);
  const p = getPlayer(state, id);
  if (p) p.finalTurnDone = true;
}

/**
 * A KABOO has been called (or auto-called). Every OTHER player now gets exactly
 * one more turn, and the caller gets none.
 */
export function beginFinalTurns(state: GameState, callerId: PlayerId): void {
  state.kabooCallerId = callerId;
  state.finalTurnsRemaining = state.players.filter((p) => p.id !== callerId).map((p) => p.id);
  for (const p of state.players) p.finalTurnDone = p.id === callerId;
}

/** Public snapshot of every hand — only ever used once the round is over. */
export function revealedHands(state: GameState): Record<PlayerId, (PublicCard | null)[]> {
  const hands: Record<PlayerId, (PublicCard | null)[]> = {};
  for (const p of state.players) {
    hands[p.id] = p.hand.map((id) => (id === null ? null : publicCard(id)));
  }
  return hands;
}

/**
 * Put any card that is "in front of" a player back into the accounting.
 *
 * A round can end while somebody is mid-decision. The reachable case is the house
 * rule's own edge: a wrong tap draws the LAST card of the draw pile as a penalty,
 * which ends the round immediately — while the turn player is still holding a
 * card they just drew. That card is physically in their hand, so it goes into
 * their hand. Simply clearing the field would quietly delete the card from the
 * game, which the conservation property test catches (see `tests/properties`).
 *
 * A deck-out card that was still under consideration when the round ended is
 * treated as declined: set aside, and not scored.
 */
function settleLooseCards(state: GameState): void {
  if (state.drawn) {
    appendSlot(state, state.drawn.by, state.drawn.cardId);
    state.drawn = null;
  }
  if (state.heldCardId !== null) {
    if (state.setAside === null) state.setAside = state.heldCardId;
    state.heldCardId = null;
  }
}

/**
 * End the round: flip everything face-up, score it, and park in `reveal`.
 *
 * From here the round result is public — and only from here. Nothing before this
 * point may compute or expose a total.
 */
export function revealRound(state: GameState, _ctx: Ctx, events: EngineEvent[]): void {
  if (state.phase === 'reveal' || state.phase === 'gameOver') return;

  state.phase = 'reveal';
  settleLooseCards(state);
  state.tap = null;
  state.effect = null;
  state.turnDeadline = 0;
  state.finalSwapDeadline = 0;
  state.peekDeadline = 0;

  const result = scoreRound(state);
  state.roundResult = result;

  addLog(state, { round: state.round, kind: 'reveal' });
  addLog(state, { round: state.round, kind: 'roundEnd' });

  emit(events, {
    type: 'reveal',
    round: state.round,
    hands: revealedHands(state),
    setAside: state.setAside === null ? null : publicCard(state.setAside),
    totals: result.totals,
    winnerId: result.winnerId,
    penaltyIds: result.penaltyIds,
  });
  emit(events, { type: 'roundEnd', result });
}

/**
 * Finish the current player's turn and hand play to the next eligible seat.
 *
 * When a KABOO is live this also retires the current player from the final-turn
 * queue and ends the round once the queue drains.
 */
export function advanceTurn(state: GameState, ctx: Ctx, events: EngineEvent[]): void {
  state.drawn = null;
  state.effect = null;
  state.turnDeadline = 0;
  state.finalSwapDeadline = 0;

  const current = state.players[state.turnSeat];
  if (!current) throw new Error(`kaboo: no player at seat ${state.turnSeat}`);

  if (state.kabooCallerId !== null) {
    markFinalTurnDone(state, current.id);
    if (state.finalTurnsRemaining.length === 0) {
      revealRound(state, ctx, events);
      return;
    }
  }

  state.turnCount += 1;

  // The guard that makes "a round always terminates" true even if the table
  // ping-pongs the discard pile forever without consuming the draw pile.
  if (state.turnCount >= state.rules.turnLimit) {
    addLog(state, { round: state.round, kind: 'turnLimit' });
    emit(events, { type: 'turnLimit', limit: state.rules.turnLimit });
    revealRound(state, ctx, events);
    return;
  }

  const next = nextEligibleSeat(state, state.turnSeat);
  state.turnSeat = next;
  state.phase = 'turnStart';
  state.turnDeadline = ctx.now + state.rules.turnDeadlineMs;
  emit(events, { type: 'turnChanged', seat: next, playerId: state.players[next]?.id });
}

/**
 * HOUSE RULE: losing all your cards auto-KABOOs. Returns true when it fired.
 *
 * Only checked when no call is already live — a second call would restart the
 * final-turn queue and let a round run indefinitely.
 */
export function checkAutoKaboo(state: GameState, _ctx: Ctx, events: EngineEvent[]): boolean {
  if (state.kabooCallerId !== null) return false;
  if (state.phase === 'reveal' || state.phase === 'gameOver') return false;

  const empty = state.players.find((p) => p.hand.every((slot) => slot === null));
  if (!empty) return false;

  empty.calledKaboo = true;
  addLog(state, { round: state.round, kind: 'autoKaboo', actor: empty.id });
  emit(events, { type: 'autoKaboo', by: empty.id });
  beginFinalTurns(state, empty.id);
  return true;
}

import { card, matchesForTap, publicCard } from './cards';
import { err, illegal } from './errors';
import { emit } from './events';
import {
  addLog,
  appendSlot,
  clearSlot,
  discardTop,
  drawPileEmpty,
  isSlotOccupied,
  popDeck,
  pushDiscard,
  setSlot,
  slotCard,
} from './state';
import { checkAutoKaboo, revealRound } from './turn';
import type { Action, Ctx, EngineError, EngineEvent, GameState, PlayerId } from './types';

type TapAction = Extract<
  Action,
  { type: 'TAP' | 'TAP_CHOOSE' | 'TAP_PLACE' | 'TAP_DECLINE_PLACE' }
>;

/**
 * Tapping is live whenever the table has a discard to match and the round is
 * still being played. It is deliberately forbidden during `finalSwap` — the
 * house rule says so, and it also stops a tap landing between the last card
 * being drawn and the round ending.
 */
export function canTapNow(state: GameState): boolean {
  if (state.phase !== 'turnStart' && state.phase !== 'drawn' && state.phase !== 'effect') return false;
  return discardTop(state) !== null;
}

/**
 * Give the tapper a penalty card from the top of the draw pile.
 *
 * Penalty cards ALWAYS land in the hand, even when they turn out to be the last
 * card of the pile — in which case the round ends immediately with no swap
 * offered to anyone.
 */
function applyPenaltyCard(state: GameState, playerId: PlayerId, ctx: Ctx, events: EngineEvent[]): void {
  const penalty = popDeck(state);
  if (penalty !== null) {
    appendSlot(state, playerId, penalty);
    addLog(state, { round: state.round, kind: 'tapWrong', actor: playerId, text: 'penalty' });
  }
  if (drawPileEmpty(state)) {
    addLog(state, { round: state.round, kind: 'deckOut', actor: playerId, text: 'penalty' });
    emit(events, { type: 'deckOut', reason: 'penalty' });
    revealRound(state, ctx, events);
    return;
  }
  checkAutoKaboo(state, ctx, events);
}

/**
 * A tap that did not produce a matching card. The named card simply goes back —
 * nothing was moved yet — and the tapper eats a penalty card.
 *
 * This is a successful ACTION: it resolves, it does not reject. Returning an
 * error would tell the tapper whether the card matched, which is information
 * they did not have.
 */
function wrongTap(state: GameState, playerId: PlayerId, ctx: Ctx, events: EngineEvent[]): null {
  state.tap = null;
  addLog(state, { round: state.round, kind: 'tapWrong', actor: playerId });
  emit(events, { type: 'tapWrong', by: playerId });
  applyPenaltyCard(state, playerId, ctx, events);
  return null;
}

function finishTap(state: GameState, ctx: Ctx, events: EngineEvent[]): void {
  state.tap = null;
  checkAutoKaboo(state, ctx, events);
}

/** Claim the tap. First claim wins; the loser is told only "too late". */
export function claimTap(
  state: GameState,
  action: Extract<Action, { type: 'TAP' }>,
  ctx: Ctx,
  events: EngineEvent[],
): EngineError | null {
  if (state.tap) return err('E_TOO_LATE');
  if (!canTapNow(state)) return illegal();
  // The client tells us which discard top it was reacting to. Tapping a view
  // that has already moved on is refused rather than silently resolved against
  // a card the player never saw.
  if (state.rules.tapClosesOnDiscardChange && action.seenSeq !== state.discardSeq) {
    return err('E_STALE');
  }

  state.tap = {
    playerId: action.playerId,
    seq: state.discardSeq,
    claimedAt: ctx.now,
    deadline: ctx.now + state.rules.tapDeadlineMs,
    awaitingPlacement: false,
    source: null,
  };
  addLog(state, { round: state.round, kind: 'tapClaimed', actor: action.playerId });
  emit(events, { type: 'tapClaimed', by: action.playerId });
  return null;
}

/** The tapper names the card they are matching with. */
export function chooseTapCard(
  state: GameState,
  action: Extract<Action, { type: 'TAP_CHOOSE' }>,
  ctx: Ctx,
  events: EngineEvent[],
): EngineError | null {
  const tap = state.tap;
  if (!tap || tap.playerId !== action.playerId) return illegal();
  if (tap.awaitingPlacement) return illegal();
  if (state.rules.tapClosesOnDiscardChange && tap.seq !== state.discardSeq) {
    return wrongTap(state, action.playerId, ctx, events);
  }

  const topId = discardTop(state);
  const pickedId = slotCard(state, action.target);
  if (topId === null || pickedId === null) return wrongTap(state, action.playerId, ctx, events);

  const matches = matchesForTap(card(pickedId), card(topId), state.rules);
  if (!matches) return wrongTap(state, action.playerId, ctx, events);

  clearSlot(state, action.target.playerId, action.target.slot);
  pushDiscard(state, pickedId);
  tap.source = action.target;

  addLog(state, {
    round: state.round,
    kind: 'tapSuccess',
    actor: action.playerId,
    target: action.target.playerId,
  });
  emit(events, {
    type: 'tapResolved',
    by: action.playerId,
    from: action.target,
    card: publicCard(pickedId),
  });

  if (action.target.playerId === action.playerId) {
    finishTap(state, ctx, events);
  } else {
    // They may now drop one of their own cards into the hole they just made.
    tap.awaitingPlacement = true;
  }
  return null;
}

/** Drop one of your own cards into the slot you just emptied on someone else. */
export function placeAfterTap(
  state: GameState,
  action: Extract<Action, { type: 'TAP_PLACE' }>,
  ctx: Ctx,
  events: EngineEvent[],
): EngineError | null {
  const tap = state.tap;
  if (!tap || tap.playerId !== action.playerId || !tap.awaitingPlacement) return illegal();
  const source = tap.source;
  if (!source) return illegal();
  if (isSlotOccupied(state, source)) return illegal();

  const own = slotCard(state, { playerId: action.playerId, slot: action.slot });
  if (own === null) return illegal();

  clearSlot(state, action.playerId, action.slot);
  setSlot(state, source.playerId, source.slot, own);
  addLog(state, {
    round: state.round,
    kind: 'placed',
    actor: action.playerId,
    target: source.playerId,
  });
  emit(events, { type: 'placed', by: action.playerId, into: source });
  finishTap(state, ctx, events);
  return null;
}

export function declinePlacement(
  state: GameState,
  action: Extract<Action, { type: 'TAP_DECLINE_PLACE' }>,
  ctx: Ctx,
  events: EngineEvent[],
): EngineError | null {
  const tap = state.tap;
  if (!tap || tap.playerId !== action.playerId || !tap.awaitingPlacement) return illegal();
  finishTap(state, ctx, events);
  return null;
}

/**
 * A claimed tap that was never completed. Resolved lazily on the next request,
 * because a serverless function cannot hold a timer.
 *
 * By default it counts as a wrong tap. Without that, "claim a tap, then stall"
 * would be a free way to freeze the table for everyone else.
 */
export function resolveTapDeadline(state: GameState, ctx: Ctx, events: EngineEvent[]): boolean {
  const tap = state.tap;
  if (!tap) return false;
  if (ctx.now < tap.deadline) return false;

  const playerId = tap.playerId;
  state.tap = null;
  addLog(state, { round: state.round, kind: 'tapTimeout', actor: playerId });
  emit(events, { type: 'tapTimeout', by: playerId });

  if (state.rules.tapTimeoutIsWrongTap) {
    applyPenaltyCard(state, playerId, ctx, events);
  }
  return true;
}

/** Route a tap-family action to its handler. */
export function handleTapAction(
  state: GameState,
  action: TapAction,
  ctx: Ctx,
  events: EngineEvent[],
): EngineError | null {
  switch (action.type) {
    case 'TAP':
      return claimTap(state, action, ctx, events);
    case 'TAP_CHOOSE':
      return chooseTapCard(state, action, ctx, events);
    case 'TAP_PLACE':
      return placeAfterTap(state, action, ctx, events);
    case 'TAP_DECLINE_PLACE':
      return declinePlacement(state, action, ctx, events);
  }
}

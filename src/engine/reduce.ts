import { effectFor, card, publicCard } from './cards';
import { resolveEffect } from './effects';
import { err, illegal } from './errors';
import { emit, emitPrivate } from './events';
import { buildGameResult, shouldGameEnd } from './scoring';
import {
  PEEK_SLOTS,
  addLog,
  addLook,
  cloneState,
  createGame,
  discardTop,
  drawPileEmpty,
  getPlayer,
  popDeck,
  pushDiscard,
  setSlot,
  startNextRound,
} from './state';
import { handleTapAction, resolveTapDeadline } from './tap';
import { advanceTurn, beginFinalTurns, revealRound } from './turn';
import type { Action, Ctx, EngineError, EngineEvent, GameState, PlayerId } from './types';

export interface ApplyResult {
  /** The state to persist. Identical to the input when nothing happened. */
  state: GameState;
  events: EngineEvent[];
  /**
   * Set when the ACTION was refused. `state` still reflects any deadline
   * resolution that happened while refusing it.
   *
   * The brief sketched `applyAction(...) -> { state, events } | error`. Returning
   * the error as a field instead of a union branch means a lazily-resolved
   * timeout is never thrown away just because the player's next action was
   * invalid — which matters, because the timeout is the only thing keeping a
   * serverless room from freezing forever. See AGENTS.md §7.
   */
  error?: EngineError;
  /** True when `state` differs from the input and should be written back. */
  versionChanged: boolean;
}

// ---------------------------------------------------------------------------
// Deadlines. Serverless functions cannot hold timers, so every deadline is a
// stored timestamp resolved lazily the next time anyone touches the room.
// ---------------------------------------------------------------------------

/** All players are ready (or timed out) — begin the first turn of the round. */
function maybeStartTurns(state: GameState, ctx: Ctx, events: EngineEvent[]): void {
  if (state.phase !== 'peek') return;
  if (!state.players.every((p) => p.ready)) return;
  state.peekDeadline = 0;
  state.phase = 'turnStart';
  state.turnDeadline = ctx.now + state.rules.turnDeadlineMs;
  emit(events, { type: 'turnChanged', seat: state.turnSeat, playerId: state.players[state.turnSeat]?.id });
}

function autoDeclineFinalSwap(state: GameState, events: EngineEvent[]): void {
  const held = state.heldCardId;
  if (held === null) return;
  state.setAside = held;
  state.heldCardId = null;
  const by = state.players[state.turnSeat]?.id;
  addLog(state, { round: state.round, kind: 'finalDecline', actor: by, text: 'timeout' });
  emit(events, { type: 'finalDecline', by, reason: 'timeout' });
}

/**
 * Play one safe default for a player who has run out of time.
 *
 * Safe means: never call KABOO for them, never swap away a card they chose to
 * keep, never guess at an effect. Discarding the drawn card is the one move
 * that costs them nothing they had before this turn.
 */
function autoPlayTurn(state: GameState, ctx: Ctx, events: EngineEvent[], dispatch: Dispatcher): void {
  const actor = state.players[state.turnSeat]?.id;
  if (!actor) return;
  state.turnDeadline = 0;

  const fallback: Action | null = (() => {
    switch (state.phase) {
      case 'turnStart':
        return { type: 'DRAW', playerId: actor, from: 'deck' };
      case 'drawn':
        return { type: 'DISCARD', playerId: actor };
      case 'effect':
        return { type: 'EFFECT_SKIP', playerId: actor };
      default:
        return null;
    }
  })();

  if (!fallback) return;
  addLog(state, { round: state.round, kind: 'turnLimit', actor, text: 'timeout' });
  emit(events, { type: 'turnChanged', seat: state.turnSeat, playerId: actor, reason: 'timeout' });
  dispatch(state, fallback, ctx, events);
}

type Dispatcher = (state: GameState, action: Action, ctx: Ctx, events: EngineEvent[]) => EngineError | null;

function runDeadlines(state: GameState, ctx: Ctx, events: EngineEvent[]): void {
  if (state.phase === 'gameOver') return;

  if (state.phase === 'peek' && state.peekDeadline > 0 && ctx.now >= state.peekDeadline) {
    for (const p of state.players) p.ready = true;
    addLog(state, { round: state.round, kind: 'ready', text: 'timeout' });
    maybeStartTurns(state, ctx, events);
  }

  if (state.tap) resolveTapDeadline(state, ctx, events);

  if (state.phase === 'finalSwap' && state.finalSwapDeadline > 0 && ctx.now >= state.finalSwapDeadline) {
    autoDeclineFinalSwap(state, events);
    revealRound(state, ctx, events);
  }

  // The turn clock only runs while nobody is mid-tap: a claimed tap owns the
  // table until it resolves.
  if (!state.tap && state.turnDeadline > 0 && ctx.now >= state.turnDeadline) {
    autoPlayTurn(state, ctx, events, dispatch);
  }
}

// ---------------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------------

function requireTurn(state: GameState, playerId: PlayerId): EngineError | null {
  if (state.players[state.turnSeat]?.id !== playerId) return err('E_NOT_YOUR_TURN');
  return null;
}

/** No turn-spine action is legal while a tap claim holds the table. */
function blockedByTap(state: GameState): boolean {
  return state.tap !== null;
}

function handlePeek(state: GameState, action: Extract<Action, { type: 'PEEK' }>, events: EngineEvent[]): EngineError | null {
  if (state.phase !== 'peek') return illegal();
  const p = getPlayer(state, action.playerId);
  if (!p || p.ready) return illegal();
  if (!PEEK_SLOTS.includes(action.slot)) return illegal();
  if (p.peeked[action.slot]) return illegal();
  const id = p.hand[action.slot] ?? null;
  if (id === null) return illegal();

  p.peeked[action.slot] = true;
  emitPrivate(events, action.playerId, {
    type: 'peeked',
    playerId: action.playerId,
    slot: action.slot,
    card: publicCard(id),
    reason: 'peek',
  });
  addLog(state, { round: state.round, kind: 'peeked', actor: action.playerId });
  // The rest of the table sees which card was lifted, never what it was.
  addLook(state, { by: action.playerId, playerId: action.playerId, slot: action.slot, reason: 'peek' });
  return null;
}

function handleReady(state: GameState, action: Extract<Action, { type: 'READY' }>, ctx: Ctx, events: EngineEvent[]): EngineError | null {
  if (state.phase !== 'peek') return illegal();
  const p = getPlayer(state, action.playerId);
  if (!p) return illegal();
  p.ready = true;
  addLog(state, { round: state.round, kind: 'ready', actor: action.playerId });
  emit(events, { type: 'phaseChanged', phase: 'peek', readyId: action.playerId });
  maybeStartTurns(state, ctx, events);
  return null;
}

function handleContinue(state: GameState, _action: Extract<Action, { type: 'CONTINUE' }>, ctx: Ctx, events: EngineEvent[]): EngineError | null {
  if (state.phase !== 'reveal') return illegal();

  if (shouldGameEnd(state)) {
    state.phase = 'gameOver';
    state.gameResult = buildGameResult(state);
    addLog(state, { round: state.round, kind: 'gameEnd' });
    emit(events, { type: 'gameEnd', result: state.gameResult });
    return null;
  }
  return startNextRound(state, ctx);
}

function handleKaboo(
  state: GameState,
  action: Extract<Action, { type: 'CALL_KABOO' | 'COUNTER_KABOO' }>,
  ctx: Ctx,
  events: EngineEvent[],
): EngineError | null {
  if (state.phase !== 'turnStart') return illegal();
  const turnErr = requireTurn(state, action.playerId);
  if (turnErr) return turnErr;
  if (blockedByTap(state)) return illegal();
  const p = getPlayer(state, action.playerId);
  if (!p) return illegal();

  if (action.type === 'CALL_KABOO') {
    if (state.kabooCallerId !== null || p.calledKaboo) return illegal();
    p.calledKaboo = true;
    addLog(state, { round: state.round, kind: 'kaboo', actor: action.playerId });
    emit(events, { type: 'kaboo', by: action.playerId });
    beginFinalTurns(state, action.playerId);
    // Calling ends your turn — the caller does not draw.
    advanceTurn(state, ctx, events);
    return null;
  }

  // Counter-KABOO: the minimal reading. Skip your turn and try to beat the
  // caller's total. See AGENTS.md §6.
  if (!state.rules.counterKaboo) return illegal();
  if (state.kabooCallerId === null || p.counterKaboo) return illegal();
  p.counterKaboo = true;
  addLog(state, { round: state.round, kind: 'counterKaboo', actor: action.playerId });
  emit(events, { type: 'counterKaboo', by: action.playerId });
  advanceTurn(state, ctx, events);
  return null;
}

function handleDraw(state: GameState, action: Extract<Action, { type: 'DRAW' }>, ctx: Ctx, events: EngineEvent[]): EngineError | null {
  if (state.phase !== 'turnStart') return illegal();
  const turnErr = requireTurn(state, action.playerId);
  if (turnErr) return turnErr;
  if (blockedByTap(state)) return illegal();

  if (action.from === 'discard') {
    const top = discardTop(state);
    if (top === null) return illegal();
    state.discard.pop();
    // The top changed, so anyone who claimed a tap against the old top is stale.
    state.discardSeq += 1;
    state.drawn = { cardId: top, from: 'discard', by: action.playerId };
    state.phase = 'drawn';
    state.turnDeadline = ctx.now + state.rules.turnDeadlineMs;
    addLog(state, { round: state.round, kind: 'tookDiscard', actor: action.playerId });
    emit(events, { type: 'tookDiscard', by: action.playerId, card: publicCard(top) });
    return null;
  }

  const id = popDeck(state);
  if (id === null) return illegal();

  // HOUSE RULE — DECK OUT: drawing the last card ends the round, and the drawer
  // gets one swap-or-decline decision. No discard, no effect, no tapping.
  if (drawPileEmpty(state)) {
    state.heldCardId = id;
    state.phase = 'finalSwap';
    state.turnDeadline = 0;
    state.finalSwapDeadline = ctx.now + state.rules.finalSwapDeadlineMs;
    addLog(state, { round: state.round, kind: 'deckOut', actor: action.playerId });
    emit(events, { type: 'deckOut', by: action.playerId, reason: 'lastCard' });
    emitPrivate(events, action.playerId, { type: 'deckOut', by: action.playerId, card: publicCard(id) });
    return null;
  }

  state.drawn = { cardId: id, from: 'deck', by: action.playerId };
  state.phase = 'drawn';
  state.turnDeadline = ctx.now + state.rules.turnDeadlineMs;
  addLog(state, { round: state.round, kind: 'drew', actor: action.playerId });
  // The drawn card is the drawer's private look — nobody else may see it.
  emitPrivate(events, action.playerId, { type: 'drew', by: action.playerId, from: 'deck', card: publicCard(id) });
  emit(events, { type: 'drew', by: action.playerId, from: 'deck', hidden: true });
  return null;
}

function handleSwap(state: GameState, action: Extract<Action, { type: 'SWAP' }>, ctx: Ctx, events: EngineEvent[]): EngineError | null {
  if (state.phase !== 'drawn') return illegal();
  const turnErr = requireTurn(state, action.playerId);
  if (turnErr) return turnErr;
  if (blockedByTap(state)) return illegal();

  const d = state.drawn;
  const p = getPlayer(state, action.playerId);
  if (!d || !p) return illegal();
  if (action.slot < 0 || action.slot >= p.hand.length) return illegal();

  const replaced = p.hand[action.slot] ?? null;
  setSlot(state, action.playerId, action.slot, d.cardId);
  if (replaced !== null) pushDiscard(state, replaced);
  state.drawn = null;

  addLog(state, { round: state.round, kind: 'swapped', actor: action.playerId });
  emit(events, { type: 'swapped', by: action.playerId, slot: action.slot });
  advanceTurn(state, ctx, events);
  return null;
}

function handleDiscard(state: GameState, action: Extract<Action, { type: 'DISCARD' }>, ctx: Ctx, events: EngineEvent[]): EngineError | null {
  if (state.phase !== 'drawn') return illegal();
  const turnErr = requireTurn(state, action.playerId);
  if (turnErr) return turnErr;
  if (blockedByTap(state)) return illegal();

  const d = state.drawn;
  if (!d) return illegal();

  const c = card(d.cardId);
  pushDiscard(state, d.cardId);
  state.drawn = null;

  addLog(state, { round: state.round, kind: 'discarded', actor: action.playerId });
  emit(events, { type: 'discarded', by: action.playerId, card: publicCard(d.cardId) });

  // Only a discarded card triggers an effect — never a swap, never a tap.
  if (effectFor(c)) {
    state.effect = { by: action.playerId, rank: c.rank, a: null, b: null, awaitingKingDecision: false };
    state.phase = 'effect';
    state.turnDeadline = ctx.now + state.rules.turnDeadlineMs;
    return null;
  }

  advanceTurn(state, ctx, events);
  return null;
}

function handleFinalSwap(
  state: GameState,
  action: Extract<Action, { type: 'FINAL_SWAP' | 'FINAL_DECLINE' }>,
  ctx: Ctx,
  events: EngineEvent[],
): EngineError | null {
  if (state.phase !== 'finalSwap') return illegal();
  const turnErr = requireTurn(state, action.playerId);
  if (turnErr) return turnErr;

  const held = state.heldCardId;
  const p = getPlayer(state, action.playerId);
  if (held === null || !p) return illegal();

  if (action.type === 'FINAL_SWAP') {
    if (action.slot < 0 || action.slot >= p.hand.length) return illegal();
    const replaced = p.hand[action.slot] ?? null;
    setSlot(state, action.playerId, action.slot, held);
    state.heldCardId = null;
    // The replaced card still has to go somewhere, or a card id would vanish
    // from the accounting. It lands on the discard pile, with no effect.
    if (replaced !== null) pushDiscard(state, replaced);
    addLog(state, { round: state.round, kind: 'finalSwap', actor: action.playerId, text: 'swapped' });
    emit(events, { type: 'finalSwap', by: action.playerId, slot: action.slot });
  } else {
    state.setAside = held;
    state.heldCardId = null;
    addLog(state, { round: state.round, kind: 'finalDecline', actor: action.playerId });
    emit(events, { type: 'finalDecline', by: action.playerId });
  }

  revealRound(state, ctx, events);
  return null;
}

function handleLeave(state: GameState, action: Extract<Action, { type: 'LEAVE' }>, events: EngineEvent[]): EngineError | null {
  const p = getPlayer(state, action.playerId);
  if (!p) return err('E_UNKNOWN_PLAYER');
  p.connected = false;
  addLog(state, { round: state.round, kind: 'playerLeft', actor: action.playerId });
  emit(events, { type: 'phaseChanged', leftId: action.playerId });
  return null;
}

/**
 * The single place that maps an action to its handler, and the single place that
 * enforces "it must be a real action in a real phase".
 */
const dispatch: Dispatcher = (state, action, ctx, events) => {
  switch (action.type) {
    case 'PEEK':
      return handlePeek(state, action, events);
    case 'READY':
      return handleReady(state, action, ctx, events);
    case 'CONTINUE':
      return handleContinue(state, action, ctx, events);
    case 'CALL_KABOO':
    case 'COUNTER_KABOO':
      return handleKaboo(state, action, ctx, events);
    case 'DRAW':
      return handleDraw(state, action, ctx, events);
    case 'SWAP':
      return handleSwap(state, action, ctx, events);
    case 'DISCARD':
      return handleDiscard(state, action, ctx, events);
    case 'FINAL_SWAP':
    case 'FINAL_DECLINE':
      return handleFinalSwap(state, action, ctx, events);
    case 'EFFECT_SKIP':
    case 'EFFECT_PEEK_OWN':
    case 'EFFECT_PEEK_OTHER':
    case 'EFFECT_BLIND_SWAP':
    case 'EFFECT_QUEEN_SWAP':
    case 'EFFECT_KING_PEEK':
    case 'EFFECT_KING_DECIDE':
      if (state.phase !== 'effect') return illegal();
      return resolveEffect(state, action, ctx, events);
    case 'TAP':
    case 'TAP_CHOOSE':
    case 'TAP_PLACE':
    case 'TAP_DECLINE_PLACE':
      return handleTapAction(state, action, ctx, events);
    case 'LEAVE':
      return handleLeave(state, action, events);
    default:
      return illegal();
  }
};

/**
 * Resolve any expired deadlines without applying an action.
 *
 * The room's READ path calls this, so a table with nobody typing still moves: a
 * player who never readies, never finishes a tap, or never answers the deck-out
 * question is carried forward on the next poll.
 */
export function tick(state: GameState, ctx: Ctx): ApplyResult | null {
  const next = cloneState(state);
  const events: EngineEvent[] = [];
  runDeadlines(next, ctx, events);
  if (events.length === 0) return null;
  next.version = state.version + 1;
  next.lastActivityAt = ctx.now;
  return { state: next, events, versionChanged: true };
}

/**
 * The engine's public entry point.
 *
 * Pure: it deep-clones, never mutates its input, and never throws for a bad
 * action — it reports the refusal in `error`.
 */
export function applyAction(state: GameState, action: Action, ctx: Ctx): ApplyResult {
  const actor = getPlayer(state, action.playerId);
  if (!actor) {
    return { state, events: [], error: err('E_UNKNOWN_PLAYER'), versionChanged: false };
  }
  if (state.phase === 'gameOver') {
    return { state, events: [], error: err('E_GAME_OVER'), versionChanged: false };
  }

  const next = cloneState(state);
  next.rules = state.rules;
  const events: EngineEvent[] = [];

  // Deadlines resolve first, so a player's action always meets the table as it
  // really is, not as it was when they looked.
  runDeadlines(next, ctx, events);
  const deadlineMoved = events.length > 0;

  const rejection = dispatch(next, action, ctx, events);

  if (rejection) {
    if (!deadlineMoved) {
      return { state, events: [], error: rejection, versionChanged: false };
    }
    // Time moved on even though the action was refused — hand back the movement
    // alongside the refusal so a timeout is never silently dropped.
    next.version = state.version + 1;
    next.lastActivityAt = ctx.now;
    return { state: next, events, error: rejection, versionChanged: true };
  }

  next.version = state.version + 1;
  next.lastActivityAt = ctx.now;
  return { state: next, events, versionChanged: true };
}

/** Start a fresh game in a room. */
export function startGame(
  roomCode: string,
  players: { id: PlayerId; name: string }[],
  ctx: Ctx,
  rules?: Partial<GameState['rules']>,
): GameState {
  return createGame({ roomCode, players, rules }, ctx);
}

// One import site for the engine's whole surface.
export { createGame } from './state';
export { project, legalActions } from './project';
export type { Projection, PlayerView, SlotView } from './project';

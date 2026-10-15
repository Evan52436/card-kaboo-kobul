import { card, publicCard } from './cards';
import { illegal } from './errors';
import { emit, emitPrivate } from './events';
import { addLog, isSlotOccupied, setSlot, slotCard } from './state';
import { advanceTurn } from './turn';
import type { Action, CardRef, Ctx, EngineError, EngineEvent, GameState, PlayerId, Rank } from './types';

type EffectAction = Extract<
  Action,
  {
    type:
      | 'EFFECT_SKIP'
      | 'EFFECT_PEEK_OWN'
      | 'EFFECT_PEEK_OTHER'
      | 'EFFECT_BLIND_SWAP'
      | 'EFFECT_QUEEN_SWAP'
      | 'EFFECT_KING_PEEK'
      | 'EFFECT_KING_DECIDE';
  }
>;

/** Open the effect phase for a just-discarded card. */
export function startEffect(state: GameState, by: PlayerId, rank: Rank): void {
  state.effect = { by, rank, a: null, b: null, awaitingKingDecision: false };
  state.phase = 'effect';
}

function sameRef(a: CardRef, b: CardRef): boolean {
  return a.playerId === b.playerId && a.slot === b.slot;
}

/** Move the contents of two slots into each other. Both must be occupied. */
function swapCards(state: GameState, a: CardRef, b: CardRef): boolean {
  const ca = slotCard(state, a);
  const cb = slotCard(state, b);
  if (ca === null || cb === null) return false;
  setSlot(state, a.playerId, a.slot, cb);
  setSlot(state, b.playerId, b.slot, ca);
  return true;
}

function finishEffect(state: GameState, ctx: Ctx, events: EngineEvent[]): void {
  state.effect = null;
  advanceTurn(state, ctx, events);
}

/**
 * Resolve the pending effect. Only the player who triggered it may act, and
 * every branch ends the turn.
 *
 * A player may always `EFFECT_SKIP` their own power. Nothing in the brief makes
 * an effect compulsory, and forcing a blind swap on a player who does not want
 * one would be punishing them for their own card. See AGENTS.md §7.
 */
export function resolveEffect(
  state: GameState,
  action: EffectAction,
  ctx: Ctx,
  events: EngineEvent[],
): EngineError | null {
  const eff = state.effect;
  if (!eff) return illegal();
  if (eff.by !== action.playerId) return illegal();

  const me = action.playerId;

  // --- King, second step: the peek is done, now decide whether to swap. -----
  if (eff.awaitingKingDecision) {
    if (action.type !== 'EFFECT_KING_DECIDE') return illegal();
    const a = eff.a;
    const b = eff.b;
    if (!a || !b) return illegal();
    if (action.swap) {
      if (!swapCards(state, a, b)) return illegal();
      addLog(state, { round: state.round, kind: 'effect', actor: me, text: 'kingSwap' });
      emit(events, { type: 'effectUsed', by: me, rank: eff.rank, decision: 'swap' });
    } else {
      addLog(state, { round: state.round, kind: 'effect', actor: me, text: 'kingKeep' });
      emit(events, { type: 'effectUsed', by: me, rank: eff.rank, decision: 'keep' });
    }
    // The caller announced the decision; the targets see their slots change
    // through `gen` alone, never through a card face.
    finishEffect(state, ctx, events);
    return null;
  }

  if (action.type === 'EFFECT_KING_DECIDE') return illegal();

  if (action.type === 'EFFECT_SKIP') {
    addLog(state, { round: state.round, kind: 'effect', actor: me, text: 'skipped' });
    emit(events, { type: 'effectSkipped', by: me, rank: eff.rank });
    finishEffect(state, ctx, events);
    return null;
  }

  switch (action.type) {
    // --- 7 / 8: look at one of your own cards -------------------------------
    case 'EFFECT_PEEK_OWN': {
      if (eff.rank !== '7' && eff.rank !== '8') return illegal();
      const ref: CardRef = { playerId: me, slot: action.slot };
      const id = slotCard(state, ref);
      if (id === null || !isSlotOccupied(state, ref)) return illegal();
      emitPrivate(events, me, {
        type: 'peeked',
        playerId: me,
        slot: action.slot,
        card: publicCard(id),
        reason: 'effect',
      });
      addLog(state, { round: state.round, kind: 'effect', actor: me, text: 'ownPeek' });
      emit(events, { type: 'effectUsed', by: me, rank: eff.rank, targetPlayerId: me, targetSlot: action.slot });
      finishEffect(state, ctx, events);
      return null;
    }

    // --- 9 / 10: look at one opponent card ----------------------------------
    case 'EFFECT_PEEK_OTHER': {
      if (eff.rank !== '9' && eff.rank !== '10') return illegal();
      if (action.targetPlayerId === me) return illegal();
      const ref: CardRef = { playerId: action.targetPlayerId, slot: action.slot };
      const id = slotCard(state, ref);
      if (id === null) return illegal();
      emitPrivate(events, me, {
        type: 'peeked',
        playerId: action.targetPlayerId,
        slot: action.slot,
        card: publicCard(id),
        reason: 'effect',
      });
      addLog(state, {
        round: state.round,
        kind: 'effect',
        actor: me,
        target: action.targetPlayerId,
        text: 'otherPeek',
      });
      emit(events, {
        type: 'effectUsed',
        by: me,
        rank: eff.rank,
        targetPlayerId: action.targetPlayerId,
        targetSlot: action.slot,
      });
      finishEffect(state, ctx, events);
      return null;
    }

    // --- Jack: blind-swap any two cards -------------------------------------
    case 'EFFECT_BLIND_SWAP': {
      if (eff.rank !== 'J') return illegal();
      if (sameRef(action.a, action.b)) return illegal();
      if (!isSlotOccupied(state, action.a) || !isSlotOccupied(state, action.b)) return illegal();
      if (!swapCards(state, action.a, action.b)) return illegal();
      addLog(state, {
        round: state.round,
        kind: 'effect',
        actor: me,
        target: action.a.playerId === me ? action.b.playerId : action.a.playerId,
        text: 'blindSwap',
      });
      // Both slots' owners learn THAT they changed, never what they became.
      emit(events, {
        type: 'effectUsed',
        by: me,
        rank: eff.rank,
        a: action.a,
        b: action.b,
      });
      finishEffect(state, ctx, events);
      return null;
    }

    // --- Queen: swap one of yours with any other card, see what you receive --
    case 'EFFECT_QUEEN_SWAP': {
      if (eff.rank !== 'Q') return illegal();
      const own: CardRef = { playerId: me, slot: action.slot };
      if (!isSlotOccupied(state, own)) return illegal();
      if (action.target.playerId === me) return illegal();
      if (!isSlotOccupied(state, action.target)) return illegal();
      const received = slotCard(state, action.target);
      if (received === null) return illegal();
      if (!swapCards(state, own, action.target)) return illegal();
      // "you may look at the card you receive" — auto-revealed: a free look is
      // never disadvantageous, so prompting for it would only cost a round trip.
      emitPrivate(events, me, {
        type: 'revealed',
        reason: 'queen',
        playerId: action.target.playerId,
        slot: action.target.slot,
        card: publicCard(received),
      });
      addLog(state, {
        round: state.round,
        kind: 'effect',
        actor: me,
        target: action.target.playerId,
        text: 'queenSwap',
      });
      emit(events, {
        type: 'effectUsed',
        by: me,
        rank: eff.rank,
        ownSlot: action.slot,
        target: action.target,
      });
      finishEffect(state, ctx, events);
      return null;
    }

    // --- King: look at any two cards, then decide whether to swap them ------
    case 'EFFECT_KING_PEEK': {
      if (eff.rank !== 'K') return illegal();
      if (sameRef(action.a, action.b)) return illegal();
      const ca = slotCard(state, action.a);
      const cb = slotCard(state, action.b);
      if (ca === null || cb === null) return illegal();
      emitPrivate(events, me, {
        type: 'peeked',
        reason: 'king',
        playerId: action.a.playerId,
        slot: action.a.slot,
        card: publicCard(ca),
      });
      emitPrivate(events, me, {
        type: 'peeked',
        reason: 'king',
        playerId: action.b.playerId,
        slot: action.b.slot,
        card: publicCard(cb),
      });
      eff.a = action.a;
      eff.b = action.b;
      eff.awaitingKingDecision = true;
      emit(events, { type: 'effectUsed', by: me, rank: eff.rank, a: action.a, b: action.b, decision: 'pending' });
      return null;
    }

    default:
      return illegal();
  }
}

/** True when the pending effect is waiting on something other than a first choice. */
export function effectAwaitsKingDecision(state: GameState): boolean {
  return state.effect?.awaitingKingDecision === true;
}

/** Human-readable rank label, used by the UI only. */
export function rankLabel(id: number): string {
  return card(id).rank;
}

import type { Action, CardRef, GameState, PlayerId } from '../src/engine/types';
import type { Table } from './helpers';

/**
 * The random-action generator the property tests drive the engine with.
 *
 * Deliberately sloppy: out-of-range slots, wrong actors and stale tap sequences
 * are all in scope, because a refused action must leave the invariants intact
 * just as a successful one must.
 *
 * It lives in its own module so a counterexample reported by fast-check can be
 * replayed on its own — see `tests/replay.test.ts`.
 */

export const MAX_STEPS = 1500;

function pick<T>(rng: () => number, items: readonly T[]): T {
  const item = items[Math.floor(rng() * items.length)];
  if (item === undefined) throw new Error('pick: empty list');
  return item;
}

export function randomAction(rng: () => number, t: Table): Action | null {
  const s: GameState = t.state;
  const ids: PlayerId[] = t.ids;
  const turnId = s.players[s.turnSeat]?.id ?? ids[0]!;
  const slot = (): number => Math.floor(rng() * 5); // 5 can be out of range: on purpose
  const ref = (): CardRef => ({ playerId: pick(rng, ids), slot: slot() });
  const actor = rng() < 0.8 ? turnId : pick(rng, ids);

  if (s.phase === 'peek') {
    return rng() < 0.6
      ? { type: 'PEEK', playerId: pick(rng, ids), slot: pick(rng, [0, 1, 2, 3]) }
      : { type: 'READY', playerId: pick(rng, ids) };
  }
  if (s.phase === 'reveal') return { type: 'CONTINUE', playerId: pick(rng, ids) };
  if (s.phase === 'gameOver') return null;

  if (s.tap) {
    const tapper = s.tap.playerId;
    if (s.tap.awaitingPlacement) {
      return rng() < 0.5 ? { type: 'TAP_PLACE', playerId: tapper, slot: slot() } : { type: 'TAP_DECLINE_PLACE', playerId: tapper };
    }
    return { type: 'TAP_CHOOSE', playerId: tapper, target: ref() };
  }

  // Tapping is open to everyone, out of turn, whenever the discard can be matched.
  if (rng() < 0.15) {
    return {
      type: 'TAP',
      playerId: pick(rng, ids),
      seenSeq: rng() < 0.8 ? s.discardSeq : s.discardSeq - 1, // sometimes deliberately stale
    };
  }

  switch (s.phase) {
    case 'turnStart': {
      const roll = rng();
      if (roll < 0.1) return { type: 'CALL_KABOO', playerId: actor };
      if (roll < 0.16) return { type: 'COUNTER_KABOO', playerId: actor };
      return { type: 'DRAW', playerId: actor, from: rng() < 0.8 ? 'deck' : 'discard' };
    }
    case 'drawn':
      return rng() < 0.7 ? { type: 'SWAP', playerId: actor, slot: slot() } : { type: 'DISCARD', playerId: actor };
    case 'effect': {
      const by = s.effect?.by ?? turnId;
      const rank = s.effect?.rank ?? '7';
      if (s.effect?.awaitingKingDecision) {
        return { type: 'EFFECT_KING_DECIDE', playerId: by, swap: rng() < 0.5 };
      }
      const roll = rng();
      if (roll < 0.12) return { type: 'EFFECT_SKIP', playerId: by };
      if (rank === '7' || rank === '8') return { type: 'EFFECT_PEEK_OWN', playerId: by, slot: slot() };
      if (rank === '9' || rank === '10') {
        return { type: 'EFFECT_PEEK_OTHER', playerId: by, targetPlayerId: pick(rng, ids), slot: slot() };
      }
      if (rank === 'J') return { type: 'EFFECT_BLIND_SWAP', playerId: by, a: ref(), b: ref() };
      if (rank === 'Q') return { type: 'EFFECT_QUEEN_SWAP', playerId: by, slot: slot(), target: ref() };
      return { type: 'EFFECT_KING_PEEK', playerId: by, a: ref(), b: ref() };
    }
    case 'finalSwap': {
      const roll = rng();
      if (roll < 0.6) return { type: 'FINAL_SWAP', playerId: turnId, slot: slot() };
      return { type: 'FINAL_DECLINE', playerId: turnId };
    }
    default:
      return null;
  }
}


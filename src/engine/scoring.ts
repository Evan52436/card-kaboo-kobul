import { handTotal } from './cards';
import { tieBreakRank } from './rules';
import { getPlayer } from './state';
import type { GameResult, GameState, PlayerId, RoundResult } from './types';

/** Total of one player's hand. NEVER call this before the round is revealed. */
export function handScore(state: GameState, playerId: PlayerId): number {
  const p = getPlayer(state, playerId);
  if (!p) throw new Error(`kaboo: unknown player ${playerId}`);
  return handTotal(p.hand, state.rules);
}

/** Lowest total wins; ties break by seat order walking left from the dealer. */
function comparePlayers(state: GameState, a: PlayerId, b: PlayerId): number {
  const pa = getPlayer(state, a);
  const pb = getPlayer(state, b);
  if (!pa || !pb) throw new Error('kaboo: unknown player in scoring');
  const n = state.players.length;
  const diff = handTotal(pa.hand, state.rules) - handTotal(pb.hand, state.rules);
  if (diff !== 0) return diff;
  if (state.rules.tieBreak === 'seatOrder') {
    return tieBreakRank(pa.seat, state.dealerSeat, n) - tieBreakRank(pb.seat, state.dealerSeat, n);
  }
  return pa.seat - pb.seat;
}

/**
 * Score the round and fold it into the cumulative totals.
 *
 * Mutates `state.players[*].score` — called exactly once, from `revealRound`.
 */
export function scoreRound(state: GameState): RoundResult {
  const totals: Record<PlayerId, number> = {};
  for (const p of state.players) totals[p.id] = handTotal(p.hand, state.rules);

  const ranked = state.players.map((p) => p.id).sort((a, b) => comparePlayers(state, a, b));
  const winnerId = ranked[0]!;

  // A caller who did not win eats the penalty. Counter-callers are scored the
  // same way — that is the minimal reading of counter-KABOO (AGENTS.md §6).
  const penaltyIds = state.players
    .filter((p) => (p.calledKaboo || p.counterKaboo) && p.id !== winnerId)
    .map((p) => p.id);
  const penalised = new Set(penaltyIds);

  const awarded: Record<PlayerId, number> = {};
  for (const p of state.players) {
    if (p.id === winnerId) {
      awarded[p.id] = 0;
    } else if (penalised.has(p.id)) {
      awarded[p.id] =
        state.rules.kabooPenaltyMode === 'flat'
          ? state.rules.kabooPenaltyPoints
          : totals[p.id]! + state.rules.kabooPenaltyPoints;
    } else {
      awarded[p.id] = totals[p.id]!;
    }
  }

  for (const p of state.players) p.score += awarded[p.id]!;

  return { round: state.round, totals, winnerId, penaltyIds, awarded };
}

export function shouldGameEnd(state: GameState): boolean {
  if (state.round <= 0) return false;
  if (state.rules.endCondition === 'fixedRounds') return state.round >= state.rules.rounds;
  // A score threshold ends the game as soon as anyone reaches it. Highest score
  // is worst, so there is no incentive to "win" by hitting it.
  return state.players.some((p) => p.score >= state.rules.scoreLimit);
}

export function buildGameResult(state: GameState): GameResult {
  const standings = state.players
    .map((p) => ({ playerId: p.id, score: p.score }))
    .sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score;
      const pa = getPlayer(state, a.playerId)!;
      const pb = getPlayer(state, b.playerId)!;
      return tieBreakRank(pa.seat, state.dealerSeat, state.players.length) -
        tieBreakRank(pb.seat, state.dealerSeat, state.players.length);
    });

  return {
    winnerId: standings[0]!.playerId,
    standings,
    reason: state.rules.endCondition,
  };
}

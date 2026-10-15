import type { RuleConfig } from './types';

/**
 * Every rule flag, its default, and why. These defaults are the answers recorded
 * in AGENTS.md §6 "Open decisions" — change them there first, then here.
 */
export const DEFAULT_RULES: RuleConfig = {
  // /* Jokers */ off by default, per the brief.
  jokers: false,

  // /* Matt's pairs */ off by default, per the brief.
  mattsPairs: false,

  // Counter-KABOO is implemented with the minimal reading (AGENTS.md §6).
  counterKaboo: true,

  // Tapping matches on rank, so red kings match black kings (AGENTS.md §6).
  redKingsMatchRank: true,

  // A tap is stale once the discard top changes (AGENTS.md §6).
  tapClosesOnDiscardChange: true,

  // Abandoning a claimed tap draws a penalty card (AGENTS.md §6).
  tapTimeoutIsWrongTap: true,

  // Deterministic, and leaks nothing, unlike a "closest to the caller" rule (AGENTS.md §6).
  tieBreak: 'seatOrder',

  // Five rounds, then the lowest cumulative score wins (AGENTS.md §6).
  endCondition: 'fixedRounds',
  rounds: 5,
  scoreLimit: 100,

  // A failed call costs the caller their hand PLUS the penalty (AGENTS.md §6).
  kabooPenaltyMode: 'added',
  kabooPenaltyPoints: 20,

  // Guarantees the round terminates even if players ping-pong the discard forever.
  turnLimit: 500,

  // Deadlines are stored and resolved lazily; serverless has no durable timers.
  turnDeadlineMs: 75_000,
  peekDeadlineMs: 45_000,
  tapDeadlineMs: 8_000,
  finalSwapDeadlineMs: 20_000,

  handSize: 4,
};

export function resolveRules(overrides?: Partial<RuleConfig>): RuleConfig {
  return { ...DEFAULT_RULES, ...(overrides ?? {}) };
}

/**
 * Turn-order preference for equal totals. Returns a lower number for the player
 * who should win a tie: seat order walking left from the dealer.
 */
export function tieBreakRank(seat: number, dealerSeat: number, seatCount: number): number {
  return (seat - dealerSeat - 1 + seatCount) % seatCount;
}

import { isEmptyHand, makeDeck, shuffle } from './cards';
import { illegal } from './errors';
import { resolveRules } from './rules';
import type {
  CardId,
  Ctx,
  EngineError,
  GameConfig,
  GameState,
  LogEntry,
  PlayerId,
  PlayerState,
  RuleConfig,
} from './types';

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 8;

/**
 * The two slots a player may look at once, at the start of a round.
 *
 * Hands are a 2×2 square: slots 0,1 are the far row and 2,3 are the near row.
 * The brief's "bottom 2 cards" is the near row — the ones you would thumb up
 * from the table edge.
 */
export const PEEK_SLOTS: readonly number[] = [2, 3];

/** Deep clone. The engine never mutates the state handed to it. */
export function cloneState(state: GameState): GameState {
  return structuredClone(state);
}

export function getPlayer(state: GameState, id: PlayerId): PlayerState | undefined {
  return state.players.find((p) => p.id === id);
}

export function playerAtSeat(state: GameState, seat: number): PlayerState {
  const p = state.players[seat];
  if (!p) throw new Error(`kaboo: no player at seat ${seat}`);
  return p;
}

export function playerIds(state: GameState): PlayerId[] {
  return state.players.map((p) => p.id);
}

export function seatOf(state: GameState, id: PlayerId): number {
  const p = getPlayer(state, id);
  return p ? p.seat : -1;
}

export function isMyTurn(state: GameState, id: PlayerId): boolean {
  return seatOf(state, id) === state.turnSeat;
}

/** The ring index of the seat after `seat`. */
export function nextSeat(seat: number, count: number): number {
  return (seat + 1) % count;
}

/**
 * Advance to the next seat that is still owed a turn.
 *
 * When a KABOO is live, only players in `finalTurnsRemaining` are eligible, so
 * the caller's own seat is skipped and nobody gets a second final turn.
 */
export function nextEligibleSeat(state: GameState, from: number): number {
  const count = state.players.length;
  if (state.kabooCallerId === null) return nextSeat(from, count);

  for (let step = 1; step <= count; step++) {
    const seat = (from + step) % count;
    const p = state.players[seat];
    if (p && state.finalTurnsRemaining.includes(p.id)) return seat;
  }
  // Nobody left to play — the caller's turn resolution ends the round.
  return from;
}

export function newPlayer(id: PlayerId, name: string, seat: number, handSize: number): PlayerState {
  return {
    id,
    name,
    seat,
    hand: new Array<CardId | null>(handSize).fill(null),
    gen: new Array<number>(handSize).fill(0),
    score: 0,
    connected: true,
    ready: false,
    peeked: new Array<boolean>(handSize).fill(false),
    calledKaboo: false,
    counterKaboo: false,
    finalTurnDone: false,
  };
}

// ---------------------------------------------------------------------------
// Slot mutation. Every mutation bumps `gen` so the UI can animate a change
// without ever being told which card arrived. See AGENTS.md §7.
// ---------------------------------------------------------------------------

export function setSlot(state: GameState, playerId: PlayerId, index: number, cardId: CardId): void {
  const p = getPlayer(state, playerId);
  if (!p) throw new Error(`kaboo: unknown player ${playerId}`);
  if (index < 0 || index >= p.hand.length) throw new Error(`kaboo: slot ${index} out of range`);
  p.hand[index] = cardId;
  p.gen[index] = (p.gen[index] ?? 0) + 1;
}

export function clearSlot(state: GameState, playerId: PlayerId, index: number): void {
  const p = getPlayer(state, playerId);
  if (!p) throw new Error(`kaboo: unknown player ${playerId}`);
  if (index < 0 || index >= p.hand.length) throw new Error(`kaboo: slot ${index} out of range`);
  p.hand[index] = null;
  p.gen[index] = (p.gen[index] ?? 0) + 1;
}

/** Penalty cards land in a brand-new slot; hands may grow past the dealt size. */
export function appendSlot(state: GameState, playerId: PlayerId, cardId: CardId): number {
  const p = getPlayer(state, playerId);
  if (!p) throw new Error(`kaboo: unknown player ${playerId}`);
  p.hand.push(cardId);
  p.gen.push(0);
  p.peeked.push(false);
  return p.hand.length - 1;
}

export function slotCard(state: GameState, ref: { playerId: PlayerId; slot: number }): CardId | null {
  const p = getPlayer(state, ref.playerId);
  if (!p) return null;
  return p.hand[ref.slot] ?? null;
}

export function isSlotOccupied(state: GameState, ref: { playerId: PlayerId; slot: number }): boolean {
  return slotCard(state, ref) !== null;
}

// ---------------------------------------------------------------------------
// Piles
// ---------------------------------------------------------------------------

export function discardTop(state: GameState): CardId | null {
  const top = state.discard[state.discard.length - 1];
  return top === undefined ? null : top;
}

export function pushDiscard(state: GameState, cardId: CardId): void {
  state.discard.push(cardId);
  state.discardSeq += 1;
}

/** Removes and returns the top of the draw pile. */
export function popDeck(state: GameState): CardId | null {
  const top = state.deck.shift();
  return top === undefined ? null : top;
}

export function drawPileEmpty(state: GameState): boolean {
  return state.deck.length === 0;
}

export function addLog(state: GameState, entry: LogEntry): void {
  state.log.push(entry);
  // The log is for the UI; cap it so a long game cannot bloat the Redis value.
  if (state.log.length > 200) state.log.splice(0, state.log.length - 200);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

function freshRoundFields(state: GameState): void {
  state.deck = [];
  state.discard = [];
  state.discardSeq = 0;
  state.setAside = null;
  state.drawn = null;
  state.heldCardId = null;
  state.tap = null;
  state.effect = null;
  state.kabooCallerId = null;
  state.finalTurnsRemaining = [];
  state.finalSwapDeadline = 0;
  state.turnDeadline = 0;
  state.roundResult = null;
  state.turnCount = 0;
}

/**
 * Deal a round: shuffle, hand out `handSize` cards in a 2×2 square per player,
 * and open the peek phase.
 *
 * NOTE: the discard pile starts EMPTY — the brief says the remaining cards form
 * the draw pile, so nothing is flipped to start. The first player therefore
 * cannot take from the discard. See AGENTS.md §7.
 */
export function startRound(state: GameState, ctx: Ctx): void {
  const rules = state.rules;
  freshRoundFields(state);
  state.round += 1;
  state.phase = 'peek';

  state.deck = shuffle(makeDeck(rules), ctx.rng);

  for (const p of state.players) {
    p.hand = new Array<CardId | null>(rules.handSize).fill(null);
    p.gen = new Array<number>(rules.handSize).fill(0);
    p.ready = false;
    p.peeked = new Array<boolean>(rules.handSize).fill(false);
    p.calledKaboo = false;
    p.counterKaboo = false;
    p.finalTurnDone = false;
  }

  // Deal one card at a time around the table, slot by slot — the way it is dealt
  // by hand. Reproducible given a seeded rng.
  for (let slot = 0; slot < rules.handSize; slot++) {
    for (const p of state.players) {
      const cardId = popDeck(state);
      if (cardId === null) throw new Error('kaboo: deck exhausted while dealing');
      setSlot(state, p.id, slot, cardId);
    }
  }

  state.turnSeat = nextSeat(state.dealerSeat, state.players.length);
  state.peekDeadline = ctx.now + rules.peekDeadlineMs;
  state.turnDeadline = 0;
  state.lastActivityAt = ctx.now;

  addLog(state, { round: state.round, kind: 'roundStart' });
}

export function createGame(config: GameConfig, ctx: Ctx): GameState {
  const rules = resolveRules(config.rules);
  if (config.players.length < MIN_PLAYERS) throw new Error('kaboo: need at least 2 players');
  if (config.players.length > MAX_PLAYERS) throw new Error('kaboo: at most 8 players');

  const players = config.players.map((p, i) => newPlayer(p.id, p.name, i, rules.handSize));

  const state: GameState = {
    roomCode: config.roomCode,
    version: 0,
    // `startRound` below immediately overwrites this with 'peek'. The literal
    // only needs some valid member to build the object with.
    phase: 'peek',
    round: 0,
    rules,
    players,
    seatOrder: players.map((p) => p.id),
    dealerSeat: config.dealerSeat ?? 0,
    turnSeat: 0,
    turnCount: 0,
    deck: [],
    discard: [],
    discardSeq: 0,
    setAside: null,
    drawn: null,
    heldCardId: null,
    tap: null,
    effect: null,
    kabooCallerId: null,
    finalTurnsRemaining: [],
    peekDeadline: 0,
    finalSwapDeadline: 0,
    turnDeadline: 0,
    roundResult: null,
    gameResult: null,
    log: [],
    startedAt: ctx.now,
    lastActivityAt: ctx.now,
  };

  startRound(state, ctx);
  return state;
}

/** Begin the next round: advance the dealer, then deal. */
export function startNextRound(state: GameState, ctx: Ctx): EngineError | null {
  if (state.phase !== 'reveal') return illegal();
  state.dealerSeat = nextSeat(state.dealerSeat, state.players.length);
  startRound(state, ctx);
  return null;
}

/** Has any player run out of cards? That player auto-KABOOs (house rule). */
export function findEmptyHandPlayer(state: GameState): PlayerState | null {
  for (const p of state.players) {
    if (isEmptyHand(p.hand)) return p;
  }
  return null;
}

export function rulesOf(state: GameState): RuleConfig {
  return state.rules;
}

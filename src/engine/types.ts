/**
 * Core domain types for the Kaboo engine.
 *
 * This folder is PURE: no framework, no IO, no `Date.now()`, no `Math.random()`.
 * Time and randomness arrive through `Ctx`. That keeps `applyAction` a pure,
 * testable function and means this engine can be lifted onto a plain Node server
 * without changing a line.
 */

export type PlayerId = string;

export type CardId = number;

export type Suit = 'S' | 'H' | 'D' | 'C';

export type Rank =
  | 'A'
  | '2'
  | '3'
  | '4'
  | '5'
  | '6'
  | '7'
  | '8'
  | '9'
  | '10'
  | 'J'
  | 'Q'
  | 'K'
  | 'JOKER';

export interface Card {
  readonly id: CardId;
  /** `null` for jokers. */
  readonly suit: Suit | null;
  readonly rank: Rank;
  readonly red: boolean;
  /** Ace = 1, 2–10 face value, J/Q/K = 10, RED king = -1, joker = 0. */
  readonly value: number;
}

/**
 * A hand slot holds a card id, or `null` when empty.
 *
 * Slots are FIXED: they are never compacted, because players remember positions.
 * A hand can grow past 4 (penalty cards are appended) and can contain holes
 * (a tapped card removed by someone else leaves a gap).
 */
export type Slot = CardId | null;

/** A reference to one specific slot on the table, for effects and taps. */
export interface CardRef {
  readonly playerId: PlayerId;
  readonly slot: number;
}

/**
 * The turn spine. Every phase is meaningful and reachable — there is no phase
 * kept around "just in case".
 *
 * There is no `lobby` phase: gathering players into a room happens BEFORE the
 * engine is involved, because the roster is fixed at `createGame`. The room
 * layer owns "who has arrived" (`src/server/room.ts`); the engine starts at the
 * deal, in `peek`.
 *
 * `tapWindow` is deliberately NOT here: a claimed tap is orthogonal to whose
 * turn it is, so it lives in `GameState.tap` instead. See AGENTS.md §4.
 */
export type Phase =
  | 'peek'
  | 'turnStart'
  | 'drawn'
  | 'effect'
  | 'finalSwap'
  | 'reveal'
  | 'gameOver';

export interface PlayerState {
  readonly id: PlayerId;
  name: string;
  seat: number;
  /** Server-only view of the hand. NEVER sent to a client wholesale — see project.ts. */
  hand: Slot[];
  /** `gen[i]` increments every time hand slot `i` changes contents, for UI animation. */
  gen: number[];
  /** Cumulative score across rounds. Public. */
  score: number;
  connected: boolean;
  /** Peek phase complete for this player. */
  ready: boolean;
  /** Per-slot: has this player used their one peek on this slot? Never leaks card faces. */
  peeked: boolean[];
  /** This player called KABOO (original caller, not a counter). */
  calledKaboo: boolean;
  /** This player counter-KABOOed. */
  counterKaboo: boolean;
  /** Has this player taken their single final turn after a KABOO? */
  finalTurnDone: boolean;
}

export interface TapState {
  readonly playerId: PlayerId;
  /** The `discardSeq` this claim was made against; a stale claim is rejected. */
  readonly seq: number;
  readonly claimedAt: number;
  readonly deadline: number;
  /** Set once the tapper has named a card and it came from another player's hand. */
  awaitingPlacement: boolean;
  /** Where the tapped card came from, once chosen. */
  source: CardRef | null;
}

export interface EffectState {
  readonly by: PlayerId;
  readonly rank: Rank;
  /** King step 2: the two cards already peeked, awaiting the swap decision. */
  a: CardRef | null;
  b: CardRef | null;
  awaitingKingDecision: boolean;
}

export interface RoundResult {
  round: number;
  /** Per-player totals as revealed at the end of the round. */
  totals: Record<PlayerId, number>;
  winnerId: PlayerId;
  /** Players who called (or counter-called) KABOO and did not win. */
  penaltyIds: PlayerId[];
  /** Points added to each player's cumulative score this round. */
  awarded: Record<PlayerId, number>;
}

export interface GameResult {
  winnerId: PlayerId;
  standings: { playerId: PlayerId; score: number }[];
  reason: 'fixedRounds' | 'scoreThreshold';
}

export type LogKind =
  | 'roundStart'
  | 'peeked'
  | 'ready'
  | 'drew'
  | 'tookDiscard'
  | 'swapped'
  | 'discarded'
  | 'effect'
  | 'tapClaimed'
  | 'tapSuccess'
  | 'tapWrong'
  | 'tapTimeout'
  | 'placed'
  | 'kaboo'
  | 'counterKaboo'
  | 'autoKaboo'
  | 'finalSwap'
  | 'finalDecline'
  | 'deckOut'
  | 'turnLimit'
  | 'reveal'
  | 'roundEnd'
  | 'gameEnd'
  | 'playerLeft'
  | 'playerJoined';

/** Structured log entry. The UI renders the text — the engine never bakes in copy. */
export interface LogEntry {
  round: number;
  kind: LogKind;
  actor?: PlayerId;
  target?: PlayerId;
  /**
   * Deliberately NOT a card. A log line records WHO did WHAT; it never carries a
   * face. A face logged here would stay in the projection forever, so a card that
   * was discarded in the open and later taken into a hand would be readable by
   * everyone — a leak no per-slot projection can undo. Card faces ship only while
   * they are face-up on the table. See AGENTS.md §7.
   */
  text?: string;
}

export interface PublicCard {
  id: CardId;
  rank: Rank;
  suit: Suit | null;
  red: boolean;
  value: number;
}

export interface RuleConfig {
  /** Include the two value-0 jokers. Default OFF. */
  jokers: boolean;
  /** "Matt's pairs": a matching pair in a hand counts 0 (red kings excepted). Default OFF. */
  mattsPairs: boolean;
  /** Allow counter-KABOO after a call. Default ON. */
  counterKaboo: boolean;
  /** Do red kings match other kings when tapping? Default ON (match on rank). */
  redKingsMatchRank: boolean;
  /** A claimed tap goes stale once the discard top changes. Default ON. */
  tapClosesOnDiscardChange: boolean;
  /** Does abandoning a claimed tap draw a penalty card? Default ON. */
  tapTimeoutIsWrongTap: boolean;
  /** Round winner tie-break. */
  tieBreak: 'seatOrder' | 'none';
  /** How a multi-round game ends. */
  endCondition: 'fixedRounds' | 'scoreThreshold';
  rounds: number;
  scoreLimit: number;
  /**
   * What a failed KABOO call costs. The brief says the caller "gets +20 bonus
   * points (a penalty)" and separately that "all others score the sum of their
   * card values" — both `added` and `flat` are defensible readings of that.
   * `added` matches standard Cabo and the word "bonus". See AGENTS.md §6.
   */
  kabooPenaltyMode: 'added' | 'flat';
  kabooPenaltyPoints: number;
  /** Hard guard so a round can never run forever. See AGENTS.md §6. */
  turnLimit: number;
  /**
   * How long a player may hold up the table before the engine plays a safe
   * default for them. Without this a disconnected player freezes the room
   * forever, because a serverless function cannot hold a timer.
   */
  turnDeadlineMs: number;
  peekDeadlineMs: number;
  tapDeadlineMs: number;
  finalSwapDeadlineMs: number;
  handSize: number;
}

export interface GameConfig {
  roomCode: string;
  players: { id: PlayerId; name: string }[];
  rules?: Partial<RuleConfig>;
  /** Seat of the dealer for round 1. Defaults to seat 0. */
  dealerSeat?: number;
}

export interface Ctx {
  /** Epoch ms. Never call Date.now() inside the engine. */
  now: number;
  /** Uniform [0, 1). Injected so tests can be seeded and deterministic. */
  rng: () => number;
}

export interface GameState {
  roomCode: string;
  /** Compare-and-set token for the StateStore. Incremented by every applied action. */
  version: number;
  phase: Phase;
  round: number;
  rules: RuleConfig;
  players: PlayerState[];
  /** Player ids in seat order — the turn ring. */
  seatOrder: PlayerId[];
  dealerSeat: number;
  turnSeat: number;
  turnCount: number;
  /** SERVER ONLY. Index 0 is the top of the draw pile. */
  deck: CardId[];
  /** Index 0 is the bottom; the last element is the top. */
  discard: CardId[];
  /** Bumped whenever the top of the discard pile changes. Stale taps are rejected against it. */
  discardSeq: number;
  /** The declined last card, parked so every card id is accounted for exactly once. */
  setAside: CardId | null;
  drawn: { cardId: CardId; from: 'deck' | 'discard'; by: PlayerId } | null;
  /** The last card of the draw pile, held while the drawer decides. SERVER ONLY. */
  heldCardId: CardId | null;
  tap: TapState | null;
  effect: EffectState | null;
  kabooCallerId: PlayerId | null;
  /** Seats still owed exactly one final turn after a KABOO. */
  finalTurnsRemaining: PlayerId[];
  peekDeadline: number;
  finalSwapDeadline: number;
  /** When the current player's turn is auto-played for them. */
  turnDeadline: number;
  roundResult: RoundResult | null;
  gameResult: GameResult | null;
  log: LogEntry[];
  startedAt: number;
  lastActivityAt: number;
}

/**
 * Every action names its actor in `playerId`. Actions that need a second party
 * use a distinctly named field (`targetPlayerId`, `target`, `a`/`b`) so an actor
 * can never be confused with a target.
 */
export type Action =
  // --- peek phase ---------------------------------------------------------
  | { type: 'PEEK'; playerId: PlayerId; slot: number }
  | { type: 'READY'; playerId: PlayerId }
  // --- between rounds -----------------------------------------------------
  | { type: 'CONTINUE'; playerId: PlayerId }
  // --- turn spine ---------------------------------------------------------
  | { type: 'CALL_KABOO'; playerId: PlayerId }
  | { type: 'COUNTER_KABOO'; playerId: PlayerId }
  | { type: 'DRAW'; playerId: PlayerId; from: 'deck' | 'discard' }
  | { type: 'SWAP'; playerId: PlayerId; slot: number }
  | { type: 'DISCARD'; playerId: PlayerId }
  | { type: 'FINAL_SWAP'; playerId: PlayerId; slot: number }
  | { type: 'FINAL_DECLINE'; playerId: PlayerId }
  // --- effects ------------------------------------------------------------
  | { type: 'EFFECT_SKIP'; playerId: PlayerId }
  | { type: 'EFFECT_PEEK_OWN'; playerId: PlayerId; slot: number }
  | { type: 'EFFECT_PEEK_OTHER'; playerId: PlayerId; targetPlayerId: PlayerId; slot: number }
  | { type: 'EFFECT_BLIND_SWAP'; playerId: PlayerId; a: CardRef; b: CardRef }
  | { type: 'EFFECT_QUEEN_SWAP'; playerId: PlayerId; slot: number; target: CardRef }
  | { type: 'EFFECT_KING_PEEK'; playerId: PlayerId; a: CardRef; b: CardRef }
  | { type: 'EFFECT_KING_DECIDE'; playerId: PlayerId; swap: boolean }
  // --- out-of-turn tap race ------------------------------------------------
  | { type: 'TAP'; playerId: PlayerId; seenSeq: number }
  | { type: 'TAP_CHOOSE'; playerId: PlayerId; target: CardRef }
  | { type: 'TAP_PLACE'; playerId: PlayerId; slot: number }
  | { type: 'TAP_DECLINE_PLACE'; playerId: PlayerId }
  // --- housekeeping --------------------------------------------------------
  | { type: 'LEAVE'; playerId: PlayerId };

export type ActionType = Action['type'];

export interface EngineError {
  ok: false;
  code:
    | 'E_ILLEGAL'
    | 'E_NOT_YOUR_TURN'
    | 'E_STALE'
    | 'E_TOO_LATE'
    | 'E_UNKNOWN_PLAYER'
    | 'E_ROOM_FULL'
    | 'E_GAME_OVER';
  /** Deliberately generic — must never explain a rejection when the reason is hidden info. */
  message: string;
}

export interface EngineEvent {
  type:
    | 'peeked'
    | 'revealed'
    | 'drew'
    | 'tookDiscard'
    | 'swapped'
    | 'discarded'
    | 'effectUsed'
    | 'effectSkipped'
    | 'tapClaimed'
    | 'tapResolved'
    | 'tapWrong'
    | 'tapTimeout'
    | 'placed'
    | 'kaboo'
    | 'counterKaboo'
    | 'autoKaboo'
    | 'finalSwap'
    | 'finalDecline'
    | 'deckOut'
    | 'turnLimit'
    | 'reveal'
    | 'roundEnd'
    | 'gameEnd'
    | 'turnChanged'
    | 'phaseChanged';
  /** Present ⇒ PRIVATE event: route only to this player's channel. Absent ⇒ public. */
  to?: PlayerId;
  /**
   * A face carried for the recipient of THIS event only.
   *
   * Declared explicitly rather than left to the index signature below, because it
   * is the one payload field that decides whether information is private: a peek
   * or a private deck-out look ships its card here and nowhere else. Events are
   * transient — unlike a log entry, which must never carry a face. See AGENTS.md §7.
   */
  card?: PublicCard;
  [key: string]: unknown;
}

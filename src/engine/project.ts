import { occupiedCount, publicCard } from './cards';
import { canTapNow } from './tap';
import { PEEK_SLOTS, getPlayer } from './state';
import type {
  ActionType,
  GameResult,
  GameState,
  LogEntry,
  Look,
  PlayerId,
  PublicCard,
  RoundResult,
  RuleConfig,
} from './types';

/**
 * ============================================================================
 *  THE HIDDEN-INFORMATION BOUNDARY
 * ============================================================================
 *  Everything a client is allowed to know is built here, and only here.
 *
 *  Rules this file must never break:
 *   1. A card the viewer may not see is represented by `{occupied: true, face: null}`
 *      — never by a card id. Ids would leak faces, because the discard pile
 *      publishes `{id, rank}` and a client could join the two.
 *   2. `gen` changes when a slot's contents change, so the UI can animate and the
 *      player learns THAT their card was replaced (which they would see happen at
 *      a real table) without learning WHAT it became.
 *   3. No hand total is ever computed or exposed before `reveal`.
 *   4. Peeks are events, not state — they appear nowhere in this file.
 * ============================================================================
 */

export interface SlotView {
  index: number;
  occupied: boolean;
  /** Bumped whenever this slot's contents change. Safe to animate on. */
  gen: number;
  /** The card, only when it is genuinely public to this viewer. */
  face: PublicCard | null;
}

export interface PlayerView {
  id: PlayerId;
  name: string;
  seat: number;
  connected: boolean;
  hand: SlotView[];
  /** How many cards they hold. Public — you can count cards on a table. */
  handCount: number;
  /** Cumulative score across rounds. Public; the round's live total is NOT. */
  score: number;
  ready: boolean;
  calledKaboo: boolean;
  counterKaboo: boolean;
  finalTurnDone: boolean;
  isTurn: boolean;
}

export interface Projection {
  roomCode: string;
  version: number;
  phase: GameState['phase'];
  round: number;
  rounds: number;
  youId: PlayerId;
  players: PlayerView[];
  turnSeat: number;
  turnPlayerId: PlayerId | null;
  drawPileCount: number;
  discardTop: PublicCard | null;
  discardCount: number;
  discardRecent: PublicCard[];
  /**
   * How many times the discard top has changed.
   *
   * Public, and required: a `TAP` must carry the `seenSeq` it was reacting to, so
   * a client that cannot read this cannot legitimately tap at all. It leaks
   * nothing — anyone at the table can see how many cards are on the pile.
   */
  discardSeq: number;
  setAside: PublicCard | null;
  drawn: { from: 'deck' | 'discard'; by: PlayerId; isYours: boolean; card: PublicCard | null } | null;
  heldCard: { isYours: boolean; card: PublicCard | null } | null;
  tap: {
    playerId: PlayerId;
    deadline: number;
    awaitingPlacement: boolean;
    source: { playerId: PlayerId; slot: number } | null;
  } | null;
  effect: {
    by: PlayerId;
    rank: string;
    awaitingKingDecision: boolean;
    a: { playerId: PlayerId; slot: number } | null;
    b: { playerId: PlayerId; slot: number } | null;
  } | null;
  kabooCallerId: PlayerId | null;
  finalTurnsRemaining: PlayerId[];
  deadlines: { turn: number; peek: number; tap: number; finalSwap: number };
  /**
   * The slots this viewer may still look at. Empty outside `peek`, and empty
   * once they have looked at both — so the UI can highlight exactly the cards
   * that are legal to tap, instead of re-deriving "the bottom two" itself.
   */
  peekableSlots: number[];
  canTap: boolean;
  legalActions: ActionType[];
  log: LogEntry[];
  /**
   * Who lifted which card, newest last. Public, because at a real table you can
   * watch a card being picked up; it names a slot and never a face, so it tells a
   * player THAT one of their cards is being looked at, not what it is. The client
   * animates it. See `Look`.
   */
  looks: Look[];
  roundResult: RoundResult | null;
  gameResult: GameResult | null;
  rules: RuleConfig;
  /** True once every hand is face-up. */
  revealed: boolean;
}

const RECENT_DISCARD = 5;
const LOG_TAIL = 60;

function viewHand(
  state: GameState,
  playerId: PlayerId,
  viewerId: PlayerId,
  revealed: boolean,
): SlotView[] {
  const p = getPlayer(state, playerId);
  if (!p) return [];
  return p.hand.map((cardId, index) => ({
    index,
    occupied: cardId !== null,
    gen: p.gen[index] ?? 0,
    // Faces are public only at the reveal. Your own hand is hidden from you too:
    // the brief is explicit that you must remember what you peeked at.
    face: revealed && cardId !== null ? publicCard(cardId) : null,
  }));
}

/**
 * Which slots this viewer may still peek at, mirroring `handlePeek` exactly.
 *
 * The brief's "you may look at your bottom two cards once" is a slot constraint,
 * not just a phase constraint, so the client cannot infer it from `phase` alone.
 */
export function peekableSlots(state: GameState, viewerId: PlayerId): number[] {
  if (state.phase !== 'peek') return [];
  const me = getPlayer(state, viewerId);
  if (!me || me.ready) return [];
  return PEEK_SLOTS.filter((slot) => !me.peeked[slot] && (me.hand[slot] ?? null) !== null);
}

/**
 * Which actions this viewer may legally send right now.
 *
 * This is a UI convenience only — `applyAction` remains the single authority and
 * re-checks everything. Shipping it stops the client from re-implementing (and
 * drifting from) the phase machine.
 */
export function legalActions(state: GameState, viewerId: PlayerId): ActionType[] {
  const out: ActionType[] = [];
  const me = getPlayer(state, viewerId);
  if (!me) return out;

  const isTurn = state.players[state.turnSeat]?.id === viewerId;
  const tapOpen = canTapNow(state);

  if (state.phase === 'peek') {
    if (!me.ready) {
      if (peekableSlots(state, viewerId).length > 0) out.push('PEEK');
      out.push('READY');
    }
    return out;
  }

  if (state.phase === 'reveal') return ['CONTINUE'];
  if (state.phase === 'gameOver') return out;

  // A claimed tap interrupts everything else until it resolves.
  if (state.tap) {
    if (state.tap.playerId === viewerId) {
      if (state.tap.awaitingPlacement) out.push('TAP_PLACE', 'TAP_DECLINE_PLACE');
      else out.push('TAP_CHOOSE');
    }
    return out;
  }

  if (tapOpen) out.push('TAP');

  if (!isTurn) return out;

  switch (state.phase) {
    case 'turnStart':
      out.push('DRAW');
      // KABOO only before you act, and only once.
      if (state.kabooCallerId === null && !me.calledKaboo && !me.counterKaboo) out.push('CALL_KABOO');
      if (state.kabooCallerId !== null && state.rules.counterKaboo && !me.counterKaboo) {
        out.push('COUNTER_KABOO');
      }
      break;
    case 'drawn':
      out.push('SWAP', 'DISCARD');
      break;
    case 'effect': {
      if (state.effect?.by !== viewerId) break;
      const rank = state.effect.rank;
      // A King effect that has already looked at its two cards can only be
      // answered with the swap decision — skipping is no longer on offer, so it
      // must not be advertised.
      if (state.effect.awaitingKingDecision) {
        out.push('EFFECT_KING_DECIDE');
        break;
      }
      out.push('EFFECT_SKIP');
      if (rank === '7' || rank === '8') out.push('EFFECT_PEEK_OWN');
      if (rank === '9' || rank === '10') out.push('EFFECT_PEEK_OTHER');
      if (rank === 'J') out.push('EFFECT_BLIND_SWAP');
      if (rank === 'Q') out.push('EFFECT_QUEEN_SWAP');
      if (rank === 'K') out.push('EFFECT_KING_PEEK');
      break;
    }
    case 'finalSwap':
      out.push('FINAL_SWAP', 'FINAL_DECLINE');
      break;
    default:
      break;
  }

  return out;
}

export function project(state: GameState, viewerId: PlayerId): Projection {
  const revealed = state.phase === 'reveal' || state.phase === 'gameOver';
  const viewer = getPlayer(state, viewerId);
  if (!viewer) throw new Error(`kaboo: cannot project for unknown player ${viewerId}`);

  const turnPlayer = state.players[state.turnSeat];
  const discardRecent = state.discard.slice(-RECENT_DISCARD).map(publicCard);
  const top = state.discard[state.discard.length - 1];

  return {
    roomCode: state.roomCode,
    version: state.version,
    phase: state.phase,
    round: state.round,
    rounds: state.rules.rounds,
    youId: viewerId,
    players: state.players.map((p) => ({
      id: p.id,
      name: p.name,
      seat: p.seat,
      connected: p.connected,
      hand: viewHand(state, p.id, viewerId, revealed),
      handCount: occupiedCount(p.hand),
      score: p.score,
      ready: p.ready,
      calledKaboo: p.calledKaboo,
      counterKaboo: p.counterKaboo,
      finalTurnDone: p.finalTurnDone,
      isTurn: p.seat === state.turnSeat,
    })),
    turnSeat: state.turnSeat,
    turnPlayerId: turnPlayer?.id ?? null,
    drawPileCount: state.deck.length,
    discardTop: top === undefined ? null : publicCard(top),
    discardCount: state.discard.length,
    discardRecent,
    discardSeq: state.discardSeq,
    setAside: revealed && state.setAside !== null ? publicCard(state.setAside) : null,
    drawn: state.drawn
      ? {
          from: state.drawn.from,
          by: state.drawn.by,
          isYours: state.drawn.by === viewerId,
          // A card drawn from the deck is the drawer's private look; a card taken
          // from the discard was already face-up for everyone.
          card:
            state.drawn.by === viewerId || state.drawn.from === 'discard'
              ? publicCard(state.drawn.cardId)
              : null,
        }
      : null,
    heldCard:
      state.heldCardId === null
        ? null
        : {
            isYours: state.players[state.turnSeat]?.id === viewerId,
            card: state.players[state.turnSeat]?.id === viewerId ? publicCard(state.heldCardId) : null,
          },
    tap: state.tap
      ? {
          playerId: state.tap.playerId,
          deadline: state.tap.deadline,
          awaitingPlacement: state.tap.awaitingPlacement,
          source: state.tap.source,
        }
      : null,
    effect: state.effect
      ? {
          by: state.effect.by,
          rank: state.effect.rank,
          awaitingKingDecision: state.effect.awaitingKingDecision,
          a: state.effect.a,
          b: state.effect.b,
        }
      : null,
    kabooCallerId: state.kabooCallerId,
    finalTurnsRemaining: [...state.finalTurnsRemaining],
    deadlines: {
      turn: state.turnDeadline,
      peek: state.peekDeadline,
      tap: state.tap?.deadline ?? 0,
      finalSwap: state.finalSwapDeadline,
    },
    peekableSlots: peekableSlots(state, viewerId),
    canTap: canTapNow(state),
    legalActions: legalActions(state, viewerId),
    log: state.log.slice(-LOG_TAIL),
    looks: (state.looks ?? []).map((l) => ({ ...l })),
    roundResult: state.roundResult,
    gameResult: state.gameResult,
    rules: state.rules,
    revealed,
  };
}

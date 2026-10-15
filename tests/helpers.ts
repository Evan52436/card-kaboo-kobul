import { DECK_SIZE, RANKS, SUITS, card } from '../src/engine/cards';
import { DEFAULT_RULES } from '../src/engine/rules';
import { applyAction, tick } from '../src/engine/reduce';
import type { ApplyResult } from '../src/engine/reduce';
import { createGame } from '../src/engine/state';
import { project } from '../src/engine/project';
import type { Projection } from '../src/engine/project';
import type { Action, Ctx, EngineEvent, GameState, PlayerId, RuleConfig } from '../src/engine/types';

export const T0 = 1_700_000_000_000;

/**
 * mulberry32 — small, fast, fully deterministic.
 *
 * The engine takes randomness as an injected function precisely so tests can use
 * this: every shuffle in a test is reproducible from a seed.
 */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Card id for a rank + suit, e.g. `cid('7', 'H')`. */
export function cid(rank: (typeof RANKS)[number], suit: (typeof SUITS)[number]): number {
  return SUITS.indexOf(suit) * RANKS.length + RANKS.indexOf(rank);
}

export function cardLabel(id: number | null): string {
  if (id === null) return '--';
  const c = card(id);
  return c.suit === null ? 'JOKER' : `${c.rank}${c.suit}`;
}

export interface Table {
  state: GameState;
  ids: PlayerId[];
  seed: number;
  events: EngineEvent[];
  advance(ms: number): void;
  now(): number;
  send(action: Action): ApplyResult;
  ok(action: Action): ApplyResult;
  fail(action: Action): ApplyResult;
  view(id: PlayerId): Projection;
  rules: RuleConfig;
}

export interface TableOptions {
  players?: number;
  seed?: number;
  rules?: Partial<RuleConfig>;
}

export function createTable(opts: TableOptions = {}): Table {
  const n = opts.players ?? 2;
  const seed = opts.seed ?? 7;
  const ids: PlayerId[] = Array.from({ length: n }, (_, i) => `p${i + 1}`);
  const rng = seededRng(seed);
  let now = T0;
  const ctx = (): Ctx => ({ now, rng });

  const table: Table = {
    state: createGame(
      {
        roomCode: 'TEST',
        players: ids.map((id, i) => ({ id, name: `P${i + 1}` })),
        rules: opts.rules,
      },
      ctx(),
    ),
    ids,
    seed,
    events: [],
    advance(ms) {
      now += ms;
    },
    now: () => now,
    send(action) {
      const result = applyAction(table.state, action, ctx());
      if (result.versionChanged) {
        table.state = result.state;
        table.events.push(...result.events);
      }
      return result;
    },
    ok(action) {
      const result = table.send(action);
      if (result.error) {
        throw new Error(
          `expected ${action.type} to succeed, got ${result.error.code}: ${result.error.message}`,
        );
      }
      return result;
    },
    fail(action) {
      const result = table.send(action);
      if (!result.error) throw new Error(`expected ${action.type} to be refused, but it succeeded`);
      return result;
    },
    view(id) {
      return project(table.state, id);
    },
    rules: { ...DEFAULT_RULES, ...(opts.rules ?? {}) },
  };

  return table;
}

// ---------------------------------------------------------------------------
// Deterministic table arrangement
// ---------------------------------------------------------------------------

export interface ArrangeSpec {
  /** Full hand for a player. `null` means an empty slot. */
  hands?: Partial<Record<PlayerId, (number | null)[]>>;
  /** Draw pile, index 0 = the next card drawn. */
  deck?: number[];
  /** Discard pile, last element = the top (the tap target). */
  discard?: number[];
  setAside?: number | null;
}

/**
 * Lay the table out deterministically.
 *
 * Semantics, precisely:
 *   - A card named in the spec is PLACED where the spec says. If it was sitting
 *     somewhere else, it is pulled out of there (an untouched hand it came from
 *     is left with a hole, which is a legal hand state).
 *   - A zone the spec does NOT mention keeps whatever it holds, minus anything
 *     the spec placed elsewhere.
 *   - Every remaining card goes into the draw pile in ascending id order, so
 *     `spec.deck` pins the next cards drawn and the rest of the pile stays
 *     accounted for.
 *
 * The helper asserts there are no duplicates and no strays, so a test that
 * arranges an impossible table fails loudly instead of quietly duplicating a
 * card — which would silently invalidate the conservation invariants.
 */
export function arrange(table: Table, spec: ArrangeSpec): void {
  const state = table.state;
  const total = state.rules.jokers ? DECK_SIZE + 2 : DECK_SIZE;

  const placed = new Map<number, string>();
  const place = (id: number, where: string): void => {
    if (id < 0 || id >= total) throw new Error(`arrange: card ${id} is not in play (${where})`);
    const prev = placed.get(id);
    if (prev !== undefined) throw new Error(`arrange: card ${id} placed twice (${prev} and ${where})`);
    placed.set(id, where);
  };

  for (const hand of Object.values(spec.hands ?? {})) {
    for (const id of hand ?? []) if (id !== null) place(id, 'hand');
  }
  for (const id of spec.deck ?? []) place(id, 'deck');
  for (const id of spec.discard ?? []) place(id, 'discard');
  if (spec.setAside !== undefined && spec.setAside !== null) place(spec.setAside, 'setAside');

  // Untouched zones keep what the spec did not take from them.
  const kept = new Set<number>();
  const keep = (id: number | null): void => {
    if (id !== null && !placed.has(id)) kept.add(id);
  };
  for (const p of state.players) {
    if (spec.hands && p.id in spec.hands) continue;
    for (const id of p.hand) keep(id);
  }
  if (spec.discard === undefined) for (const id of state.discard) keep(id);
  if (spec.setAside === undefined) keep(state.setAside);

  const leftover: number[] = [];
  for (let id = 0; id < total; id++) if (!placed.has(id) && !kept.has(id)) leftover.push(id);
  if (placed.size + kept.size + leftover.length !== total) {
    throw new Error('arrange: card accounting is wrong');
  }

  for (const p of state.players) {
    const hand = spec.hands?.[p.id];
    if (hand) {
      p.hand = hand.slice();
      p.gen = p.hand.map((_, i) => (p.gen[i] ?? 0) + 1);
      p.peeked = p.hand.map(() => false);
    } else {
      // Give up any card the spec placed elsewhere.
      p.hand = p.hand.map((id) => (id !== null && placed.has(id) ? null : id));
    }
  }

  state.deck = [...(spec.deck ?? []), ...leftover];
  if (spec.discard !== undefined) {
    state.discard = spec.discard.slice();
    state.discardSeq += 1;
  } else {
    state.discard = state.discard.filter((id) => !placed.has(id));
  }
  if (spec.setAside !== undefined) {
    state.setAside = spec.setAside;
  } else if (state.setAside !== null && placed.has(state.setAside)) {
    state.setAside = null;
  }
}

/**
 * Arrange a table whose draw pile holds EXACTLY `spec.deck`, by parking every
 * other unplaced card on the bottom of the discard pile.
 *
 * A 52-card deck cannot simply be shrunk — every card has to be somewhere. The
 * discard pile is the one zone that can legitimately hold dozens of cards, so it
 * absorbs the overflow. `spec.hands` must list every player.
 */
export function arrangeShortDeck(
  table: Table,
  spec: { hands: Record<PlayerId, (number | null)[]>; deck: number[]; discardTop?: number[] },
): void {
  const total = table.state.rules.jokers ? DECK_SIZE + 2 : DECK_SIZE;
  for (const p of table.state.players) {
    if (!(p.id in spec.hands)) {
      throw new Error(`arrangeShortDeck: hands must include every player (missing ${p.id})`);
    }
  }

  const used = new Set<number>();
  for (const hand of Object.values(spec.hands)) for (const id of hand) if (id !== null) used.add(id);
  for (const id of spec.deck) used.add(id);
  for (const id of spec.discardTop ?? []) used.add(id);

  const overflow: number[] = [];
  for (let id = 0; id < total; id++) if (!used.has(id)) overflow.push(id);

  arrange(table, {
    hands: spec.hands,
    deck: spec.deck,
    discard: [...overflow, ...(spec.discardTop ?? [])],
  });
}

/** Both players peek their bottom two and declare ready. */
export function finishPeek(table: Table): void {
  for (const id of table.ids) {
    if (table.state.phase !== 'peek') break;
    table.ok({ type: 'PEEK', playerId: id, slot: 2 });
    table.ok({ type: 'PEEK', playerId: id, slot: 3 });
    table.ok({ type: 'READY', playerId: id });
  }
}

/** Every card id currently in play, for conservation checks. */
export function idsInPlay(state: GameState): number[] {
  const out: number[] = [...state.deck, ...state.discard];
  for (const p of state.players) {
    for (const id of p.hand) if (id !== null) out.push(id);
  }
  if (state.setAside !== null) out.push(state.setAside);
  if (state.heldCardId !== null) out.push(state.heldCardId);
  if (state.drawn) out.push(state.drawn.cardId);
  return out;
}

/** The hand of a player, as raw card ids. */
export function handOf(table: Table, id: PlayerId): (number | null)[] {
  const p = table.state.players.find((x) => x.id === id);
  if (!p) throw new Error(`no player ${id}`);
  return p.hand;
}

export function seatTurnId(table: Table): PlayerId {
  return table.state.players[table.state.turnSeat]!.id;
}

export { tick };

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { tick } from '../src/engine/reduce';
import type { Ctx } from '../src/engine/types';
import { createTable, seededRng } from './helpers';
import { MAX_STEPS, randomAction } from './fuzz';
import { accountingErrors, cardsInPlay, leakedCardIds } from './invariants';

/**
 * ============================================================================
 *  PROPERTY TESTS
 * ============================================================================
 *  Random games, driven by a seeded RNG, asserted against the three invariants
 *  the brief names: card conservation, no hidden-card leakage, and termination.
 *
 *  The only input is a seed, and the generator's own seed is PINNED, so a red
 *  build is reproducible and a reported counterexample replays exactly. The seed
 *  in a failure message is all you need: paste it into the regression block below.
 * ============================================================================
 */

/** Pinned generator seed: same cases, same order, every run. */
const FC_SEED = 20261015;

/**
 * Play one round at random, checking every invariant after every single action.
 * Returns the phase the round finished in.
 *
 * `decks` is a dimension here on purpose. Two decks is not "the same game with a
 * bigger pile": every rank exists twice, so a tap has twice as many legal
 * answers, and any assumption anywhere that a rank or a face is unique on the
 * table would only show up in a 104-card game. This is where that assumption
 * gets found rather than in production.
 */
function fuzzRound(seed: number, players: number, jokers: boolean, decks: 1 | 2 = 1): string {
  const rng = seededRng(seed);
  const t = createTable({ players, seed: seed ^ 0x5f3759df, rules: { jokers, decks } });
  const where = `seed ${seed}, ${players} players, jokers=${jokers}, decks=${decks}`;

  const check = (step: number, context: string): void => {
    expect(accountingErrors(t.state), `${where} (step ${step}): card accounting after ${context}`).toEqual([]);
    for (const p of t.state.players) {
      expect(
        leakedCardIds(t.state, p.id),
        `${where} (step ${step}): ${p.id} can see hidden cards after ${context}`,
      ).toEqual([]);
    }
  };

  check(0, 'the deal');
  let steps = 0;
  const seen = new Set<string>();
  while (t.state.phase !== 'reveal' && t.state.phase !== 'gameOver' && steps < MAX_STEPS) {
    // Occasionally let time pass, so the lazy deadline paths get exercised.
    if (rng() < 0.08) t.advance(Math.floor(rng() * 90_000));

    const action = randomAction(rng, t);
    const context = action ? JSON.stringify(action) : 'a clock tick';
    if (action) t.send(action);
    else t.advance(5_000); // nothing legal to try: just move the clock

    steps += 1;
    seen.add(t.state.phase);
    if (t.state.kabooCallerId) seen.add('kabooLive');
    if (t.state.tap) seen.add('tapLive');
    if (t.state.effect) seen.add('effectLive');
    if (t.state.heldCardId !== null) seen.add('deckOut');
    if (t.state.setAside !== null) seen.add('setAside');
    check(steps, context);
  }
  if (process.env.FUZZ_REPORT) {
    console.log(`  ${where}: ${steps} steps, ended in ${t.state.phase}, saw ${[...seen].sort().join(',')}`);
  }

  expect(
    ['reveal', 'gameOver'],
    `${where}: the round did not terminate within ${MAX_STEPS} actions`,
  ).toContain(t.state.phase);
  return t.state.phase;
}

describe('property: a round always terminates', () => {
  it('in random play, at every table size, with and without jokers, on one deck or two', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 2 ** 31 - 1 }),
        fc.integer({ min: 2, max: 4 }),
        fc.boolean(),
        fc.constantFrom<1 | 2>(1, 2),
        (seed, players, jokers, decks) => {
          fuzzRound(seed, players, jokers, decks);
        },
      ),
      { numRuns: 200, seed: FC_SEED },
    );
  });

  it('when nobody acts at all, from the lazy deadline resolution alone', () => {
    // The read path is the only thing keeping a serverless room alive: there are
    // no durable timers, so a table where every player is gone must still finish.
    for (const players of [2, 3, 8]) {
      const t = createTable({ players });
      let guard = 0;
      while (t.state.phase !== 'reveal' && t.state.phase !== 'gameOver' && guard < 5000) {
        t.advance(120_000); // far past every deadline
        const ctx: Ctx = { now: t.now(), rng: () => 0.5 };
        const result = tick(t.state, ctx);
        if (result) t.state = result.state;
        guard += 1;
      }
      expect(t.state.phase, `${players} silent players never finished the round`).toBe('reveal');
      expect(accountingErrors(t.state)).toEqual([]);
    }
  });
});

describe('property: every card id is accounted for exactly once', () => {
  it('holds after dealing, for any seed, table size, and deck count', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 2 ** 31 - 1 }),
        fc.integer({ min: 2, max: 8 }),
        fc.boolean(),
        fc.constantFrom<1 | 2>(1, 2),
        (seed, players, jokers, decks) => {
          const t = createTable({ players, seed, rules: { jokers, decks } });
          const total = cardsInPlay(t.state.rules);

          expect(accountingErrors(t.state), `seed ${seed}, ${players} players, decks=${decks}`).toEqual([]);
          // And the deal is what it claims to be.
          for (const p of t.state.players) {
            expect(p.hand).toHaveLength(t.rules.handSize);
            expect(p.hand.every((id) => id !== null)).toBe(true);
          }
          expect(t.state.deck).toHaveLength(total - players * t.rules.handSize);
        },
      ),
      { numRuns: 200, seed: FC_SEED },
    );
  });

  it('holds while every player looks at their two cards', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 2 ** 31 - 1 }), fc.integer({ min: 2, max: 6 }), (seed, players) => {
        const t = createTable({ players, seed });
        for (const id of t.ids) {
          t.send({ type: 'PEEK', playerId: id, slot: 2 });
          expect(accountingErrors(t.state)).toEqual([]);
          t.send({ type: 'READY', playerId: id });
          expect(accountingErrors(t.state)).toEqual([]);
        }
        expect(t.state.phase).toBe('turnStart');
        expect(accountingErrors(t.state)).toEqual([]);
      }),
      { numRuns: 150, seed: FC_SEED },
    );
  });
});

/**
 * Seeds that once failed, kept as permanent regression cases.
 *
 * A failing run prints the seed it used; pasting that seed here pins the bug
 * forever. These replay through the same per-step checks as the fuzz, so they
 * cost a fraction of a second and need no new assertions written by hand.
 */
describe('regression: seeds that once broke an invariant', () => {
  it('keeps every card when a wrong-tap penalty ends the round mid-draw', () => {
    // Step 118: a wrong tap drew the LAST card of the pile as its penalty, which
    // ends the round while the turn player still held the card they had drawn.
    // Clearing the field outright deleted that card from the game.
    expect(() => fuzzRound(1050406591, 2, false)).not.toThrow();
  });
});

describe('property: no projection leaks a hidden card', () => {
  it('holds at every point of a round, for every viewer', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 2 ** 31 - 1 }), fc.integer({ min: 2, max: 4 }), (seed, players) => {
        fuzzRound(seed, players, false); // checks leakage on every single step
      }),
      { numRuns: 150, seed: FC_SEED },
    );
  });

  it('holds for the first turn of a fresh round, for every seat', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 2 ** 31 - 1 }),
        fc.integer({ min: 2, max: 8 }),
        fc.integer({ min: 0, max: 3 }),
        (seed, players, slot) => {
          const t = createTable({ players, seed });
          for (const id of t.ids) {
            t.send({ type: 'PEEK', playerId: id, slot: 2 });
            t.send({ type: 'PEEK', playerId: id, slot: 3 });
            t.send({ type: 'READY', playerId: id });
          }
          const turnId = t.state.players[t.state.turnSeat]!.id;
          t.send({ type: 'DRAW', playerId: turnId, from: 'deck' });
          if (slot % 2 === 0) t.send({ type: 'DISCARD', playerId: turnId });
          else t.send({ type: 'SWAP', playerId: turnId, slot });

          for (const p of t.state.players) {
            expect(leakedCardIds(t.state, p.id), `seed ${seed}, ${players} players`).toEqual([]);
          }
        },
      ),
      { numRuns: 200, seed: FC_SEED },
    );
  });
});

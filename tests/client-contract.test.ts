import { describe, expect, it } from 'vitest';
import { tick } from '../src/engine/reduce';
import { chooseMove } from './decide';
import { createTable, finishPeek } from './helpers';
import type { Table } from './helpers';

/**
 * ============================================================================
 *  THE CLIENT CONTRACT — M2
 * ============================================================================
 *  These tests play complete games using NOTHING but `project()` output. No test
 *  here reads `t.state` to make a decision: every choice comes from a projection
 *  field, exactly as the UI must.
 *
 *  That is what makes them worth having. A projection could be perfectly safe
 *  (it leaks nothing) and still be useless, because it omits something a client
 *  needs in order to act — the missing piece is invisible until a human clicks.
 *  This file is where that shows up as a red test instead of a dead button.
 *
 *  Rule of thumb for anything added to the client: if the UI can do it, a case
 *  belongs here. If a case here cannot be written, the projection is incomplete.
 * ============================================================================
 */

/** Drive the table until it stalls, every player acting purely off their projection. */
function playOut(t: Table, maxSteps = 4000): { steps: number; stuck: string[] } {
  let steps = 0;
  let idle = 0;

  while (steps < maxSteps) {
    if (t.state.phase === 'gameOver') break;

    // Try every seat in order; the first one with a legal move acts.
    const moved = t.ids.some((id) => {
      const move = chooseMove(t.view(id), id);
      if (!move) return false;
      const result = t.send(move);
      // A refusal is fine — a stale tap loses the race by design — but it must
      // never be a refusal of something the projection advertised as legal.
      if (result.error && !['E_TOO_LATE', 'E_STALE'].includes(result.error.code)) {
        throw new Error(
          `projection advertised ${move.type} for ${id} but the engine refused: ${result.error.code}`,
        );
      }
      return result.versionChanged;
    });

    if (!moved) {
      // Nobody could act. Let the clock run, which is how deadlines resolve.
      idle += 1;
      t.advance(120_000);
      const result = tick(t.state, { now: t.now(), rng: () => 0.5 });
      if (result?.versionChanged) t.state = result.state;
      else if (idle > 4) return { steps, stuck: [t.state.phase] };
    } else {
      idle = 0;
    }
    steps += 1;
  }

  return { steps, stuck: [] };
}

describe('a client can play a whole game from the projection alone', () => {
  it('reaches the reveal in a 2-player game', () => {
    const t = createTable({ players: 2, seed: 20261016 });
    const { steps, stuck } = playOut(t);
    expect(stuck, 'the table stalled with nobody able to act').toEqual([]);
    // It got somewhere: either the round ended or the whole game did.
    expect(['reveal', 'gameOver']).toContain(t.state.phase);
    // And it got there by playing, not by exhausting the step budget.
    expect(steps).toBeLessThan(1000);
    expect(t.state.discard.length, 'a round of Kaboo must have produced a discard pile').toBeGreaterThan(0);
    expect(t.state.log.some((e) => e.kind === 'roundEnd'), 'the round must have been scored').toBe(true);
  });

  it('reaches the reveal at every table size the brief allows', () => {
    for (const players of [2, 3, 4, 5, 6, 7, 8]) {
      const t = createTable({ players, seed: 4000 + players });
      const { steps, stuck } = playOut(t);
      expect(stuck, `${players} players stalled`).toEqual([]);
      expect(['reveal', 'gameOver'], `${players} players`).toContain(t.state.phase);
      expect(steps, `${players} players ground to the step limit`).toBeLessThan(1000);
    }
  });

  it('lets a player tap the pile without being the turn player', () => {
    // The race is the point of the game, and it is only expressible if the
    // projection ships `canTap` and `discardSeq` to everyone, not just the actor.
    const t = createTable({ players: 3, seed: 99 });
    finishPeek(t);
    let sawOffTurnTap = false;

    for (let i = 0; i < 600 && t.state.phase !== 'reveal'; i += 1) {
      const turnId = t.state.players[t.state.turnSeat]?.id;
      for (const id of t.ids) {
        const view = t.view(id);
        if (id === turnId || !view.canTap || view.tap) continue;
        const move = chooseMove(view, id);
        if (move?.type === 'TAP') {
          sawOffTurnTap = true;
          const result = t.send(move);
          expect(result.error?.code ?? null).toBeNull();
          break;
        }
      }
      if (sawOffTurnTap) break;
      const turnView = turnId ? t.view(turnId) : null;
      const move = turnView && turnId ? chooseMove(turnView, turnId) : null;
      if (move) t.send(move);
      else t.advance(120_000);
    }

    expect(sawOffTurnTap, 'no off-turn tap was ever available across 600 steps').toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { createMemoryStore } from '../src/store/memory';
import type { RoomRecord } from '../src/store/types';

/**
 * The store's one job is compare-and-set, and the whole tap race depends on it
 * being right. These tests pin the semantics `room.ts` relies on, using the
 * in-memory adapter so they need no network.
 */

function record(rev: number, overrides: Partial<RoomRecord> = {}): RoomRecord {
  return {
    code: 'TEST',
    status: 'lobby',
    roster: [],
    hostId: 'p1',
    state: null,
    rev,
    pending: {},
    eventSeq: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('StateStore compare-and-set', () => {
  it('creates a code once and refuses it afterwards', async () => {
    const store = createMemoryStore();
    expect(await store.create('TEST', record(1))).toBe(true);
    expect(await store.create('TEST', record(1))).toBe(false);
  });

  it('reads back what was written', async () => {
    const store = createMemoryStore();
    await store.create('TEST', record(1));
    const read = await store.read('TEST');
    expect(read?.rev).toBe(1);
    expect(await store.read('NOPE')).toBeNull();
  });

  it('refuses a write built on a stale revision, and leaves the room untouched', async () => {
    const store = createMemoryStore();
    await store.create('TEST', record(1));

    // Someone else advanced the room first.
    const won = await store.commit('TEST', 1, record(2, { eventSeq: 99 }));
    expect(won?.eventSeq).toBe(99);

    // Our write was built against rev 1, so it must not land — not even partly.
    const lost = await store.commit('TEST', 1, record(2, { eventSeq: 1 }));
    expect(lost).toBeNull();
    expect((await store.read('TEST'))?.eventSeq).toBe(99);
  });

  it('lets exactly one of two writers starting from the same revision win', async () => {
    const store = createMemoryStore();
    await store.create('TEST', record(1));

    // Both read rev 1 before either writes — the simultaneous double-tap.
    const [a, b] = await Promise.all([
      store.commit('TEST', 1, record(2, { eventSeq: 1 })),
      store.commit('TEST', 1, record(2, { eventSeq: 2 })),
    ]);

    const winners = [a, b].filter((r) => r !== null);
    expect(winners, 'exactly one commit must land').toHaveLength(1);
    expect(await store.read('TEST')).toEqual(winners[0]);
  });

  it('refuses to commit to a room that does not exist', async () => {
    const store = createMemoryStore();
    expect(await store.commit('TEST', 1, record(2))).toBeNull();
  });

  it('does not hand out a live reference to its own record', async () => {
    // If it did, a caller could edit a hand without committing, and every other
    // player would see the change with no version bump.
    const store = createMemoryStore();
    await store.create('TEST', record(1, { status: 'lobby' }));

    const first = await store.read('TEST');
    expect(first).not.toBeNull();
    first!.status = 'playing';
    first!.hostId = 'p9';
    first!.roster.push({ id: 'p9', name: 'intruder', joinedAt: 0 });

    const second = await store.read('TEST');
    expect(second?.status).toBe('lobby');
    expect(second?.hostId).toBe('p1');
    expect(second?.roster).toEqual([]);
  });
});

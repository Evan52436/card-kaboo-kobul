import { describe, expect, it } from 'vitest';
import { POST as createRoom } from '../src/app/api/rooms/route';
import { POST as joinRoom } from '../src/app/api/rooms/[code]/join/route';
import { POST as startRoom } from '../src/app/api/rooms/[code]/start/route';
import { POST as act } from '../src/app/api/rooms/[code]/actions/route';
import { GET as readState } from '../src/app/api/rooms/[code]/state/route';
import { POST as realtimeToken } from '../src/app/api/rooms/[code]/token/route';
import { POST as leaveRoom } from '../src/app/api/rooms/[code]/leave/route';
import { ROOM_ERROR_MESSAGES, type RoomErrorCode } from '../src/protocol';
import { SESSION_HEADER } from '../src/server/http';
import { getStore } from '../src/store';
import { hiddenCardIds, visibleCardIds } from './invariants';

/**
 * ============================================================================
 *  THE HTTP EDGE — the handlers, called as functions
 * ============================================================================
 *  A Next route handler is just `(Request) => Promise<Response>`, so there is no
 *  reason to stand up a server to test one. Importing the six handlers directly
 *  puts the session header, the status mapping and the response bodies under
 *  `npm test`, instead of under a curl someone once ran by hand.
 *
 *  Two things exist only at this layer, and would otherwise go untested:
 *
 *  * **`x-kaboo-session` is the identity.** The engine never sees the wire, so
 *    this is the one place the header is read and the body's `playerId` is
 *    discarded. A mistake here is a player who can act as another player.
 *  * **Every failure leaves as a generic sentence.** A status code is fine to
 *    expose; a reason is not, because "you cannot do that while a tap is open"
 *    tells you where a card is.
 * ============================================================================
 */

function req(method: string, body?: unknown, token?: string): Request {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (token !== undefined) headers.set(SESSION_HEADER, token);
  return new Request('http://kaboo.test/api', {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Next hands a route handler its dynamic segment as a promise. */
const at = (code: string) => ({ params: Promise.resolve({ code }) });

interface Session {
  code: string;
  token: string;
  playerId: string;
}

async function body<T = Record<string, unknown>>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function created(name: string): Promise<Session> {
  const response = await createRoom(req('POST', { name }));
  expect(response.status).toBe(200);
  return body<Session>(response);
}

/** A room with one seat per name taken. Not yet dealt. */
async function lobby(names: string[]): Promise<{ code: string; seats: Session[] }> {
  const first = await created(names[0]!);
  const seats: Session[] = [first];
  for (const name of names.slice(1)) {
    const response = await joinRoom(req('POST', { name }), at(first.code));
    expect(response.status).toBe(200);
    seats.push(await body<Session>(response));
  }
  return { code: first.code, seats };
}

async function playing(names: string[]): Promise<{ code: string; seats: Session[] }> {
  const room = await lobby(names);
  const response = await startRoom(req('POST', undefined, room.seats[0]!.token), at(room.code));
  expect(response.status).toBe(200);
  return room;
}

describe('creating and joining', () => {
  it('mints a room, a seat and a session', async () => {
    const session = await created('Ana');
    expect(session.code).toHaveLength(4);
    // The alphabet omits both halves of every confusable pair, so it is safe to
    // read down a phone line.
    expect(session.code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/);
    expect(session.playerId).toBe('p1');
    expect(session.token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it('seats players in join order and refuses a ninth', async () => {
    const { code, seats } = await lobby(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8']);
    expect(seats.map((s) => s.playerId)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8']);

    const ninth = await joinRoom(req('POST', { name: 'p9' }), at(code));
    expect(ninth.status).toBe(409);
    expect(await body(ninth)).toMatchObject({ ok: false, code: 'E_ROOM_FULL' });
  });

  /**
   * The lobby has to label somebody else's row as the host, and the client must
   * not work it out from the order of the roster: that happens to be right today
   * and would go quietly wrong the first time the ordering changed.
   */
  it('says who the host is, and it follows the seat when the host leaves', async () => {
    const { code, seats } = await lobby(['Ana', 'Bo', 'Cal']);

    const asBo = await readState(req('GET', undefined, seats[1]!.token), at(code));
    const first = await body<{ room: { host: boolean; hostId: string; roster: { id: string }[] } }>(asBo);
    expect(first.room.host).toBe(false);
    expect(first.room.hostId).toBe('p1');

    const left = await leaveRoom(req('POST', undefined, seats[0]!.token), at(code));
    expect(left.status).toBe(200);

    const after = await body<{ room: { host: boolean; hostId: string } }>(
      await readState(req('GET', undefined, seats[1]!.token), at(code)),
    );
    // Bo inherited the room, and is now told so rather than having to infer it.
    expect(after.room.host).toBe(true);
    expect(after.room.hostId).toBe('p2');
  });

  it('accepts a code the way a human typed it', async () => {
    const { code, seats } = await lobby(['Ana', 'Bo']);
    // Lowercase, with the hyphen someone wrote on a napkin, and stray spaces.
    const messy = ` ${code.toLowerCase().slice(0, 2)}-${code.toLowerCase().slice(2)} `;
    const response = await readState(req('GET', undefined, seats[0]!.token), at(messy));
    expect(response.status).toBe(200);
  });

  it('refuses a name that is empty, missing or not a string', async () => {
    for (const bad of [{ name: '   ' }, {}, { name: 42 }, { name: null }]) {
      const response = await createRoom(req('POST', bad));
      expect(response.status, JSON.stringify(bad)).toBe(400);
      expect(await body(response)).toMatchObject({ code: 'E_BAD_REQUEST' });
    }
  });

  it('treats an unparseable body as an empty one, not a crash', async () => {
    const request = new Request('http://kaboo.test/api', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    const response = await createRoom(request);
    expect(response.status).toBe(400);
    expect(await body(response)).toMatchObject({ code: 'E_BAD_REQUEST' });
  });
});

describe('the session header is the identity', () => {
  it('refuses a request with no session at all', async () => {
    const { code } = await lobby(['Ana', 'Bo']);
    const response = await readState(req('GET'), at(code));
    expect(response.status).toBe(401);
    expect(await body(response)).toMatchObject({ code: 'E_BAD_SESSION' });
  });

  it('refuses a session minted for another room', async () => {
    const a = await lobby(['Ana', 'Bo']);
    const b = await lobby(['Cy', 'Di']);
    const response = await readState(req('GET', undefined, a.seats[0]!.token), at(b.code));
    expect(response.status).toBe(401);
  });

  it('ignores a playerId forged into the action body', async () => {
    const { code, seats } = await playing(['Ana', 'Bo']);
    const [ana, bo] = seats;

    // Finish the peek, so there is a real turn to steal.
    for (const seat of seats) {
      for (const slot of [2, 3]) {
        await act(req('POST', { action: { type: 'PEEK', slot } }, seat.token), at(code));
      }
      await act(req('POST', { action: { type: 'READY' } }, seat.token), at(code));
    }

    const opening = await body<{ room: { view: { turnPlayerId: string } } }>(
      await readState(req('GET', undefined, ana!.token), at(code)),
    );
    expect(opening.room.view.turnPlayerId).toBe('p2');

    // Ana claims to be Bo, who is on turn. The header must win.
    const forged = await act(
      req('POST', { action: { type: 'DRAW', playerId: bo!.playerId, from: 'deck' } }, ana!.token),
      at(code),
    );
    expect(forged.status).toBe(200);

    const result = await body<{
      room: { you: string; view: { phase: string; drawn: unknown } };
      refusal?: { code: string };
    }>(forged);
    expect(result.room.you).toBe('p1');
    expect(result.refusal?.code).toBe('E_NOT_YOUR_TURN');
    expect(result.room.view.drawn, 'a forged action moved the game').toBeNull();
    expect(result.room.view.phase).toBe('turnStart');

    // The real owner of the turn can still move — sending a body that lies in
    // the opposite direction, which the header must override just the same.
    const real = await act(
      req('POST', { action: { type: 'DRAW', playerId: 'p1', from: 'deck' } }, bo!.token),
      at(code),
    );
    const drawn = await body<{ refusal?: unknown; room: { view: { drawn: { by: string } } } }>(real);
    expect(drawn.refusal).toBeUndefined();
    expect(drawn.room.view.drawn.by).toBe('p2');
  });

  it('refuses the deal from anyone but the host', async () => {
    const { code, seats } = await lobby(['Ana', 'Bo']);
    const response = await startRoom(req('POST', undefined, seats[1]!.token), at(code));
    expect(response.status).toBe(401);
    expect(await body(response)).toMatchObject({ code: 'E_BAD_SESSION' });
  });

  it('refuses to deal to a table of one', async () => {
    const solo = await created('Alone');
    const response = await startRoom(req('POST', undefined, solo.token), at(solo.code));
    expect(response.status).toBe(400);
  });

  it('refuses a second deal', async () => {
    const { code, seats } = await playing(['Ana', 'Bo']);
    const again = await startRoom(req('POST', undefined, seats[0]!.token), at(code));
    expect(again.status).toBe(409);
    expect(await body(again)).toMatchObject({ code: 'E_ALREADY_STARTED' });
  });
});

describe('a rejection never explains itself', () => {
  it('sends the canned sentence for every failure', async () => {
    const { code, seats } = await lobby(['Ana', 'Bo']);
    const full = await lobby(['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8']);
    const started = await playing(['s1', 's2']);

    // One real refusal per code, from six different branches, so this covers
    // what the client actually receives rather than a table read off the source.
    // `E_BUSY` is absent on purpose: it needs eight losing compare-and-sets in a
    // row, so it is exercised in `store.test.ts` rather than faked here.
    const failures: [Response, RoomErrorCode, number][] = [
      [await readState(req('GET'), at(code)), 'E_BAD_SESSION', 401],
      [await readState(req('GET', undefined, seats[0]!.token), at('ZZZZ')), 'E_BAD_SESSION', 401],
      [await startRoom(req('POST', undefined, seats[1]!.token), at(code)), 'E_BAD_SESSION', 401],
      [await joinRoom(req('POST', { name: 'x' }, seats[0]!.token), at('ZZZZ')), 'E_NOT_FOUND', 404],
      [await joinRoom(req('POST', { name: 'x' }), at(full.code)), 'E_ROOM_FULL', 409],
      [await joinRoom(req('POST', { name: 'x' }), at(started.code)), 'E_ALREADY_STARTED', 409],
      [await act(req('POST', { action: { type: 'DRAW' } }, seats[0]!.token), at(code)), 'E_BAD_REQUEST', 400],
    ];

    for (const [response, expected, status] of failures) {
      const payload = await body<{ ok: boolean; code: RoomErrorCode; message: string }>(response);
      expect(payload.code).toBe(expected);
      expect(response.status, expected).toBe(status);
      expect(response.ok).toBe(false);
      // Byte-for-byte the canned sentence: nothing was appended to say why.
      expect(payload.message).toBe(ROOM_ERROR_MESSAGES[expected]);
    }
  });

  it('answers a refusal during play with the fresh view, as a success', async () => {
    // The loser of a tap race needs the state that beat them, so a refused move
    // is an answer rather than an error status.
    const { code, seats } = await playing(['Ana', 'Bo']);
    const response = await act(
      req('POST', { action: { type: 'DRAW', playerId: 'p1', from: 'deck' } }, seats[0]!.token),
      at(code),
    );
    expect(response.status).toBe(200);
    const payload = await body<{ room: unknown; refusal?: unknown }>(response);
    expect(payload.refusal).toBeDefined();
    expect(payload.room).toBeDefined();
  });

  it('rejects an action that is not an action', async () => {
    const { code, seats } = await playing(['Ana', 'Bo']);
    for (const bad of [{ action: 'DRAW' }, { action: 7 }, { action: null }, {}, { action: {} }]) {
      const response = await act(req('POST', bad, seats[0]!.token), at(code));
      expect(response.status, JSON.stringify(bad)).toBe(400);
      expect(await body(response)).toMatchObject({ code: 'E_BAD_REQUEST' });
    }
  });
});

describe("no response body ever carries another player's card", () => {
  it('keeps every seat blind through a deal and a peek', async () => {
    const { code, seats } = await playing(['Ana', 'Bo', 'Cy']);

    const peeked = await body<{ events: { to: string; card?: unknown }[] }>(
      await act(req('POST', { action: { type: 'PEEK', slot: 2 } }, seats[0]!.token), at(code)),
    );
    expect(peeked.events).toHaveLength(1);
    expect(peeked.events[0]!.to).toBe('p1');
    expect(peeked.events[0]!.card, 'the peek must actually reveal something').toBeDefined();

    // Walk every seat's entire payload against what that seat may not see.
    const store = getStore();
    let hiddenSeen = 0;
    for (const seat of seats) {
      const current = await store.read(code);
      const hidden = hiddenCardIds(current!.state!, seat.playerId);
      hiddenSeen += hidden.size;

      const payload = await body<{ room: unknown; events: { to: string }[] }>(
        await readState(req('GET', undefined, seat.token), at(code)),
      );
      const leaked = [...visibleCardIds(payload.room)].filter((id) => hidden.has(id));
      expect(leaked, `${seat.playerId} was sent cards ${leaked.join(', ')}`).toEqual([]);
      for (const event of payload.events) expect(event.to).toBe(seat.playerId);
    }

    // Guard the guard: "nothing leaked" means nothing if nothing was hidden.
    expect(hiddenSeen, 'no seat had anything hidden to leak').toBeGreaterThan(0);
  });
});

describe('reading state', () => {
  it('treats an unusable cursor as the beginning, never as "you missed it"', async () => {
    const { code, seats } = await playing(['Ana', 'Bo']);
    const token = seats[0]!.token;
    await act(req('POST', { action: { type: 'PEEK', slot: 2 } }, token), at(code));

    // A cursor is the client's own bookkeeping, so a garbled one must be read as
    // "from the start". Reading it as "up to date" would silently swallow a peek
    // the rules granted and the server cannot re-derive.
    for (const query of ['', '?since=', '?since=abc', '?since=-5', '?since=1e999', '?since=0']) {
      const response = await readState(
        new Request(`http://kaboo.test/api${query}`, { headers: { [SESSION_HEADER]: token } }),
        at(code),
      );
      expect(response.status, query).toBe(200);
      const payload = await body<{ events: unknown[] }>(response);
      expect(payload.events, `cursor "${query}" lost the peek`).toHaveLength(1);
    }
  });

  it('hands out no push credential when there is no push service', async () => {
    // Running without Ably is supported — the client polls instead. A 200 with a
    // null token says "no channel", which is an answer; a 4xx would blame the
    // caller for a choice the server made.
    const { code, seats } = await playing(['Ana', 'Bo']);
    const response = await realtimeToken(req('POST', undefined, seats[0]!.token), at(code));
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({ token: null });
  });

  it('refuses a push credential without a session', async () => {
    const { code } = await playing(['Ana', 'Bo']);
    const response = await realtimeToken(req('POST'), at(code));
    expect(response.status).toBe(401);
  });
});

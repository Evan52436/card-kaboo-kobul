/**
 * The wire contract, over real HTTP, against a running server.
 *
 * `bun run test` drives the route handlers as functions, which is fast and
 * catches almost everything — but it never exercises Next's own routing, header
 * handling or JSON serialisation. This does, in about a second, and it is the
 * check to run after any change to `src/protocol.ts`, `src/server/`, or the
 * route handlers.
 *
 *     bun run dev            # in one terminal
 *     bun run smoke          # in another
 *
 * Point it somewhere else with KABOO_BASE (the default is Next's dev port).
 */

const BASE = (process.env.KABOO_BASE ?? 'http://localhost:3000') + '/api/rooms';
const PAGE = process.env.KABOO_BASE ?? 'http://localhost:3000';

const headers = (token) => ({
  'content-type': 'application/json',
  ...(token ? { 'x-kaboo-session': token } : {}),
});

async function call(path, { method = 'GET', body, token } = {}) {
  const response = await fetch(BASE + path, {
    method,
    headers: headers(token),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

let failed = 0;
const ok = (cond, label) => {
  if (!cond) failed += 1;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
};
const view = (state) => state.json.room?.view;

try {
  // --- the landing page -----------------------------------------------------
  const html = await (await fetch(PAGE)).text();
  ok(html.includes('One moment'), 'the server renders the neutral gate, not a form it cannot fill');
  ok(!html.includes('Start a game'), 'and never the join form, which needs localStorage to decide');

  // --- create and join -----------------------------------------------------
  const created = await call('', { method: 'POST', body: { name: 'Ana' } });
  const { code, token: ana } = created.json;
  ok(created.status === 200 && !!ana, `create -> ${created.status} ${code}`);

  const lobby = await call(`/${code}/state`, { token: ana });
  ok(
    lobby.json.room.status === 'lobby' && lobby.json.room.you === 'p1' && lobby.json.room.host,
    'the creator is seat p1 and the host',
  );
  ok(lobby.json.room.hostId === 'p1', 'the lobby names the host instead of leaving it to be inferred');

  // Typed the way a human types it: lowercase, with padding.
  const joined = await call(`/${code.toLowerCase().trim()}/join`, { method: 'POST', body: { name: 'Ben' } });
  const ben = joined.json.token;
  ok(joined.json.playerId === 'p2', `a lowercase code joins the same room -> ${joined.json.playerId}`);

  const seen = await call(`/${code}/state`, { token: ana });
  ok(seen.json.room.roster.length === 2, 'the roster reaches the host with no refresh');

  // --- deal -----------------------------------------------------------------
  const dealt = await call(`/${code}/start`, { method: 'POST', token: ana });
  ok(view(dealt).phase === 'peek', 'the deal lands in peek');
  ok(JSON.stringify(view(dealt).peekableSlots) === '[2,3]', `peekable slots ${JSON.stringify(view(dealt).peekableSlots)}`);

  // --- the hidden-information boundary -------------------------------------
  const peekA = await call(`/${code}/actions`, {
    method: 'POST',
    token: ana,
    body: { action: { type: 'PEEK', playerId: 'p1', slot: 3 } },
  });
  ok(peekA.json.events.length === 1 && peekA.json.events[0].to === 'p1', 'the peek is addressed to the seat that asked');
  ok(typeof peekA.json.events[0].seq === 'number', `the event carries a seq (${peekA.json.events[0].seq})`);
  const cardA = JSON.stringify(peekA.json.events[0].card);

  // A forged playerId in the body, over real HTTP.
  const peekB = await call(`/${code}/actions`, {
    method: 'POST',
    token: ben,
    body: { action: { type: 'PEEK', playerId: 'p1', slot: 3 } },
  });
  ok(peekB.json.events[0].to === 'p2', "Ben's forged playerId is discarded: the event goes to the session, not the body");

  const stateB = await call(`/${code}/state?since=0`, { token: ben });
  ok(!JSON.stringify(stateB.json).includes(cardA), "nothing in p2's payload is p1's card");
  ok(
    view(stateB)
      .players.find((p) => p.id === 'p1')
      .hand.every((s) => s.card === undefined),
    "p1's hand is faceless to p2",
  );
  ok(stateB.json.events.length === 1 && stateB.json.events[0].to === 'p2', 'p2 receives exactly his own one event');

  // --- the cursor -----------------------------------------------------------
  const caught = await call(`/${code}/state?since=${stateB.json.eventSeq}`, { token: ben });
  ok(caught.json.events.length === 0, 'a caught-up cursor gets nothing');

  // --- ready, and into the turn --------------------------------------------
  await call(`/${code}/actions`, { method: 'POST', token: ana, body: { action: { type: 'READY', playerId: 'p1' } } });
  const ready = await call(`/${code}/actions`, { method: 'POST', token: ben, body: { action: { type: 'READY', playerId: 'p2' } } });
  ok(view(ready).phase === 'turnStart', `both ready -> ${view(ready).phase}`);
  // The dealer deals, so the dealer plays last: seat 0 deals round 1 and p2 opens.
  ok(view(ready).turnPlayerId === 'p2', `round 1 opens on the player after the dealer: ${view(ready).turnPlayerId}`);

  const offTurn = await call(`/${code}/actions`, {
    method: 'POST',
    token: ana,
    body: { action: { type: 'DRAW', playerId: 'p1', from: 'deck' } },
  });
  ok(offTurn.status === 200 && !!offTurn.json.refusal, `drawing out of turn is refused -> ${offTurn.json.refusal?.code}`);

  const drew = await call(`/${code}/actions`, {
    method: 'POST',
    token: ben,
    body: { action: { type: 'DRAW', playerId: 'p2', from: 'deck' } },
  });
  ok(view(drew).phase === 'drawn' && view(drew).drawn?.isYours === true, 'the drawer sees the card he drew');

  const drewA = await call(`/${code}/state`, { token: ana });
  ok(
    view(drewA).drawn?.isYours === false && view(drewA).drawn?.card === null,
    'and the other seat sees only that a card was drawn',
  );

  // --- the lobby is shut ----------------------------------------------------
  const late = await call(`/${code}/join`, { method: 'POST', body: { name: 'Cal' } });
  ok(late.status === 409 && late.json.code === 'E_ALREADY_STARTED', `late join -> ${late.status} ${late.json.code}`);

  console.log(`\n${failed === 0 ? 'all good' : `${failed} FAILED`} — room ${code}`);
} catch (error) {
  console.error(`\nCould not reach ${BASE}. Is \`bun run dev\` running?\n`, error.message);
  process.exitCode = 1;
}

if (failed > 0) process.exitCode = 1;

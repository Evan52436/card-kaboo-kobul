# AGENTS.md — Kaboo

> **Single source of truth for this project.** Read this file first, before touching anything.
> Trust it, but verify against the code. If code and this file disagree, fix whichever is wrong
> and say so in the commit message. Never leave them diverged.
> Other agent files (`CLAUDE.md`, `GEMINI.md`, …) are one-line pointers to this file.

---

## 1. Project summary

**Kaboo** is a browser-based, real-time multiplayer implementation of the card game *Kaboo*
(a Cabo-like "memory + slap" game). Two to **8** players play in the same room via a short
**room code**. **No accounts, no install, no app store.**

- **Cross-device, always.** Each player opens the site on **their own** phone or desktop, picks a
  name, and enters the shared code. There is no "pass the phone" mode and there will not be one.
- **Audience:** friends on phones, in the same room or on different continents. **Mobile-first.**
- **Hosting target:** Vercel (Next.js App Router) + Upstash Redis + Ably (private per-player channels).
- **Non-goals (do not build unless asked):** accounts, bots, chat, matchmaking, spectators,
  peer-to-peer/WebRTC, monetization.
- **Directory:** `/home/chargerleptop/Documents/Proyek lokal/kobul` (repo root).

---

## 2. Current status

| Milestone | Scope | Status |
|---|---|---|
| **M0** | Recon: extract design tokens, write AGENTS.md | ✅ **done** |
| **M1** | Pure game engine + unit/property tests, no UI | ✅ **done** |
| **M2** | UI, in-memory store, style tokens | ✅ **done** — the whole table surface, three Join/Lobby/Table screens |
| **M3** | Redis + Ably adapters, rooms, reconnection | ✅ **done** — **written and tested in memory; never run against live Redis or Ably.** See §3 |
| **M4** | Vercel deploy, polish, mobile QA | 🔴 **blocked on the owner** — needs Upstash + Ably accounts and `vercel login` (§10) |
| **M5** | Up to 8 players: the 3–8 seat layout around the table | ⚪ **not started** — the engine and transport support 8 today |

`bun run verify` is green: **210 tests across 12 files**, typecheck and lint clean, `bun run build`
green, and `scripts/smoke.mjs` passes over real HTTP against a running server.

**The table is a real deck.** Faces are PNGs from a public-domain vector deck under
`public/cards/` (§7, §8); the back is CSS. Every control lives in one action dock pinned to the
bottom centre, and the table is built to fit one phone screen without scrolling the page — the board
is the only thing that ever scrolls, and only when it has to.

**Server-authoritative from end to end.** The browser holds no `GameState`; every fact on screen
arrived as a `RoomView` projected for one seat, so a card that player may not see was never
transmitted. Actions POST, state lives behind `StateStore`, each player holds a private channel.

**Not yet proven:** the Redis and Ably adapters — written against the documented APIs, but no request
has crossed a network. Effect targeting and every `ActionBar` sub-flow are implemented and
unit-tested but have had **no human finger on them**.

---

## 3. How to run, test, lint, build

```bash
bun install        # deps
bun run dev        # the game → http://localhost:3000   (in-memory, zero services needed)
bun run smoke      # the wire contract over real HTTP — needs `bun run dev` running
bun run test       # Vitest: engine + room + transport (fast, no network)
bun run typecheck  # tsc --noEmit
bun run lint       # ESLint (flat config)
bun run build      # production build (must stay green: M4 deploys this)
bun run cards      # re-render public/cards/ from the pinned upstream deck (§7)
bun run verify     # typecheck && lint && test  ← run before every commit
```

- **Package manager: `bun`** (1.4.2, pinned in `package.json`'s `packageManager`). **`bun.lock` is
  the lockfile.** `package-lock.json` was deleted and `package-lock.json`/`yarn.lock` are in
  `.gitignore`, so a stray `npm install` cannot resolve a second dependency tree behind bun's back.
  Node ≥ 20 (developed on Node 26).
- **Lint:** `eslint.config.mjs` imports `eslint-config-next/{typescript,core-web-vitals}`
  **directly**. Do not reintroduce `FlatCompat`: it is incompatible with ESLint 9.39 and dies with
  "Converting circular structure to JSON" while formatting its own error.
- **`bun run smoke`** drives create → join → deal → peek → ready → draw over HTTP and asserts the
  hidden-information boundary from outside. `bun run test` calls the route handlers as functions, so
  it never exercises Next's routing or JSON serialisation. It caught three wrong assumptions about
  the wire on first run. Point it elsewhere with `KABOO_BASE` (e.g. at a dev server on another port).
- **`bun run cards`** is a build-time script, not part of `verify`: it fetches the upstream SVGs and
  rasterises them. Its output is committed, so a normal build needs no network.

**Environment (M4).** Names only, never values: `UPSTASH_REDIS_REST_URL`,
`UPSTASH_REDIS_REST_TOKEN`, `ABLY_API_KEY`, `ROOM_SECRET`. `.env.example` lists them; `.env*` is
gitignored. **All four are optional and each degrades independently:** no Upstash ⇒ an in-process
`Map`, correct on one instance but wrong on Vercel; no `ABLY_API_KEY` ⇒ an in-process emitter and
the client polls every 2s instead of pushing (§7); no `ROOM_SECRET` ⇒ a random per-process secret,
warned once, so sessions break on redeploy — **required in production**.

---

## 4. Architecture and file map

```
src/
  protocol.ts   ← THE WIRE CONTRACT. Type-only + a few string constants, so it is safe in a client
                  bundle: RoomView · SyncResponse · DeliveredEvent · RoomError · SESSION_HEADER
  engine/       ← PURE. No framework, no IO, no Date.now, no Math.random. Never imports from app/.
    reduce.ts     applyAction · tick · startGame          ← the public API
    project.ts    project · legalActions · peekableSlots  ← the hidden-info boundary
    state.ts      cloneState · createGame · deal · PEEK_SLOTS · MIN/MAX_PLAYERS · slot accounting
    turn.ts       advanceTurn · kaboo + final turns · settleLooseCards · revealRound
    effects.ts    the power cards (7,8,9,10,J,Q,K) · startEffect · resolveEffect
    tap.ts        the race: claim · choose · place · decline · timeout penalty
    cards.ts      deck build, card ids, values, matchesForTap, shuffle (injected RNG)
    rules.ts      DEFAULT_RULES · resolveRules · tieBreakRank
    scoring.ts    handScore · scoreRound · shouldGameEnd · buildGameResult
    types.ts · errors.ts · events.ts   state/action/event types, error codes, emit/emitPrivate
  store/        ← the room at rest.  RoomRecord (roster, hostId, state, rev, pending, eventSeq)
    types.ts · memory.ts (a Map) · redis.ts (one key `room:{CODE}`, CAS via a Lua `eval`)
    index.ts      getStore() → redis when both Upstash vars are set, else memory
  realtime/     ← the room in motion.  publish(code, [{playerId, message}]) · tokenFor(...)
    types.ts · memory.ts (in-process emitter) · ably.ts (private per-player channels)
    index.ts      getRealtime() → ably when ABLY_API_KEY is set, else memory
  server/       ← every use case. Framework-free, so tests drive it with no network.
    room.ts       createRoom · joinRoom · startRoom · act · read · leaveRoom · realtimeToken
    session.ts    HMAC-signed session tokens (base64url + timingSafeEqual)
    http.ts       status map, header/body/since parsing, one generic failure shape
    deps.ts       the singletons, cached on globalThis so a hot reload does not split the room
  app/          ← Next.js App Router
    page.tsx      three screens: Join → Lobby → Table, plus the one `useGame` in the tree
    GameScreen.tsx  the table surface. Takes a `Game`, reads `Projection` only.
    api/rooms/…   seven route handlers, three lines each, `runtime='nodejs'` + `force-dynamic`
    layout.tsx    root layout; imports both stylesheets, sets the viewport
    icon.svg      the favicon: ink square, white keyline, yellow K
  components/   Card (the real deck, plus `cardFile` and `cardName`) · Hand (2×2, never compacted) ·
                ActionBar (one Action per button, driven by legalActions) ·
                Panels (StatusPill, Scoreboard, GameLog, PeekTray)
  lib/          api.ts (the only `fetch`) · session.ts (the seat + its React store) · stream.ts
                (push when available, polling always) · useGame.ts (the hook) · random.ts
  styles/       tokens.css ← the ONLY place raw values are defined. game.css is layout only.
public/cards/   54 PNGs (52 + 2 jokers) at 264×384, ~668 KB total, plus a README with the licence
scripts/cards.mjs   re-renders public/cards/ from the pinned upstream commit (`bun run cards`)
scripts/smoke.mjs   the wire contract over real HTTP against a live server
tests/        210 tests. Shared: helpers.ts (harness, seededRng) · invariants.ts (accounting,
              leakage, zones) · fuzz.ts (seeded random actions) · decide.ts (what a client would do
              next, from `Projection` only — imports no GameState). Suites: engine · cards · kaboo ·
              tap · projection · properties · client-contract · store · session · room (the tap
              race, forging, leaving) · http (all seven handlers, every status) · transport-game
              (whole games through the room layer at 2–8 players ← the load-bearing one)
```

**Engine public API — keep it stable.** `applyAction(state, action, ctx)` and `tick(state, ctx)`
both return `{ state, events, error?, versionChanged }`; `tick` returns `null` when nothing
happened. `startGame(roomCode, players, ctx, rules?)` → `GameState`; `project(state, viewerId)` →
`Projection`. `Ctx = { now, rng }`. **Rules live on the state** (`state.rules`), not in `Ctx` — a
room's rules must be readable from the state alone. `applyAction` is **pure and total**: it
deep-clones internally, never mutates its input, and never throws for a bad action. A refused action
that *did* advance the clock still returns `versionChanged: true` with the moved state, so a timeout
is never silently dropped.

**There is no `JOIN` action and no `lobby` phase in the engine.** `createGame` validates 2–8 seats
and deals immediately; the roster is fixed at construction. Joining is a **room-layer** concern:
`RoomRecord.roster` accumulates, and the host's `startRoom` hands the engine the finished list. The
old `projectLobby`/`LobbyProjection` scaffolding was deleted rather than left unreachable.

**Phases** (explicit, no scattered booleans):
`peek → turnStart → drawn → effect → finalSwap → reveal → gameOver`. There is no `scored` phase —
the round result rides on `state.roundResult` while the phase is `reveal`. Tapping (`state.tap`) is
an **orthogonal pending claim**, not a phase: it can be claimed during `turnStart`, `drawn` or
`effect`, and is forbidden during `finalSwap` (the house rule). Round 1 is opened by the player
**after** the dealer (`dealerSeat` defaults to seat 0, so seat `p2` moves first), and the deal
rotates each round.

**Two different version numbers, deliberately.** `GameState.version` is the *engine's* CAS token;
`RoomRecord.rev` is the *store's*. They are separate because the room changes for reasons the engine
knows nothing about — a seat joining before any state exists, a player leaving the lobby, a pending
event queue being drained.

---

## 5. Game rules (source of truth)

**Deck.** 52 cards. Optional Jokers (value 0) behind `rules.jokers`, **default off**.
Values: Ace=1, 2–10 face value, J/Q/K=10, **RED kings = −1** (both red kings).

**Deal & peek.** 4 face-down cards per player in a 2×2 square. Slots are fixed and **never
compacted** — players remember positions. Slots `0,1` = far row, `2,3` = **near/bottom row**
(`PEEK_SLOTS`). Each player may look at their bottom two **once** each, then must remember them —
`PEEK` does not end the phase; each player's `READY` does.

**A turn.** Draw the top of the draw pile **or** take the top discard, then SWAP or DISCARD.
- **Swap:** replace one of your own cards. The replaced card goes face-up onto the discard; you may
  **not** look at it first.
- **Discard:** put the drawn card on the discard; it may trigger an effect.
- *Logged assumption:* a card taken from the discard must be **swapped**, not discarded back.

**Effects** (triggered by the discarded card):

| Card | Effect |
|---|---|
| 7 / 8 | Look at one of **your own** cards |
| 9 / 10 | Look at one **opponent's** card |
| J | **Blind-swap** any two cards on the table |
| Q | Swap one of your cards with any other; you **may look at the card you receive** |
| K | Look at any two cards, then **decide whether to swap them**, and announce the decision |

**Tapping (out-of-turn race).** Whenever a table card matches the top discard, **any** player may
tap. First valid tap wins. The tapper discards at least one matching card, from **any** player's
hand; if it was another player's, they may place one of their own cards in its spot. A **wrong
tap**: the card goes back and the tapper draws a blind card into their hand. A wrong tap is a
**successful action, not an error** — refusing it would reveal whether the card matched.

**KABOO.** At the start of your turn you may call it (intended when you believe your total is ≤ 3).
The 3-point condition is **NOT enforced server-side** — rejecting it would leak hidden information;
the +20 penalty punishes bad calls. Afterwards every other player gets exactly **one** final turn.
Losing all your cards **auto-KABOOOs**. **Counter-KABOO:** after a KABOO, a player may skip their
turn and counter-KABOO to try to score lower than the original caller.

**HOUSE RULE — DECK OUT.** The moment a player draws the **last card of the draw pile**, the round
ends. That player may swap it with one of their own, or decline. **No discard, no effect, no
tapping.** Then everyone reveals and the lowest total wins. A swapped-in last card counts; if
declined it is set aside and **not scored**. A wrong-tap blind draw taking the last card goes into
the hand (penalty cards always do) and the round ends with **no swap offered**. **NO reshuffle.**

**Scoring.** The round winner scores **0**. A KABOO caller who did **not** win gets **+20**
(`kabooPenaltyMode: 'added'` — added to their hand total). All others score the sum of their card
values. Points tally across rounds. Optional **"Matt's pairs"**: a matching pair counts 0 (except
red kings); behind `rules.mattsPairs`, **default off**.

---

## 6. Open decisions

Each has a **flag** and a **default currently implemented**. Every flag here exists in
`src/engine/rules.ts`; if you add one, add it here too.

| # | Question | Flag | Default now | Notes |
|---|---|---|---|---|
| 1 | Tie-break for round winner | `rules.tieBreak` | `'seatOrder'` — ties broken by seat order walking left from the dealer | Deterministic, leaks nothing |
| 2 | How a multi-round game ends | `rules.endCondition` / `rounds` / `scoreLimit` | `'fixedRounds'`, `rounds: 5` | Alternative implemented: `'scoreThreshold'` (first to `scoreLimit`=100) |
| 3 | Exact tap-window closing time | `rules.tapClosesOnDiscardChange` | `true` — a tap is stale once the discard top changes | Taps also rejected during `finalSwap` |
| 4 | Does a tap timeout count as a wrong tap? | `rules.tapTimeoutIsWrongTap` | `true` — abandoning a claimed tap draws a penalty card | Stops "claim a tap to block others, then let it expire" |
| 5 | Counter-KABOO semantics ("the gist does not define this fully") | `rules.counterKaboo` | **minimal reading**: a counter-caller skips their turn; scored exactly like a KABOO caller (0 if they win, +20 if not); does not extend or restart the final-turn count | One counter per round per player |
| 6 | Do red kings match other kings for tapping? | `rules.redKingsMatchRank` | `true` — tapping matches on **rank**, so K matches K regardless of colour | "Matt's pairs" still excludes red kings |
| 7 | Nobody readies during `peek` | `rules.peekDeadlineMs` | `45_000`, lazily auto-readies on the next request | Serverless has no durable timers |
| 8 | Hard guard against a round that never ends (players ping-pong the discard forever without consuming the deck) | `rules.turnLimit` | `500` turns, then the round force-ends into `reveal` | Guarantees "a round always terminates" |
| 9 | How much of a failed call is the penalty? | `rules.kabooPenaltyMode` / `kabooPenaltyPoints` | `'added'` + `20` — the caller keeps their hand score and adds 20 | Alternative implemented: a flat-penalty mode |
| 10 | Hand size | `rules.handSize` | `4` | Fixed by the brief; a flag so tests can vary it |

Also implemented, **defaulted off**: `rules.jokers`, `rules.mattsPairs`.

**Need the user's answer** (a default is implemented, so nothing is blocked): #2 and #5.

Room-layer decisions with defaults, same treatment: **room code length 4**, **name capped at 12
characters**, **turn/peek deadlines** (`rules.turnDeadlineMs`, resolved lazily), and **rooms expire
after ~12h of no writes** (Redis `EXPIRE`, refreshed on every write).

---

## 7. Decision log

| Date | Decision | Why | Alternatives rejected |
|---|---|---|---|
| 2026-10-15 | Tokens extracted from the reference site via **real computed styles** (headless Chromium + `getComputedStyle` over the whole DOM), not a screenshot | The brief requires real values; guesses drift | Reading the Tailwind source only (misses which utilities land); eyeballing a screenshot |
| 2026-10-15 | Engine is **dependency-free and IO-free**; `now` and `rng` arrive via `Ctx`, and `applyAction` **deep-clones** its input and returns a new state | Pure, unit- and property-testable, movable to a plain Node server later; state is small, so cloning removes a class of aliasing bugs for no real cost | `Date.now()`/`Math.random()` inside the engine; persistent/immutable structural sharing |
| 2026-10-15 | **Hidden cards project as `{index, occupied, gen}` — never with a card id.** `gen` bumps whenever that slot's contents change | The brief asks to animate "by card ID", but a card id for a face-down card **leaks its face**: discard reveals publish `{id, rank}`, so `id` ⇒ value. `gen` still gives a stable animation key and still signals *that* the card changed (which you'd see in real life) | Sending ids for own hand (leaks); sending nothing (can't animate); server-side "your peeked cards" (brief says peeks are transient) |
| 2026-10-15 | The **drawn card is private to the drawer** from the deck; public from the discard | Matches the physical game — you look at a drawn card privately | Treating all draws as public |
| 2026-10-15 | Tap is **two-step**: `TAP` (claim) then `TAP_CHOOSE` (name the card) | A mistap costs a penalty card, so claim-then-aim is fairer on touch; the race is still settled atomically by the CAS | Single-step atomic `TAP {card}` (loses the race on a fat finger) |
| 2026-10-15 | Effects with a free look (Q's received card) **auto-reveal** to the actor instead of prompting | Saves a round trip for an action that is never disadvantageous | Separate `EFFECT_CONFIRM` step |
| 2026-10-15 | **`LogEntry` has no `card` field at all**, so the type cannot carry a face. Found by the property fuzz: a card discarded in the open was logged with its face, so once it was taken into a hand everyone could still read it | No per-slot projection can undo a face published earlier and stored forever. Removing the field makes the leak structurally impossible rather than a rule to remember | "Don't log faces" as a convention — it already was, and the bug happened anyway |
| 2026-10-15 | **`revealRound` settles loose cards** before scoring: a card the turn player still held goes into their hand; a deck-out card still under consideration is treated as declined | Fuzz bug (seed 1050406591): a wrong-tap penalty drawing the **last** card ends the round while the turn player is mid-draw, and clearing the field deleted that card from the game | Clearing the field (loses a card); refusing the penalty (contradicts the house rule) |
| 2026-10-15 | `Projection.peekableSlots` exposes exactly which slots are legal to look at, and during a King effect `EFFECT_KING_DECIDE` is advertised **instead of** `EFFECT_SKIP` once the two cards are known | The "`legalActions` is honest" test caught two bugs: `PEEK` advertised for any unready player though the handler accepts only slots 2–3, once each (the client cannot derive this from `phase`); and `EFFECT_SKIP` advertised where the resolver refuses it | Letting the UI re-derive "the bottom two" (it got it wrong); accepting a peek at any slot (breaks the rule); advertising both and letting one fail (a button that does nothing) |
| 2026-10-15 | fast-check's **generator seed is pinned** (`FC_SEED = 20261015`), and every counterexample is promoted to a named regression case | A fresh seed per run made failures unreproducible: the counterexample appeared once and vanished | Unpinned seeds (red builds you cannot replay) |
| 2026-10-15 | `Projection.discardSeq` is public, and the client-side contract has its own test file that plays whole games **from `project()` output alone** | Found by writing the client: a `TAP` must carry the `seenSeq` it was reacting to and **no other field could supply it**, so tapping was unimplementable. A safe projection that omits what a client needs to act is still broken — invisible until a human clicks a button that cannot work. Leaks nothing: anyone can count the pile | Using `version` as the sequence (it moves for unrelated reasons, so every tap would read as stale); omitting `seenSeq` (gives up the anti-stale guarantee) |
| 2026-10-15 | **A hot-seat build was written and then deleted.** One device, players passing the phone behind a "pass the phone" gate | It was a misreading of "M2 = local 2-player UI": **local** modifies the *store* (in memory instead of Redis), not the players. A room code is meaningless when everyone shares a screen, and the whole `GameState` sat in browser React state — so the hidden-information boundary the engine is built around was bypassed and nothing was actually transported. Recorded so it is not rebuilt: **two players on one machine means two browser windows**, which is the same code path as two countries | Keeping it behind a flag (two code paths, one of them untested and wrong); a single-device demo mode (not the product) |
| 2026-10-15 | The room layer owns the lobby and **the engine was not modified to add joining**. `startRoom` hands the engine a complete roster | `createGame` fixes the roster at construction and a fresh game is already in `peek`, so the engine's `lobby` phase was unreachable scaffolding, and a `JOIN` action would have meant a mutable roster — the most bug-prone thing in a card game, for a fact the room already knows | An engine `JOIN` action (roster mutation inside the state machine); re-creating the game per join (throws away the deal) |
| 2026-10-15 | **Compare-and-set at the store, `rev` on the record, `version` on the state**, and the tap race is settled by whoever commits first; deadlines are **timestamps resolved lazily** on the next read *and* the next action | Serverless holds no shared memory and no durable timer: last-write-wins corrupts hands, and `setTimeout` does not survive a function returning. `rev` is separate from `version` because a join commits before any state exists | Naive read-modify-write; durable timers/cron; a client-supplied version check (the engine's own `seenSeq`/phase/turn guards are stricter and cannot leak) |
| 2026-10-15 | **Every private event carries its own `seq`** (`DeliveredEvent = EngineEvent & { seq }`), and the server sends the **whole** queue on both push and poll, because it does not know what the client has seen | Push and poll are two independent paths to the same fact, so without a per-event seq the client cannot tell a replay from a replay of a replay — a player would be shown the same peek twice, or a poll would re-announce a card the push had already delivered. With it, delivery is at-least-once and idempotent against one client-held cursor, which is what lets push stay best-effort. **Found only by writing the client** — the protocol looked complete before | Tracking delivery server-side (a second source of truth, and a dropped push then loses the peek); push-only delivery (a missed message is a lost card) |
| 2026-10-15 | **Polling always, push on top.** `POLL_MS` 2s, `HEARTBEAT_MS` 8s when push is healthy. `realtimeToken` answers `{ token: null }` with a **200**, not a 400, when no push service is configured | A serverless function holds no timer, so **deadlines only resolve when somebody touches the room** — a purely push-driven table would sit in one phase forever the moment nobody acts. And running without Ably is a supported configuration, so "there is no push channel" is an answer, not a rejection; a 400 would blame the client for the server's choice | Push-only (deadlocks); a durable timer per deadline (does not survive); no polling when push is healthy (a dropped push would freeze the table) |
| 2026-10-15 | The **session rides in an `x-kaboo-session` header**, never a query string, and `action.playerId` from the body is **discarded and replaced from the session** | A URL ends up in server logs, browser history and `Referer` headers, and this token **is** the seat. Signed rather than random-plus-lookup so a session survives a Redis blip and yields the Ably capability directly. Overwriting the body's `playerId` is what makes "act as another player" impossible rather than merely discouraged — tested over real HTTP in both directions | Session in the URL (logged, shared, replayable); trusting the body's `playerId` (anyone can act as anyone) |
| 2026-10-15 | One **private channel per player** (`kaboo:room:{CODE}:p:{playerId}`) with a subscribe-only scoped capability, and `leave` as a **seventh** route | A shared table channel cannot carry a private peek. `tokenFor` mints `capability: { [thatOneChannel]: ['subscribe'] }`, so a player cannot listen to another seat even knowing its name. `leave` was added because `room.ts` already implemented and tested `leaveRoom` and the UI needs it — a route the plan had missed | One room-wide channel (cannot deliver a peek privately); filtering a shared channel client-side (the card would already be on the wire) |
| 2026-10-15 | The **seat is read with `useSyncExternalStore`**, with `getServerSnapshot` returning `null` and a second constant-snapshot store for "has the browser taken over yet" | `localStorage` is external state: copying it into `useState` via an effect is a second source of truth and renders once with the wrong answer — a seated player would see the join form and then be yanked off it. The server cannot read `localStorage`, so it renders the neutral gate and the client takes over. Also the only shape React 19's `set-state-in-effect` and `refs` lint rules accept | `useState(() => loadSession())` (hydration mismatch); `useEffect(() => setSession(…))` (lint error, cascading render); a `/api/me` round trip (a network hop to answer a question the device can answer) |
| 2026-10-15 | `useGame` takes a **non-null** session and is mounted once, in `page.tsx`, above both the lobby and the table; the ref holding `onLost` is written **in an effect**, not during render | The lobby and the table are two views of one live connection, so dealing must not tear down the stream and rebuild the Ably connection — and the peek cursor must survive it. A null branch would have needed `setState` inside an effect to reset state, which is both a lint error and a cascading render | One `useGame` per screen (reconnect on deal, cursor reset); resetting state in an effect (lint, extra render); `useEffectEvent` (not stable in this Next version) |
| 2026-10-15 | **The deck is real artwork, vendored as PNG — a deliberate, measured deviation from the brief's "render cards as SVG or CSS"** | The brief's rule exists to avoid copyrighted art, so the fix was a licence, not a drawing: Byron Knoll's vector deck, released into the **public domain** (readme read before anything was vendored), via `notpeter/Vector-Playing-Cards` at a pinned commit. Rasterised at 264px wide — 3× the largest a card is ever drawn — and quantised to 128 colours: **668 KB for all 54**, at **exactly the size they are displayed**, so there is no scaling work for the browser to do. Hand-drawn CSS pips would have been a worse game to play *and* a new source of contrast bugs | Shipping the SVGs (8 MB raw, ~3 MB after SVGO for the 12 court cards alone — and `floatPrecision: 0`, the setting that would have made them small, collapsed a queen into stray diagonals, verified by rendering both and looking); WebP (no gain on flat art this size, and one more thing to get wrong); `next/image` (the files are already pre-sized, so the optimiser buys a round trip and nothing else) |
| 2026-10-15 | **Every action lives in one `.kb-dock` pinned to the bottom centre**, full-bleed, `max-width: 48rem` inside | The owner's report: "the buttons are hard to see and reach". As a bar hanging off the bottom of the left-hand desktop column, the shortest mouse travel to *Swap* ran diagonally across the whole table; on a phone the bottom is where the thumb already is. The peek tray and the refusal message moved in with it, so nothing floats over the pile the next player is about to tap. Disabled buttons stopped being `opacity: 0.45` (≈2:1 — a button you cannot read is not a button) and became flat, muted and legible at 6.5:1 | A floating action button (hides the one control that matters); a top bar (furthest point from a thumb); keeping the bar in the column and only making it bigger |
| 2026-10-15 | **The table is exactly `100dvh` and does not scroll; the board between the fixed rows is the only scroller.** The dock owns the height with `flex: 0 0 auto` instead of `position: sticky` | Sticky only ever pins a bar that is *already* at the bottom of its scroll: at the top of a too-tall page the bar sits mid-document and the last row of the player's hand hides behind it — the buttons were reachable and the cards they act on were not. Below the desktop breakpoint each column of the board scrolls on its own, because scrolling the board as a whole dragged the scoreboard's heading off the top of the screen the moment a hand needed to come into view | Trimming the layout until the worst case fits (shrinking the cards every player looks at all game to serve a hand that took a penalty card); `position: fixed` (content passes underneath); letting the page scroll (a dock that scrolls away is not a dock) |
| 2026-10-15 | When it becomes your move, the board scrolls your own cards into view — `scrollIntoView({ block: 'nearest' })`, instantly | `'nearest'` scrolls only when the element is not already fully visible, so it is a **no-op on every screen that already fits** — which is most of them. Instant rather than smooth because a control you cannot see is worse than a jump you did not ask for, and `prefers-reduced-motion` is not a question worth asking when the alternative is an invisible card | Shrinking cards to fit the worst case; a manual "scroll down" affordance (the player does not yet know there is anything to scroll to); smooth scrolling (a 40px correction does not want 300ms of animation) |
| 2026-10-15 | **`--card-h: calc(var(--card-w) * 1.4545)` was replaced by `--card-ratio` + `aspect-ratio` on `.kb-card`** — a real, pre-existing bug, not a refactor | A CSS custom property is substituted **where it is declared**: a `calc()` on `:root` resolves against the root's `--card-w` and is then inherited *frozen*, so it does not follow a descendant's override. Every place that shrank `--card-w` (compact hands, the peek tray) got a card the right width and the wrong height — measured at **43×85px, a ratio of 1.98 instead of 1.45**. Invisible against plain black rectangles; glaring the moment real art arrived | A second `.kb-card` rule per context (five places to forget); `height: calc(100% * …)` (needs a definite height, which is the problem); JS measurement (breaks SSR and resize) |
| 2026-10-15 | `.kb-label { margin: 0 }` — the label class dresses `h3`, `p` and `label` | An `h3` at 12px still carries a 1em margin, so every heading cost 24px of nothing on top of the parent's flex gap: **48px across the opponent row and the player's own row**, which on an 844px phone was most of the second row of the hand | Setting the margins at each call site (the same bug, four places to forget) |
| 2026-10-15 | **A peek notice is kept only for the round it arrived in** (`Peek.round`, pruned on insert) | The tray only ever grew: `setPeeks((prev) => [...prev, …])` with no bound meant a player who never tapped *Remember it* accumulated every peek and every draw of the whole game — measured at three cards after one turn, and a dock that eats the screen by round two. Nothing is lost by dropping them at a round boundary: at the reveal every card is face-up, so the reminder has stopped being information | A hard cap with a "+N earlier" note (silently withholds cards the player was shown); clearing on turn change (wipes the opening peeks, the only cards anyone legitimately saw); an effect on the round number (a second place the tray changes shape, and a lint error) |

---

## 8. Design tokens and style notes

**Source:** `https://hackathon.ackteams.com/` and `/student`, read as **computed styles** in headless
Chromium. The reference is **neo-brutalist**. We take colour, type, border weight, radii, shadows,
spacing and motion — **not** its layout or content.

**The signature (do not dilute it):** zero border-radius — literally `0`, not "small"; hard black
borders (`2px`, `4px` for section dividers); hard offset shadows with **zero blur**, pure black
(`2px/4px/8px`, `0 0` spread); uppercase `font-weight: 900` with tight tracking on headings, mono
bold 12px for codes and labels. **Press = move into the shadow:** on `:active`, `box-shadow: none`
**and** translate by the offset the shadow had (`4px 4px` shadow ⇒ `translate(4px, 4px)`) — that is
the motion signature.

**Tokens live in `src/styles/tokens.css`** — written, and the only place raw values are defined.

| Group | Tokens | Values | Provenance |
|---|---|---|---|
| Surfaces | `--c-bg`, `--c-surface`, `--c-surface-2` | `#ffffff`, `#f9fafb`, `#f3f4f6` | `body` bg, gray-50, gray-100 |
| Ink | `--c-ink`, `--c-ink-soft`, `--c-ink-muted` | `#000000`, `#364153`, `#4a5565` | text + all borders, gray-700, gray-600 |
| Primary | `--c-primary`, `-press`, `-soft`, `-line` | `#0055ff`, `#193cb8`, `#dbeafe`, `#90c5ff` | `--color-primary`, blue-800/100/300 |
| Highlight | `--c-highlight` | `#fef08a` | `--color-highlight` (KABOO) |
| Status | `--c-danger`/`-soft`, `--c-success`/`-soft` | `#fb2c36`/`#ffe2e2`, `#008138`/`#dcfce7` | red-500/100, green-700/100 |
| Borders & radius | `--bw-1/-2/-4`, `--radius` | `1px`/`2px`/`4px`, **`0`** | computed widths; **every** element computed `0` |
| Shadows | `--shadow-sm/-/-lg` | `2px 2px 0 0 #000`, `4px 4px 0 0 #000`, `8px 8px 0 0 #000` | computed `box-shadow`, blur `0` |
| Type | `--text-xs…--text-4xl`; `--fw-normal/-medium/-bold/-black`; `--tracking-tight/-tighter/-wide`; `--leading-*` | `12/14/16/18/20/24/36/48px`; `400/500/700/900`; `-0.025/-0.05/0.1em` | computed sizes, weights, `letter-spacing` |
| Fonts | `--font-sans`, `--font-mono` | Geist, Geist Mono (+ system fallbacks) | next/font |
| Spacing | `--space-1…--space-12` | `4px` base | `--spacing` |
| Motion | `--dur`, `--ease`, `--dur-flip` | `150ms`, `cubic-bezier(.4,0,.2,1)`, `240ms` | computed transitions; the flip is our one deliberate exception |
| Layout | `--gutter`, `--tap-target`, `--card-w`, `--card-ratio` | `16px`, `44px`, `clamp(52px, 15vw, 88px)`, `1.4545` | ours, not the reference's |
| Focus | `--focus-width` | `4px` | ours — the one control that must never be missed |

**Component classes** (defined in `tokens.css`; components apply them, never raw values):
`kb-surface`, `kb-header`, `kb-btn` (`--primary` / `--danger` / `--kaboo`), `kb-chip`
(`--dark` / `--soft`), `kb-title`, `kb-label`, `kb-card` (`--down` / `--selected` / `--empty`),
`kb-table`. `game.css` is layout only and defines no raw values.

Three rules the class bodies encode, so read them there before overriding: **KABOO** is highlight
yellow with black text and an `8px` shadow (never white on yellow — it is 1.3:1); contrast is
`#000` on `#fff`, `#193cb8` on `#dbeafe` (7.4:1), or black on `--c-highlight` (17:1);
`prefers-reduced-motion` collapses `--dur` to `0ms` rather than removing transitions, because card
movement is the game's information channel.

**Card art.** `public/cards/{rank}{suit}.png` (`AS`…`KD`, plus `Joker1`/`Joker2`), **public domain**
— Byron Knoll's vector deck, redistributed by `notpeter/Vector-Playing-Cards`; the render script
pins the upstream commit. `public/cards/README.md` records this where the files are. `cardFile()`
maps a `PublicCard` to its file, and the two jokers are told apart by **id** (52/53) because their
`rank` and `suit` are identical. The **back is CSS**, not art: nothing to load for the ten of them on
the table, and a shut card must not read as "a card" from across the table. The face image overshoots
its frame by 4% (`.kb-card__face { inset: -2% }`) so the deck's own rounded border falls outside the
clip and a card ends up with exactly one edge — the `2px` rule on `.kb-card`. At `108%` the corner
index clips; at `104%` it does not.

---

## 9. Conventions and gotchas

**Hidden information — the rules that matter most:**
1. **The server is authoritative.** Full state never leaves it; clients receive `project(state, viewerId)`
   and nothing else. There is no `GameState` in the browser bundle — keep it that way.
2. **Peeks are transient reveal events, never stored state.** Events carry `to: playerId`, the
   transport delivers them only to that player's private channel, and the client holds them in
   `PeekTray` and forgets them when dismissed.
3. **Never compute or reveal a player's own total during play** — not in the projection, not in the
   UI, not in an event. Totals appear only at `reveal`.
4. **Errors are generic.** Neither `EngineError` nor `RoomError` explains *why* an action was
   rejected when the reason depends on hidden information; the client renders one flat "That did not
   work." A refusal is distinguishable from "nothing happened" **only** by the `refusal` field on an
   otherwise successful response — never by a message.
5. **Never send a card id for a card the viewer may not see** (the `gen` decision, §7), and **never
   put a card face in a log entry** — `LogEntry` has no `card` field, so the type enforces it; do not
   add one. Faces belong in *events* or on the public discard (already face-up).
6. Rule checks that would *leak* are deliberately **not** enforced: the KABOO 3-point condition is
   not validated server-side. Do not "helpfully" add it.
7. `POST /join` is a **room-existence oracle**, and `E_NOT_FOUND`/`E_BAD_SESSION` are distinguishable
   — they must be, since joining by code is the product. Neither reveals a card.

**Things that look wrong but are intentional** (game rules are **not** restated here — §5 is the
source of truth for those; these are the implementation consequences):
- A hand can be **longer than 4** (penalty cards, a late draw) and can contain **empty slots**;
  `0` cards is legal and triggers auto-KABOO. Slots are never compacted, because players remember
  positions — render gaps as empty, not as a shifted row.
- `state.setAside` holds the **declined last card** so every card id is accounted for exactly once.
- `legalActions` must be **honest**: everything it advertises must actually be accepted by
  `applyAction` in that state. A test holds it to this and has caught two real bugs (§7). Add a
  handler branch and you update the advertisement in the same commit.
- `versionChanged: false` means "do not write to the store" — the input state is returned unchanged.
- The old name for M3 was "local 2-player". **Local describes the store, not the players.**
- A player's stored session **is** their seat: losing it means rejoining as somebody new. The room
  never frees a seat once the deal has happened, and the engine autoplays a disconnected turn.

**The client contract — the rule that keeps the UI alive:**
- The UI reads **`Projection` only** — never `GameState`, never `project` itself. A card the viewer
  may not see has a `null` face, and no component may overrule that. Faces arrive as private events
  and live only in `PeekTray`.
- The UI never re-derives a rule: buttons come from `legalActions`, tappable slots from
  `peekableSlots` and `canTap`. If a rule seems missing from the projection, **add it there** — and
  the same goes for the room layer's `RoomView`: the lobby is told `hostId` rather than inferring it
  from `roster[0]`, which is only correct by an ordering accident in `room.ts`.
- **If the UI can do something, a case belongs in `tests/client-contract.test.ts`** — those tests
  play whole games from projection output alone, so a field the client needs but the projection
  omits is a red test rather than a dead button. `discardSeq` was found exactly this way.
- Nothing in `tests/decide.ts` may read `GameState`: every argument is a `Projection`. It is the
  single definition of "what a client would do next", shared by the client-contract and transport
  suites, so neither can quietly start cheating.
- Every button is a real `<button>`; every target is ≥ 44px. A mistap costs a penalty card.

**Transport:** `src/protocol.ts` is the only thing both sides know (type-only plus a few string
constants), so adding a field to `RoomView`/`SyncResponse` touches that file and nothing else. Every
store boundary `structuredClone`s — load-bearing, not defensive. The store's CAS returns `null` on
conflict and the bounded retry re-reads and decides again; that retry is where a lost tap race
becomes a correct `E_TOO_LATE`. The memory store, memory realtime and per-process secret are cached
on `globalThis`: without that, a dev hot reload hands out a second store and the table silently
splits in two.

**Traps already hit:**
- Don't `sort(() => Math.random() - 0.5)` — biased **and** untestable. Use `shuffle(cards, rng)`
  (Fisher–Yates): `crypto.getRandomValues` live, a seeded generator in tests. And **never call
  `Date.now()` or `Math.random()` inside the engine** — both arrive via `Ctx`.
- A property-test failure is only useful if it replays: keep `FC_SEED` pinned, keep the offending
  action in the assertion message, promote each counterexample to a named regression case.
- Tailwind is **not** used. Plain CSS + tokens; utility classes would fight the token layer.
- `touch-action: manipulation` and `overscroll-behavior: none` go on the **game surface**
  (`.kb-table`); layout uses `dvh` (never `vh`) with `env(safe-area-inset-*)` padding.
- The reducer returns errors, it never throws. Callers must branch on `.error`.
- **Mutation-test anything load-bearing before trusting a green suite.** Two of this project's own
  assertions were found vacuous this way: a "reaches the reveal" test that passed with the deadline
  path removed, and a lost-race test that never contested a tap. Break the CAS, the event routing, a
  projection field, or `legalActions`, and confirm the suite actually goes red.
- React 19's lint rules are strict in ways that matter here — no `setState` in an effect body, no
  writing a ref during render. Both flagged real design questions, not noise (last two rows of §7).
- **A CSS custom property is substituted where it is DECLARED, not where it is used.** A
  `--card-h: calc(var(--card-w) * 1.4545)` on `:root` resolves against the root's `--card-w` and is
  then inherited *frozen*; every descendant that overrides `--card-w` gets a stale height. This is
  what produced a stretched card face (§7). Derive sizes with `aspect-ratio` (or a `calc()` written
  *inside* the rule that uses it) rather than a computed property on `:root`.
- **Layout is measured, not assumed.** `chromium.launch()` + `getBoundingClientRect()` found two bugs
  no unit test could: the stretched card, and an 844px screen overflowing by 167px. Numbers beat
  guesses: a wasted 12px of heading margin is 48px across two rows, which is the difference between
  a hand you can see and one you cannot.
- **Never change the 2×2 hand's shape to save space.** The square *is* the memory aid — cards are
  never compacted and slots never reflow. Trim gaps, labels and chrome instead.
---

## 10. Next steps

**Next steps** (rewritten 2026-10-15, after the deck-and-dock pass):
1. **M4 — real hardware.** The layout is now measured (no page scroll at 390×844; the board, and each
   desktop column, scroll only when they must), but only ever in headless Chromium at one viewport.
   A real phone brings the home indicator, the URL bar and `env(safe-area-inset-*)`, and a real
   finger has still never touched an effect sub-flow. Check: 2×2 stays 2×2, the dock clears the home
   indicator, the peek tray's *Remember it* is reachable one-handed.
2. **M4 — deploy. Blocked on the owner, not on code.** Needs a free Upstash database and an Ably app,
   plus `vercel login` run by the user (`! vercel login` in this session works). Then set the four
   variables from `.env.example` in the Vercel dashboard and `vercel --prod`.
3. **M4 — prove the adapters.** Redis and Ably have never crossed a network. Deploy first, then play
   from two separate networks: a phone on cellular and a laptop on wifi. Confirm near-instant moves,
   a peek visible **only** to the player who earned it, and the tap race showing "too late" to the
   loser. Until then, treat §2's "M3 done" as provisional.
4. **M4 — reconnection.** Refresh mid-turn and confirm the stored session restores the same seat.
   Then background a phone for two minutes and confirm the tab catches up on the way back.
5. **M5 — 3 to 8 seats.** Opponents currently render in a scrolling row. The brief wants 3–8 seated
   around the table on desktop while keeping the mobile column; the engine and transport already
   support 8. Note the budget: the phone layout is full at three opponents, so a fourth needs the
   opponent row to scroll horizontally (it already can) rather than to grow.

**Open questions for the user** (§6): #2 (how a multi-round game ends) and #5 (counter-KABOO).
Both have working defaults, so nothing is blocked.

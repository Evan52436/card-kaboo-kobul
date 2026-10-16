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

`bun run verify` is green: **249 tests across 15 files**, typecheck and lint clean, `bun run build`
green, and `scripts/smoke.mjs` passes over real HTTP against a running server.

**The table is a real deck.** Faces are public-domain artwork under `public/cards/`, served as
**lossless WebP** with the PNG kept beside it as an `onError` fallback (§7, §8); the back is CSS.
The host chooses **one deck or two** when they deal (§5). Every control lives in one action dock pinned to the
bottom centre, and the table is built to fit one phone screen without scrolling the page — the board
is the only thing that ever scrolls, and only when it has to.

**Server-authoritative from end to end.** The browser holds no `GameState`; every fact on screen
arrived as a `RoomView` projected for one seat, so a card that player may not see was never
transmitted. Actions POST, state lives behind `StateStore`, each player holds a private channel.

**Not yet proven:** the Redis and Ably adapters (and `src/store/env.ts`, `src/server/sessionKey.ts` +
`tests/store-env.test.ts`, `tests/session-key.test.ts`) — written against the documented APIs, but no
request has crossed a network. The peek and tap sub-flows, the opening-peek Ready gate, the
hover/press/live card states and the hand-row layout have all been driven through a real browser
(2026-10-15, Chromium via Playwright; numbers in §9). **On 2026-10-16 the WebP path and the
peek-watch marks were driven the same way, against a production build** (`next build && next start`):
a real table requested **only** `/cards/*.webp` (no `.png` fallback fired), the browser decoded it at
264×384, an opponent's peek put a yellow eye-ring on their card with the line "Ana is looking at their
own card 3", and the mark cleared itself afterwards. **The effect sub-flows (7/8/9/10/J/Q/K
targeting) still have had no finger on them** — and that gap is exactly where the tap bug below was
hiding. The card-flight planner has unit tests and runs on the pages that were driven, but no flight
has been *watched* land.

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
bun run cards      # re-render public/cards/*.png from the pinned upstream deck (§7)
bun run cards:webp # re-encode those PNGs to lossless .webp (§7) — needs `bun run cards` first
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
  rasterises them. **`bun run cards:webp`** re-encodes its output, and is a separate step on purpose —
  the PNG is the source of truth, and `Card.tsx` falls back to it. Its output is committed, so a
  normal build needs no network. Both take optional card names (`bun run cards:webp 7H AS`) to redo
  one card at a time.

**Environment (M4).** Names only, never values: `UPSTASH_REDIS_REST_URL`,
`UPSTASH_REDIS_REST_TOKEN`, `ABLY_API_KEY`, `ROOM_SECRET`. `.env.example` lists them; `.env*` is
gitignored. **Upstash credentials are also found under Vercel's integration names** (`<PREFIX>_KV_REST_API_URL` + `<PREFIX>_KV_REST_API_TOKEN`, never the read-only token; see `src/store/env.ts`), so the integration works without renaming anything in the dashboard. **All four are optional and each degrades independently:** no Upstash ⇒ an in-process
`Map`, correct on one instance but wrong on Vercel; no `ABLY_API_KEY` ⇒ an in-process emitter and
the client polls every 2s instead of pushing (§7); no `ROOM_SECRET` ⇒ a random per-process secret,
warned once, so sessions break on redeploy — **unless Redis is configured, in which case the session key is derived from the Redis token (`src/server/sessionKey.ts`) and is identical on every instance; set `ROOM_SECRET` for a dedicated key**.

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
    env.ts        redisCredentialsFromEnv(env) — UPSTASH_REDIS_REST_* or Vercel's <PREFIX>_KV_REST_API_*
    index.ts      getStore() → redis when credentials are found, else memory
  realtime/     ← the room in motion.  publish(code, [{playerId, message}]) · tokenFor(...)
    types.ts · memory.ts (in-process emitter) · ably.ts (private per-player channels)
    index.ts      getRealtime() → ably when ABLY_API_KEY is set, else memory
  server/       ← every use case. Framework-free, so tests drive it with no network.
    room.ts       createRoom · joinRoom · startRoom · act · read · leaveRoom · realtimeToken
    session.ts    HMAC-signed session tokens (base64url + timingSafeEqual)
    sessionKey.ts sessionKeyFromEnv(env) — ROOM_SECRET, else derived from the Redis token, else null
    http.ts       status map, header/body/since parsing, one generic failure shape
    deps.ts       the singletons, cached on globalThis so a hot reload does not split the room
  app/          ← Next.js App Router
    page.tsx      three screens: Join → Lobby → Table, plus the one `useGame` in the tree
    GameScreen.tsx  the table surface. Takes a `Game`, reads `Projection` only.
    api/rooms/…   seven route handlers, three lines each, `runtime='nodejs'` + `force-dynamic`
    layout.tsx    root layout; imports both stylesheets, sets the viewport
    icon.svg      the favicon: ink square, white keyline, yellow K
  components/   Card (the real deck, plus `cardFile` and `cardName`) · Hand (one scrolling row, never compacted) · CardFlights (ghost cards travel between places) ·
                ActionBar (one Action per button, driven by legalActions) ·
                Panels (StatusPill, Scoreboard, GameLog, PeekTray)
  lib/          api.ts (the only `fetch`) · session.ts (the seat + its React store) · stream.ts
                (push when available, polling always) · useGame.ts (the hook) · flights.ts (pure: which cards moved between two snapshots) · random.ts
  styles/       tokens.css ← the ONLY place raw values are defined. game.css is layout only.
public/cards/   54 cards at 264×384 as PNG (548 KB) AND lossless WebP (452 KB), plus a README with the licence
scripts/cards.mjs   re-renders public/cards/*.png from the pinned upstream commit (`bun run cards`)
scripts/cards-webp.mjs  re-encodes every PNG to .webp and FAILS if any card got bigger (`bun run cards:webp`)
scripts/lib-webp.mjs    the one encoder (`magick`, falling back to `cwebp`) + `pathOf`/`sizeOf`
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

**Deck.** 52 cards, or **two decks of 52 behind `rules.decks: 2`** (the host picks when dealing) —
the second deck is a second *set* of physical cards sharing the same faces, so every rank exists
twice and a tap has twice as many legal answers. Optional Jokers (value 0) behind `rules.jokers`,
**default off**; each set carries its own two.
Values: Ace=1, 2–10 face value, J/Q/K=10, **RED kings = −1** (both red kings).

**Deal & peek.** 4 face-down cards per player in a 2×2 square. Slots are fixed and **never
compacted** — players remember positions. Slots `0,1` = far row, `2,3` = **near/bottom row** (the app draws the four in one row, so these read as cards 3 and 4)
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
| Q | Swap one of your cards with any other. **Neither player sees what moved** — the default is blind for both (`rules.queenLooks: false`); the original house rule where the swapper looks is behind the flag |
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

Also implemented, **defaulted off**: `rules.jokers`, `rules.mattsPairs`. And two flags that are settled
host choices rather than open questions: **`rules.decks`** (`1`, or `2` from the deal toggle — §5) and
**`rules.queenLooks`** (**default `false`**: a Queen swap is blind for both players — §7).

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
| 2026-10-15 | **The deck is real artwork, vendored as PNG — a deliberate, measured deviation from the brief's "render cards as SVG or CSS"** | The brief's rule exists to avoid copyrighted art, so the fix was a licence, not a drawing: Byron Knoll's vector deck, released into the **public domain** (readme read before anything was vendored), via `notpeter/Vector-Playing-Cards` at a pinned commit. Rasterised at 264px wide — 3× the largest a card is ever drawn — and quantised to 128 colours: **548 KB for all 54** (byte totals; `du` reports ~668 KB of allocated blocks), at **exactly the size they are displayed**, so there is no scaling work for the browser to do. Hand-drawn CSS pips would have been a worse game to play *and* a new source of contrast bugs | Shipping the SVGs (8 MB raw, ~3 MB after SVGO for the 12 court cards alone — and `floatPrecision: 0`, the setting that would have made them small, collapsed a queen into stray diagonals, verified by rendering both and looking); WebP as first measured — the default **lossy** encoder came out *bigger* than these PNGs, and the row below records the reversal; `next/image` (the files are already pre-sized, so the optimiser buys a round trip and nothing else) |
| 2026-10-16 | **The cards ship as LOSSLESS WebP, with the PNG kept beside them as the fallback** | Owner's ask ("convert all the image to compressed WEBP so it loads fast"). The first measurement had used the default *lossy* encoder and rejected WebP on it — **that was measuring the wrong thing**: lossy has to spend bits on the ringing it introduces, and PNG8's 128-colour palette is already near-optimal for flat art, so the simple cards came out **larger** (7H: 5,772 B → 6,390 B at q75, 7,748 B at q82). Lossless wins on **all 54**: 548 KB → **452 KB (18% smaller)**, and it is **bit-exact** — `magick compare -metric AE` reports **0 differing pixels on every card**, dimensions preserved, so "did the conversion work" is a test rather than an opinion. The PNG stays because `Card.tsx`'s `fallToPng` needs it: a browser without WebP gets the PNG rather than nothing | Lossy WebP (measurably bigger here — see the numbers); dropping the PNGs (removes the `onError` fallback and the encoder's own source of truth); `next/image` (still a round trip for a file that is already the size it is drawn) |
| 2026-10-16 | **`decks: 1 \| 2` is a host choice at deal time, and the second deck is a second *set* of card IDs, not a re-deal of the first** | Owner's ask ("play with just one deck of card or two deck / sets / box of card"). The id table is fixed — 0–51 set one, 52–53 its jokers, 54–107 set two — so `setIndexOf(id) = id % SET_SIZE` maps either copy of a card to **one** picture: both sevens of hearts look identical because they *are* the same card, physically distinguishable only by id. This is what makes the accounting invariant survive a 104-card game, and it is the source of the ids-are-a-set trap in §9 | Reusing the same 52 ids twice (the whole "every card is in exactly one zone" invariant counts one card twice); a contiguous 0…103 id space (would shift what every id draws whenever `jokers` flips) |
| 2026-10-16 | **The Queen's swap is blind for BOTH players by default** (`rules.queenLooks: false`) | Owner's ask: "when swapping card with other person, both the person shouldn't be able to see the card they swap with." The original gist lets the swapper look at what they receive, but that makes the Queen a free look plus a swap — and the recipient is left knowing **that** their card changed without knowing what it was, which is the worst of the three positions. Now the engine emits no `revealed` event at all for a Queen swap (guarded by the flag), so neither projection can carry one: proved by a test asserting **no event in the whole result has a `card` field**. The public `effectUsed` names the two slots — both owners learn *that* they changed, never *what* they became | Keeping the old default (asymmetric information, and the swapper gets a look the rules never charged for); hiding even the fact of the swap (the slots visibly change, so the engine would be lying) |
| 2026-10-15 | **Every action lives in one `.kb-dock` pinned to the bottom centre**, full-bleed, `max-width: 48rem` inside | The owner's report: "the buttons are hard to see and reach". As a bar hanging off the bottom of the left-hand desktop column, the shortest mouse travel to *Swap* ran diagonally across the whole table; on a phone the bottom is where the thumb already is. The peek tray and the refusal message moved in with it, so nothing floats over the pile the next player is about to tap. Disabled buttons stopped being `opacity: 0.45` (≈2:1 — a button you cannot read is not a button) and became flat, muted and legible at 6.5:1 | A floating action button (hides the one control that matters); a top bar (furthest point from a thumb); keeping the bar in the column and only making it bigger |
| 2026-10-15 | **The table is exactly `100dvh` and does not scroll; the board between the fixed rows is the only scroller.** The dock owns the height with `flex: 0 0 auto` instead of `position: sticky` | Sticky only ever pins a bar that is *already* at the bottom of its scroll: at the top of a too-tall page the bar sits mid-document and the last row of the player's hand hides behind it — the buttons were reachable and the cards they act on were not. Below the desktop breakpoint each column of the board scrolls on its own, because scrolling the board as a whole dragged the scoreboard's heading off the top of the screen the moment a hand needed to come into view | Trimming the layout until the worst case fits (shrinking the cards every player looks at all game to serve a hand that took a penalty card); `position: fixed` (content passes underneath); letting the page scroll (a dock that scrolls away is not a dock) |
| 2026-10-15 | When it becomes your move, the board scrolls your own cards into view — `scrollIntoView({ block: 'nearest' })`, instantly | `'nearest'` scrolls only when the element is not already fully visible, so it is a **no-op on every screen that already fits** — which is most of them. Instant rather than smooth because a control you cannot see is worse than a jump you did not ask for, and `prefers-reduced-motion` is not a question worth asking when the alternative is an invisible card | Shrinking cards to fit the worst case; a manual "scroll down" affordance (the player does not yet know there is anything to scroll to); smooth scrolling (a 40px correction does not want 300ms of animation) |
| 2026-10-15 | **`--card-h: calc(var(--card-w) * 1.4545)` was replaced by `--card-ratio` + `aspect-ratio` on `.kb-card`** — a real, pre-existing bug, not a refactor | A CSS custom property is substituted **where it is declared**: a `calc()` on `:root` resolves against the root's `--card-w` and is then inherited *frozen*, so it does not follow a descendant's override. Every place that shrank `--card-w` (compact hands, the peek tray) got a card the right width and the wrong height — measured at **43×85px, a ratio of 1.98 instead of 1.45**. Invisible against plain black rectangles; glaring the moment real art arrived | A second `.kb-card` rule per context (five places to forget); `height: calc(100% * …)` (needs a definite height, which is the problem); JS measurement (breaks SSR and resize) |
| 2026-10-15 | `.kb-label { margin: 0 }` — the label class dresses `h3`, `p` and `label` | An `h3` at 12px still carries a 1em margin, so every heading cost 24px of nothing on top of the parent's flex gap: **48px across the opponent row and the player's own row**, which on an 844px phone was most of the second row of the hand | Setting the margins at each call site (the same bug, four places to forget) |
| 2026-10-15 | **A peek notice is kept only for the round it arrived in** (`Peek.round`, pruned on insert) | The tray only ever grew: `setPeeks((prev) => [...prev, …])` with no bound meant a player who never tapped *Remember it* accumulated every peek and every draw of the whole game — measured at three cards after one turn, and a dock that eats the screen by round two. Nothing is lost by dropping them at a round boundary: at the reveal every card is face-up, so the reminder has stopped being information | A hard cap with a "+N earlier" note (silently withholds cards the player was shown); clearing on turn change (wipes the opening peeks, the only cards anyone legitimately saw); an effect on the round number (a second place the tray changes shape, and a lint error) |
| 2026-10-15 | **Redis credentials are found by suffix and paired by prefix, in `src/store/env.ts`** | Vercel's Upstash integration names the variables `<PREFIX>_KV_REST_API_URL`/`_TOKEN` (the prefix is picked at install: `STORAGEKOBUL` here), not `UPSTASH_REDIS_REST_*`. Recognising only the latter would make a correct deploy silently fall back to the in-process `Map`, which looks fine for one player and splits rooms across serverless instances. Matching on the suffix means nothing has to be renamed in the Vercel dashboard. The URL and token must share a prefix (never mix two integrations), only `KV_REST_API_TOKEN` matches (the `…_READ_ONLY_TOKEN` ends differently, and the store writes), and keys are sorted so the choice is deterministic. Explicit `UPSTASH_REDIS_REST_*` still wins | Renaming the variables by hand in the dashboard (a manual step to forget on every re-install); hard-coding `STORAGEKOBUL_` (breaks on re-install); taking the first `*_TOKEN` found (could be the read-only one) |
| 2026-10-15 | **The session key is `ROOM_SECRET`, else derived from the Redis token (`src/server/sessionKey.ts`); the old "throw in production if Redis is set but ROOM_SECRET is not" guard was removed** | Symptom: players were kicked from the room seconds into a game. Cause: with no shared key each serverless instance minted its own random one, so a session signed by one instance failed verification on the next, which the client treats as a lost seat. The old guard could not catch it, because it only looked for the `UPSTASH_REDIS_REST_*` names and Vercel's integration uses `<PREFIX>_KV_REST_API_*`. Every instance reads the same Redis token, so every instance derives the same key (HMAC with a fixed label, so the key does not reveal the token) and nothing needs setting in the Vercel dashboard. Trade-off: one secret serves two purposes; a leaked Redis token already exposes every room, so nothing new is exposed | Requiring `ROOM_SECRET` in the dashboard (the owner asked not to touch Vercel); keeping the throw and widening its env check (turns the misconfiguration into a loud 500 but still needs the manual step); a random key per instance (the bug) |
| 2026-10-15 | **The hand is one row that scrolls sideways, not a 2×2 square** | Owner's report: the table felt static and confusing, and the square made it hard to see where a drawn card went. A row reads left to right, gives the player's own cards more width (drawn larger than an opponent's: `19vw`, capped at 88px, which fits four cards on a 320px phone) and saves about 48px of height on a phone. It still never compacts or reorders slots, so position is still the memory game; a penalty card extends the row. The first four fit without scrolling | Keeping the grid and animating it (the owner prefers the row); wrapping a long hand onto a second row (a shape nobody has learned) |
| 2026-10-15 | **Card movement is shown by `src/lib/flights.ts` (pure: compares two snapshots) + `CardFlights.tsx` (draws ghost cards)** | The state is already correct when a snapshot arrives; the ghost only shows where a card came from. The planner reads only what the viewer may already see (counts, the public discard top, `occupied`, `gen`), so it adds no information, and it recognises a pattern or draws **nothing**: a poll gap can swallow several moves, and a wrong animation tells the player a card went somewhere it did not. A layout effect hides the destination before paint (otherwise the card flashes into place and only then flies). Anchors are static (`data-flight` on the three piles and every slot), so both rectangles are read from the new DOM. A ring (`.kb-card--landed`) stays on the arrived card for about 1.2s and is kept under `prefers-reduced-motion`, where the flight itself is skipped | Animating the real elements (a slot's card re-mounts whenever `gen` changes, so there is no stable element to move); an animation library (a dependency for one tween); animating only the destination (cannot show where a card came from) |
| 2026-10-15 | **No turn action until the card preview is closed** (`blocked` in `GameScreen`, `closeFirst` in `ActionBar`) | Owner's request. "Remember it" is the only record of what a player saw, so moving on before closing it is moving on before the card was taken in. While a notice is open the turn buttons are disabled with a stated reason and no table card is pickable. **Exempt:** the opening peek (notices pile up by design, and Ready has its own gate), taps (a race against a deadline), and a King's swap decision (closing the notice would remove the two cards the decision is about). The turn deadline still runs, so an unclosed notice cannot strand a table | Gating the tap (loses the race to a dialog); gating the King decision (decide blind); hiding the buttons instead of disabling them (no reason shown) |
| 2026-10-15 | **Ready is disabled, with the reason printed, while a peek notice for the opening pair is still open** — a *client-side* gate, deliberately, and separate from `blocked` above (which exempts the peek) | Owner's request: "make sure people can't click ready before they close the 2 cards they're seeing at the start." Looking at your own two cards *is* the peek phase, so Ready is the step that throws the look away. A client-side gate is the only honest one available: notices are transient reveals the server keeps no record of (§9.2), so there is no dismissal for the server to enforce; and the 45s peek deadline still readies everyone, so it cannot strand a table. **Still open:** a player who never peeks at all is ungated — closing the notices presupposes there are some. Forcing the peek would make it mandatory, which is a rule change and is raised in §6, not made here | Server-side enforcement (needs stored dismissal state, which §9.2 forbids); a toast that only warns (the owner asked for "can't", not "is discouraged"); hiding the button (a disabled control that says why beats a missing one) |
| 2026-10-15 | **The live-card cue is a ring, not a lift or a pulse of the whole card** (`.kb-card--live`, a 3px→7px `--c-highlight` ring) | The cue means "this is what the current decision is about", and it has to survive being one of four cards the player is memorising. A lift would break the row's baseline and make the hand look ragged for as long as the decision lasts; a scale would change the card's size, which is the one thing that carries position; only a ring leaves the frame exactly where it was. `--c-highlight` because KABOO already owns that colour as "the loudest thing on screen". Set on `Card` only, and chosen in `GameScreen` — see the two traps in §9 | An outline (`outline` is the focus ring's job — two rings on a focused card, and the focus one must win); a border (changes the layout box); a fully lit background (reads as face-up) |
| 2026-10-15 | **You can SEE that an opponent is looking at your card** (`PeekWatch.tsx`: the card lifts and tilts, a ring goes round it, an eye sits on it, and a line of words names who and which slot) — driven by the `looks` list on the projection, and **red when the card is yours, yellow when it is anyone else's** | At a real table you watch an opponent lift your card, even though you can never see its face — so this is information the player legitimately has and the UI was simply not showing. It leaks nothing: a `Look` names a **slot and a reason** (`peek`/`own`/`other`/`king`) and never a face, which is why the whole feature can live in the projection. Red-vs-yellow is the load-bearing part: "someone is looking at MY card" is the one the owner has to notice, and it must not read like a bystander's card being lifted | Revealing what was looked at (that is the whole hidden-information boundary); showing your *own* looks (you already have the "you saw" notice — a ring round the card you just chose says nothing you did not know, so they are filtered out); a per-look toast (a King looks at two and a poll gap can deliver a burst, so the marks are capped at `MAX_AT_ONCE` and the words collapse to one line about the newest) |
| 2026-10-15 | **A new look is found by a monotonic `seq`, and the first view this mounts with is thrown away as a baseline** | Position in a list is not "new": a player who joins late or reloads receives the whole round's `looks` at once, and replaying that history would ring every card on the table for no reason. `PeekWatch` records the highest `seq` it has seen and only acts on `seq > baseline`, so a remount is silent and a genuinely new look is not | Diffing the array (a re-order or a truncated list looks like a new event); a timestamp (the brief forbids trusting client clocks, and these arrive from the server anyway); replaying history (a reload becomes a fireworks display) |
| 2026-10-15 | **The marks are put on the DOM and taken off again, like `CardFlights` — never held as React state** | A re-render must not cancel a mark halfway, and a mark must not survive a card that has moved. Writing the class onto the live element and removing it on a timer means the animation is immune to the poll cadence, and the `data-flight` anchor `Hand` already sets is the address to find the card by. The one exception is a pending King decision, whose two cards stay marked **for as long as the table waits on them**: that is a state, so it is derived from `view.effect.awaitingKingDecision` in an effect keyed on the two refs | A React class toggle (a mid-animation re-render clears it); a CSS animation on a key (restarts when the element re-mounts on `gen` change); marking by card id (a face-down card has no id in the projection) |
| 2026-10-15 | **`.kb-card--selected` lifts with `translate`, and hover/press add to it with `translate` too — never `transform`** | `translate` and `transform` are *separate properties that compose*, so `--selected`'s `translate: 0 -2px` and the hover rule's `translate: 0 -4px` (and `:active`'s `translate: 0 0`) resolve against each other in the ordinary cascade instead of one silently erasing the other. With a single `transform` the last rule to win would decide, and the press state would lose its selected lift. `transform` is left free for a future rotate/scale. Same reason the reduced-motion block resets `translate` **and** `transform` | One `transform` property (states overwrite rather than compose); `top`/`margin` (animates layout every frame) |
| 2026-10-15 | **A claimed tap's intent is derived from `view.tap`, not from button state** — `GameScreen`'s `activeIntent` is `tapPlace`/`tapChoose` while `view.tap.playerId === youId`, and wins over the `none` a button would have set | **A real, pre-existing bug that made the tap unplayable.** A tap is the one decision a player does not start with a button: the claim puts them in it and `legalActions` then reads `TAP_CHOOSE`. Nothing anywhere set `intent` to `'tapChoose'`, so after claiming, every card on the table stayed inert while the bar said "pick the card that matches the top of the pile" — measured in the browser as `ownTappable: 0, allTappable: 0` against a server advertising `['TAP_CHOOSE']`. The tap could then only end on the 8s deadline, which counts as a *wrong tap*: a penalty card, for a button that could not work. After: `ownTappable: 4, allTappable: 8` | A `onIntent('tapChoose')` set in an effect when the tap arrives (an effect that exists only to mirror state the view already carries, and one render late); putting the tap's two steps in `ActionBar`'s `Intent` state (the tap can arrive from another player's claim on your behalf) |

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
(`--dark` / `--soft`), `kb-title`, `kb-label`, `kb-card` (`--down` / `--selected` / `--live` /
`--landed` / `--dimmed` / `--empty` / `--watched` / `--spied`), `kb-eye` (`--yours`), `kb-look-note`,
`kb-table`. `game.css` is layout only and defines no raw values.

Three rules the class bodies encode, so read them there before overriding: **KABOO** is highlight
yellow with black text and an `8px` shadow (never white on yellow — it is 1.3:1); contrast is
`#000` on `#fff`, `#193cb8` on `#dbeafe` (7.4:1), or black on `--c-highlight` (17:1);
`prefers-reduced-motion` collapses `--dur` to `0ms` rather than removing transitions, because card
movement is the game's information channel.

**Card interaction states**, all in the `game.css` card block, and all four are needed at once:
*rest* (`--shadow-sm`) → *hover* (lift `4px`, `--shadow`) → *press* (into the shadow: `box-shadow:
none`, `translate: 0 0`) → *live* (the yellow ring, §7). Hover is gated on
`@media (hover: hover) and (pointer: fine)`; press and live are not, because a touch screen has both.
Under `prefers-reduced-motion` the **state survives and the movement goes**: `--dur` is `0ms`, the
hover lift and the press translation are set to `none`, and `--live` keeps its static `3px` ring with
`animation: none` — a player who asked for no motion still has to be told which card is live.

**Card art.** `public/cards/{rank}{suit}` (`AS`…`KD`, plus `Joker1`/`Joker2`), **public domain**
— Byron Knoll's vector deck, redistributed by `notpeter/Vector-Playing-Cards`; the render script
pins the upstream commit. Each card exists as **`.webp` (what `Card.tsx` requests) and `.png` (the
`onError` fallback)**, both committed; `public/cards/README.md` records the licence and both steps
where the files are. `cardFile()` maps a `PublicCard` to its file, via `setIndexOf` so a second-deck
copy draws the same picture, and the two jokers are told apart by **id** (52/53) because their
`rank` and `suit` are identical. The **back is CSS**, not art: nothing to load for the ten of them on
the table, and a shut card must not read as "a card" from across the table — the back is a diamond
lattice: two crossed `repeating-linear-gradient`s at ±45° over the card field, a `--c-highlight`
medallion rotated 45° on `::before`, and an inner rule on `::after`. Every dimension is a fraction of
`--card-w` (the lattice pitch is `--card-w / 7`), so it holds at any card size rather than being art
pinned to one. The face image overshoots
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
- **The hand is ONE row, side by side, scrolled sideways (owner's call, 2026-10-15; it was a 2×2 square).** Cards are never compacted and slots never reflow, so position still carries the memory game; extra cards extend the row instead of wrapping. Slots 3 and 4 (index 2 and 3) are still the peek pair, now just the last two of the first four. Do not bring the grid back without asking the owner.
- **Every entry in `legalActions` that needs a *slot* chosen must have an `Intent` reachable either from a button or from the view itself.** `ActionBar`'s `Intent` state only knows what a *button* set, and three sub-flows need no button to start: a claimed tap (`TAP_CHOOSE`, derived in `GameScreen` from `view.tap`), and the second half of any two-step choice. This is the shape of the tap bug (§7): the server advertised `TAP_CHOOSE`, the UI had no path to it, and the button-less state looked like "nothing to do" rather than an error. When you add an action, ask **who sets the intent** — and if the answer is "nobody, it just happens", derive it from the projection.
- `:hover` is gated behind `@media (hover: hover) and (pointer: fine)`, and that is not optional. On a touch screen a `:hover` rule matches whatever was **tapped last**, so an ungated card hover leaves a card lit under nobody's finger — and it stays lit until another tap. Verified both ways in the browser: on a `hasTouch: true` context `matchMedia('(hover: hover)')` is `false` and hover does nothing.
- **The peek tray's caption sets the tray's width, which sets the tray's height.** Each notice is a card with a caption under it, so a longer caption widens every item: the 13ch form of the own-card label (`your card · slot 3`) made a 94px item around a 40px card, which was 21px too wide for the heading and the cards to share one 360px row — the heading wrapped above them and the tray went **122px → 208px**, which cost the player the bottom row of the hand the phase is about. Shortening it to `slot 3` brought it to 102px. Measure the tray, not the card, when changing a notice label.
- **The board shrinks when the peek tray opens, and the bottom row of the hand is the row the phase is about.** The "scroll your own cards into view" effect must depend on the tray being open as well as on whose turn it is — the tray opening changes no other dependency, so without it the board gets shorter and the row falls off the bottom silently. Measured against the **viewport**; measuring against the column box reports "0 clipped" while the cards are behind the dock.
- **Card ids in play are a SET, not a range — a jokerless two-deck game deals `{0…51, 54…105}`.** The
  id table is fixed (0–51 set one, 52–53 its jokers, 54–107 set two) because a card id has to mean the
  same physical card in every game — `setIndexOf` maps it to artwork. So `for (let id = 0; id < total;
  id++)` and `id >= total` are both wrong the moment `decks: 2` and `jokers: false` meet, and they fail
  *loudly and wrongly*: adding `decks: 2` to the property fuzz reported four phantom failures —
  "card 52 is in no zone", "card 104 is not in play" — on **every** card, which reads exactly like a
  real card-conservation bug. Ask the engine what it deals (`makeDeck`, wrapped as `deckIds` in
  `tests/invariants.ts`) rather than deriving it from a count. The engine was never at fault; only the
  test's idea of the deck was.
- **A `file:` URL's `pathname` is percent-ENCODED — hand a child process `fileURLToPath(url)`, never
  `url.pathname`.** This checkout lives under `…/Proyek lokal/…`, so `pathname` gives ImageMagick the
  literal string `Proyek%20lokal` and every conversion dies with `could not write …/Proyek%20lokal/…`.
  The bug had been sitting latent in `scripts/cards.mjs` for as long as that script has existed; it
  surfaced only when the new WebP script took the same path. Both now share `pathOf` from `lib-webp.mjs`.
- **Verify a shell assertion before believing it.** `magick compare -metric AE` prints `0 (0)` to
  **stderr**, so comparing its output to the string `"0"` reported all 54 cards as differing. Pipe
  through `awk '{print $1}'` first. A check that fails on *everything* is a broken check, not a broken
  subject — the same lesson as the ids-are-a-set trap above, which also produced a uniform, confident,
  wrong verdict.
- **Without Ably configured the client POLLS about every 2s, so a browser check that waits less than
  that sees nothing and reads as a broken feature.** `PeekWatch` only fires on a *new* `look` arriving
  in a projection, so a probe that peeked and then waited 1.2s found zero marks and looked like the
  whole feature was dead — it was simply between polls. Wait past the interval (3s+) or poll until the
  mark appears. The mark itself is short-lived by design (`WATCH_MS = 1800`, `NOTE_MS = 3200`), so a
  probe must also measure it *while it is up*: sampled late, the same page reports a perfectly clean
  card and the same false conclusion.
- **A CSS transition means a computed style is a snapshot, not the final value.** The `--watched` ring
  is `box-shadow: 0 0 0 3px var(--c-highlight)`, but reading it immediately after the class lands gives
  an interpolated `0.15px 0.15px 0px 2.76px` — and reading it a frame earlier gives the *old* shadow
  first in the list, which looks like the rule never applied. Read computed styles after the transition
  settles, or assert on the class and the rule rather than a mid-flight number.
---

## 10. Next steps

**Next steps** (rewritten 2026-10-16, after the WebP / two-deck / Queen-privacy pass):
1. **Drive the effect sub-flows (7/8/9/10/J/Q/K) in a browser.** These are the last interaction paths
   with no finger on them, and the tap bug (§7) was found the moment one was driven — the engine suite
   is green for all of them, which is exactly what made the tap bug invisible. Check: each button
   reaches its state, each pick lands on the card it named, and *Skip* is offered wherever the engine
   accepts it. **This pass widened the gap**: the Queen swap just changed behaviour and the two-deck
   game doubles every choice, and neither has been played by hand.
2. **The WebP is proven served and decoded** (2026-10-16, production build): only `.webp` was
   requested on a real table, `Content-Type: image/webp`, 264×384, `fallToPng` never fired. What is
   still unmeasured is the **payload saved on a cold cache** across a whole game, and how it behaves
   on a browser without WebP support — the fallback is code-verified, not browser-verified.
3. **M4 — deploy. Blocked on the owner, not on code.** A free Upstash database and an Ably app, plus
   `vercel login` run by the user (`! vercel login` in this session works). Then set the variables from
   `.env.example` in the Vercel dashboard and `vercel --prod`. **Then** prove the adapters (§3): Redis
   and Ably have never crossed a network. Until then treat §2's "M3 done" as provisional.
4. **M4 — real hardware.** Only ever measured in headless Chromium. A real phone brings the home
   indicator, the URL bar and `env(safe-area-inset-*)`, and a real finger is not a mouse. Check: the
   dock clears the home indicator, the hand row stays one row and scrolls sideways, the peek tray's
   *Remember it* is reachable one-handed, the peek-watch ring reads at arm's length, and hover does
   nothing on touch (§9).
5. **M5 — 3 to 8 seats.** Opponents currently render in a scrolling row. The brief wants 3–8 seated
   around the table on desktop while keeping the mobile column; the engine and transport already
   support 8. Budget note: the phone layout is full at three opponents, so a fourth needs the opponent
   row to scroll rather than to grow — and the desktop centre column already overflows at 3+.
6. **A topbar that fits.** It wraps to two rows (82px vs 44px) below about 380px. It no longer clips
   anything, but it costs 38px on exactly the screens that have none to spare.

**Open questions for the user:** §6 #2 (how a multi-round game ends) and #5 (counter-KABOO); plus the
one the peek-gate pass raised, which is **not** an engine flag and so is not in §6 — **should the
opening peek be mandatory?** Ready is currently gated on *closing* the two notices, so a player who
never looks at them is ungated (see the Ready row in §7). Making it mandatory is a rule change, so it
is asked rather than assumed. All three have working defaults, so nothing is blocked.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Kaboo: Rules

Kaboo is a memory-and-reflex card game for **2 to 8 players** with a standard deck. You are dealt four face-down cards you can barely look at, and the goal is to finish the round with the **lowest total** by remembering what you hold, swapping in better cards, and slapping the discard pile faster than everyone else.

This file explains how to play. For developer and agent documentation, see [`AGENTS.md`](./AGENTS.md), which is the source of truth for the implementation.

## Quick start

```bash
bun install
bun run dev        # http://localhost:3000
```

One player creates a room and shares the **room code**. Everyone else opens the site on their own phone or computer, enters a name and the code, and the host starts the game. No accounts.

---

## The goal

Have the **fewest points** at the end of the round. Over several rounds, the player with the lowest cumulative score wins the game.

## Card values

| Card | Points |
|---|---|
| Ace | 1 |
| 2 to 10 | face value |
| Jack, Queen, King | 10 |
| **Red King** (hearts, diamonds) | **-1** |
| Joker *(optional, off by default)* | 0 |

## Setup

- Each player gets **4 cards face down** in a **row**, side by side. The rest of the deck is the **draw pile**, with the top card turned over to start the **discard pile**.
- The cards never move around. If a card leaves the table, its spot stays empty, because **where** your cards are is part of what you have to remember. If you collect extra cards, the row scrolls sideways.
- Each player may look at **cards 3 and 4** (the last two of their four), **once each**, and then memorizes them. Press **Ready** when you are done.
- The player after the dealer goes first. The dealer rotates each round.

## On your turn

Draw the top card of the draw pile **or** take the top card of the discard pile, then do one of:

- **Swap:** replace one of your own cards with it. The replaced card goes face up on the discard pile, and you may **not** look at it first.
- **Discard:** put the drawn card on the discard pile. If it is a power card, its effect triggers.

A card taken from the discard pile must be **swapped in**. You can't take it just to put it back.

### Power cards (effects trigger when you discard them)

| Card | Effect |
|---|---|
| **7 or 8** | Look at one of **your own** cards. |
| **9 or 10** | Look at one **opponent's** card. |
| **Jack** | **Blind-swap** any two cards on the table. |
| **Queen** | Swap one of your cards with any other card. You **may look at** the card you receive. |
| **King** | Look at any two cards, then **decide whether to swap them** and announce your decision. |

## Tapping: the out-of-turn race

At any time, if a card on the table **matches the rank of the top discard**, **any player** may tap the discard pile. This is a race: the **first valid tap wins**.

1. **Tap the discard pile** to claim the match.
2. **Choose the card** you think matches. It can come from **any player's hand**.
3. If it matches, the card is discarded. If you discarded **someone else's** card, you may place one of **your own** cards in the empty spot.

If you choose **wrong**, the card goes back and you draw a **blind penalty card** into your hand. Nobody is told why a tap failed, so a wrong tap can't be used to learn what a card is.

Other tapping details:

- A tap is **too late** once the top of the discard pile has changed.
- Abandoning a claimed tap without choosing a card counts as a **wrong tap**, so you can't claim a tap just to block others.
- Kings match kings by **rank**, so a red King matches a black King for tapping.
- Tapping is **not allowed** during the last-card swap (see below).
- Your hand can grow beyond four cards through penalties. That is expected.

## Ending a round

A round ends in one of three ways.

### 1. KABOO

At the **start of your turn**, if you believe your total is **3 or less**, you may call **KABOO**.

- Every other player then gets exactly **one final turn**.
- If you lose all your cards, you automatically call KABOO.
- You are **not** checked against the 3-point rule when you call. If you are wrong, the penalty punishes you.
- **Counter-KABOO:** after a KABOO, another player may **skip their final turn** to counter-KABOO, trying to score lower than the original caller. A counter-caller is scored like a KABOO caller (below), each player may do it once per round, and it does not extend or restart the final turns.

### 2. The draw pile runs out (house rule)

The moment a player draws the **last card** of the draw pile, the round ends.

- That player may **swap** the last card with one of their own cards, or **decline**.
- The card has **no discard effect**, and no tapping is allowed.
- Then **everyone reveals** their cards and the lowest total wins.
- If the last card is swapped in, it **counts** toward that player's score. If declined, it is set aside and **not scored**.
- If a wrong-tap penalty draws the last card, it goes into that player's hand like any penalty card and the round ends with no swap offered.
- There is **no reshuffle**.

### 3. Safety net

If a round somehow drags on for 500 turns, it is force-ended and scored as above.

## Scoring a round

- The **round winner** (lowest total) scores **0**.
- A **KABOO caller who did not win** adds a **20-point penalty** on top of their hand total.
- Everyone else scores the **sum of their card values**.
- **Ties** go to the tied player who comes first in seat order, counting from the dealer's left.

Scores add up across rounds.

## Ending the game

By default, a game is **5 rounds**, and the lowest cumulative score wins. An alternative setting ends the game when a player reaches **100 points**.

## Timers

Because the game runs on a server with no timers that stay running, deadlines are resolved the next time anyone acts:

- If nobody presses **Ready** during the opening peek within **45 seconds**, the stragglers are readied automatically.
- A disconnected player's turn is played for them automatically, and a seat is never given up once the cards are dealt, so reconnecting restores your seat.

## Optional rules (off by default)

| Rule | What it does |
|---|---|
| **Jokers** | Adds two Jokers, each worth 0. |
| **Matt's pairs** | A matching pair of cards in your hand scores **0** (red Kings excluded). |

## Open rule questions

Nothing is blocked, since each has a working default, but these were not fully defined in the original rules and are waiting on the owner's answer:

1. **How a multi-round game ends** (5 fixed rounds is the current default).
2. **Counter-KABOO details** (the minimal reading above is the current default).

---

*Rules reference: [Kaboo - Rules (gist by dxlbnl)](https://gist.github.com/dxlbnl/54fe34c9d61c89f7c3b0c224ba17a4e5), plus the house rules above.*

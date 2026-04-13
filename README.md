# Water Cycle Challenge

A browser card game about Singapore's water cycle, built for a school project (CSD2150 USI).
2–4 players, ages 7–12, 20 minutes.

Vibecoded with Claude. Almost everything here is by Claude, actually. Insane aura loss, I know.

## Play it
https://bamboo01.github.io/WaterCycleChallenge/water_cycle_challenge.html

Three modes:
- **Local Hotseat** — one device, pass it around the table.
- **Host Online** — create a room, share the 4-letter code, your friends join.
- **Join Online** — type a code, join an existing room.

Online play uses [PeerJS](https://peerjs.com/) for WebRTC peer-to-peer. No server, no accounts, no data collected. The host's browser runs the engine; everyone else's browser is a thin client. If the host closes their tab, the game dies — this is fine for a school demo, less fine for production.

The trivia and flavour text are about Singapore's water story specifically — the Four National Taps, NEWater, the 1963–64 drought, Marina Reservoir, the 17 reservoirs. All facts cross-checked against PUB and NLB Infopedia.

## Rules

### Goal

Be the first player to collect 5 trophies.

### Setup

- Separate the Emergency Response cards. Deal 1 to each player — keep it face-up in front of you.
- Set aside the Crisis and Reservoir Collapse cards.
- Shuffle the rest. Deal 5 cards to each player. These are your hand — keep them hidden.
- **If you want crisis mode:** Add the Crises (2 per extra player + 2: so 4 for 2-player, 6 for 3-player, 8 for 4-player). Add the Reservoir Collapse. Shuffle all cards. This is the Draw Pile.
- Place 3 tokens on the Boss card. That's the Boss's starting HP. The Boss is active from turn 1. Every time the boss is defeated, add an additional HP token to the boss (up to a maximum of 5 HP).

### On your turn

1. Play one Weather card *(optional, max one per turn)*.
2. Take one Main Action *(optional, max one per turn)*. Choose ONE:
   - **Trade Cycle → Trophy:** discard a full Cycle (Evap + Cond + Precip + Collect), take 1 trophy.
   - **Challenge the Boss:** put a full Cycle into the Boss's Bucket, then answer a trivia question (someone reads the back of the Boss card).
     - ✓ Correct → deal 1 damage, take 1 trophy. If the Boss dies, take +1 trophy AND the entire Bucket into your hand.
     - ✗ Wrong → your Cycle stays in the Bucket. Nothing else happens.
3. Draw 2 cards, end your turn.

If your hand is empty, draw 5 instead. If you draw a Crisis or Collapse, resolve it immediately.

### How to survive a Crisis

When you draw a Crisis card, stop drawing and resolve it now.

- Pick at least 1 card from your hand. Any card works — but you must explain to the table how your chosen cards address the disaster.
- The other players vote. Thumbs up or thumbs down.
- **Pass** → draw bonus cards equal to cards spent (up to 3). Discard the Crisis.
- **Fail** → shuffle your whole hand into the deck, draw 5 fresh cards. Shuffle the Crisis back in.
- If your hand is too small, or if you Give Up on purpose — same penalty: hand wiped, draw 5 fresh, Crisis reshuffled.
- If you draw 2 crises, you only need to answer 1. Add the other crisis back to the deck and shuffle.

### Reservoir Collapse

If you draw this: play your Emergency Response to survive. Remove your Emergency Response from the game; the Collapse is reshuffled into the deck.

If you can't defuse: lose ALL your trophies and your entire hand. Draw 5 fresh. Collapse is reshuffled — it can come back.

If you draw a crisis and reservoir collapse, ignore the crisis.

### The Discard Pile

Discarded cards go into a discard pile next to the draw pile. When a Crisis or Collapse is drawn and resolved, shuffle the ENTIRE discard pile back into the draw pile (along with the threat). If both piles are ever empty, the game ends — whoever has the most trophies wins.

### Card reference

| Card | Copies | What it does |
|---|---|---|
| **Resources** (Evap / Cond / Precip / Collect) | 6 of each | One of each = a full Water Cycle. Spend a Cycle to trade for a trophy or challenge the Boss. |
| **Weather** | 3 of each (×10 kinds) | Action cards. See Weather Reference below. |
| **Crisis** | Scales with players | A disaster you drew. Resolve it immediately. |
| **Reservoir Collapse** | 1 | The bomb. Play your Emergency Response or lose everything. |
| **Emergency Response** | 1 per player | Defuses a Reservoir Collapse. Dealt at the start. |

### Weather cards

| Card | Effect |
|---|---|
| **Monsoon** | Draw 2 extra cards right now. |
| **Forecast** | Peek at the top 3 cards of the draw pile. Don't show anyone. |
| **NEWater** | Wild card — substitutes for any ONE missing Resource when you spend a Cycle. |
| **Reservoir** | Keep in hand. When someone targets you with a Weather card, play this to cancel it. |
| **Dry Spell** | Pick a player. They skip their next turn. |
| **Diversion** | Pick a player. Take one random card from their hand. |
| **Evaporation Surge** | Pick a player. They choose and discard 2 cards from their own hand. |
| **Pipe Burst** | Pick a player. Look at their hand, take 1 card. |
| **Pipe Leakage** | Pick a player. They choose 1 card to put into the Boss's Bucket. |
| **Water Rationing** | Everyone (including you) shuffles their hand into the deck and refills back to 5 cards. Emergency Response cards are kept. |

### Quick tips for new players

- Trading a Cycle for a trophy is safe. Challenging the Boss is risky — but the Boss's Bucket grows every time someone attacks, and whoever kills it claims the whole pile.
- Save your Emergency Response. You only get one, and the Reservoir Collapse can strike at any time.
- Hold onto Reservoir cards. They're the only way to cancel someone else's Weather attack.
- NEWater is precious. It lets you complete a Cycle when you're missing one Resource. Don't waste it.
- For your Crisis explanation: be creative! The other players are the judges. Good answers earn bonus cards.

## Files

```
water_cycle_challenge.html        # the game (open in browser)
game.js                           # pure engine — no DOM, deterministic, testable
tests/engine.test.js              # 23 scenario tests; run with `node tests/engine.test.js`
WaterCycleChallenge_Rulebook.docx # the printed rulebook for the physical version
water_cycle_challenge.hotseat.backup.html  # snapshot of the pre-online version
```

The engine is fully serializable — same seed produces an identical game, which is what makes the online host/client model work without trust.

## Architecture (for the curious)

- `game.js` exports `createGame`, `applyIntent`, `viewFor`, `isGameOver`. Pure functions over a single `state` object.
- The browser client (inline in the HTML) is a thin render-from-state loop with three swappable transports: hotseat, host, client. Same render code drives all three.
- All mid-turn interrupts (target picker, peer vote, boss trivia, reservoir cancel, etc.) are modelled as a single `state.activePrompt`. The engine refuses normal intents while a prompt is active and only accepts a `PROMPT_RESPONSE` from the right player.
- Cards have stable IDs (`c0001`, `c0002`, …) so intents reference cards by ID instead of array index — no race conditions over the network.
- `viewFor(state, playerIndex)` redacts hidden info before sending: opponent hands become `null`, deck shows only its length, the boss-question prompt strips the `correct` field. The host can't accidentally leak.

## Running tests

```
node tests/engine.test.js
```

Should print `23/23 passed`. Covers determinism, view redaction, every weather effect, the crisis flow with peer voting, both Reservoir Collapse paths, win conditions, and three negative-path validations.

## Known limitations

- Host disconnect = game dies. No reconnect.
- No TURN server, so on hostile NATs (some school/corporate wifi) the WebRTC handshake may fail. Local Hotseat works on any device as a fallback.
- The host's browser runs the engine, so a player with devtools open on the host machine can technically read the full deck. Doesn't matter for a school demo.
- It's a school project. Please don't grade it as production software.

## Credit

Game design: mine. Code: vibecoded with Claude  Opus 4.6. Singapore water facts: PUB and the NLB Infopedia. Aura loss: also mine.

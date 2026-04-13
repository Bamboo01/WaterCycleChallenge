// game.js — Water Cycle Challenge pure game engine.
//
// No DOM. No network. Just (state, intent) → (state, events).
//
// Design contract:
// - State is fully serializable (no functions, no closures, no class instances).
//   The host can JSON.stringify it, snapshot it, broadcast it.
// - All randomness flows through state.rngState (mulberry32). Same seed +
//   same intent stream = same game. This is what makes online play verifiable
//   and gives us reproducible bug reports.
// - Mid-resolution interrupts (target picker, crisis card pick, peer vote,
//   boss trivia, reservoir cancel, etc.) are modelled as a single
//   `state.activePrompt`. While a prompt is active the engine refuses normal
//   intents — the host must route a PROMPT_RESPONSE intent back from the
//   correct player(s).
// - Cards have stable string IDs (`c0001`, `c0002`, …) so intents reference
//   cards by ID, not array index. Indices shift as hands mutate; over the
//   network that race is not OK.
// - The engine MUTATES state in place. The host clones before broadcast if
//   it wants snapshots. Pure-functional was tempting but doubles the line
//   count for a school project.
//
// Public API (all on `WaterCycleGame`):
//   createGame({ mode, playerCount, playerNames?, seed? }) → state
//   applyIntent(state, playerIndex, intent)               → { ok, error?, events }
//   viewFor(state, playerIndex)                           → redacted view
//   isGameOver(state)                                     → null | { winner, reason }
//   CARD_DATA                                             → { resources, weathers, crises, bossQuestions }
//
// Intent shapes (top-level — only valid when state.activePrompt is null):
//   { type: 'TRADE_CYCLE' }
//   { type: 'CHALLENGE_BOSS' }
//   { type: 'PLAY_WEATHER', cardId }
//   { type: 'END_TURN' }
//
// Intent shapes (prompt responses — only valid when state.activePrompt is set):
//   { type: 'PROMPT_RESPONSE', promptId, value }
//
// Where `value` depends on the prompt kind — see resolvePrompt() below for
// the exact contract per kind.

(function (global) {
  'use strict';

  // ============================================================
  // CARD DATA — single source of truth, lifted from the hotseat HTML.
  // ============================================================

  const RESOURCES = [
    { type: 'evap',    name: 'Evaporation',   desc: 'Sun heats water into vapour',
      flavour: 'The sun heats water in oceans, rivers, and reservoirs, turning it into invisible water vapour that rises into the sky.' },
    { type: 'cond',    name: 'Condensation',  desc: 'Vapour cools into cloud droplets',
      flavour: 'As water vapour rises and cools, it changes back into tiny droplets that cluster together to form clouds.' },
    { type: 'precip',  name: 'Precipitation', desc: 'Rain, snow, or hail falls',
      flavour: 'When cloud droplets grow heavy enough, they fall as rain, snow, or hail. Singapore gets around 2,400mm of rain each year.' },
    { type: 'collect', name: 'Collection',    desc: 'Water gathers in reservoirs',
      flavour: 'Rainwater flows into drains, rivers, and reservoirs. Singapore has 17 reservoirs, covering two-thirds of its land as catchment.' },
  ];

  const CRISES = [
    { type: 'crisis', name: 'Drought',       desc: 'Explain how your cards address a drought.',
      flavour: 'A dry spell is 15+ days with less than 1mm of rain. Singapore had to ration water during droughts in the 1960s.' },
    { type: 'crisis', name: 'Flood',         desc: 'Explain how your cards address flooding.',
      flavour: 'Intense rainfall can overwhelm drains and cause flash floods. Climate change is making extreme rainfall more common.' },
    { type: 'crisis', name: 'Heatwave',      desc: 'Explain how your cards address a heatwave.',
      flavour: 'Rising temperatures mean more water evaporates from reservoirs before it can be used.' },
    { type: 'crisis', name: 'Contamination', desc: 'Explain how your cards address contamination.',
      flavour: 'Littering and pollution in drains can make water unsafe. Keeping waterways clean is everyone\'s job.' },
  ];

  const WEATHERS = [
    { type: 'weather', name: 'Monsoon',           effect: 'monsoon',      desc: 'You draw 2 extra this turn',
      flavour: 'Singapore has two monsoon seasons. Heavy rainfall replenishes reservoirs but also risks floods.' },
    { type: 'weather', name: 'Forecast',          effect: 'peek',         desc: 'Peek top 3 cards',
      flavour: 'Meteorological Service Singapore tracks weather so the country can prepare for storms and dry spells.' },
    { type: 'weather', name: 'NEWater',           effect: 'wild',         desc: 'Substitutes for 1 missing Resource in a cycle trade',
      flavour: 'NEWater is used water purified by reverse osmosis and UV. It meets up to 40% of Singapore\'s water needs — filling the gap when natural sources fall short.' },
    { type: 'weather', name: 'Reservoir',         effect: 'reservoir',    desc: 'Reactive: cancel a Weather played against you',
      flavour: 'Marina Reservoir, opened in 2008, was Singapore\'s first city reservoir and a key flood control project.' },
    { type: 'weather', name: 'Dry Spell',         effect: 'skipTurn',     desc: 'Pick a player — they skip their next turn',
      flavour: 'A dry spell locks everything up. No rain, no collection — just waiting for the weather to change.' },
    { type: 'weather', name: 'Diversion',         effect: 'steal',        desc: 'Take 1 random card from any player',
      flavour: 'Diverting water from one catchment to another is a real engineering challenge. Sometimes nature does it for us.' },
    { type: 'weather', name: 'Evaporation Surge', effect: 'forceDiscard', desc: 'Pick a player — they choose and discard 2 cards from their own hand',
      flavour: 'Hotter weather means more water lost to the sky before it can be used. A real climate-change concern.' },
    { type: 'weather', name: 'Pipe Leakage',      effect: 'leak',         desc: "Pick a player — they choose 1 card from their hand to feed to the Boss's Bucket",
      flavour: 'Old pipes weep water into the ground. What is lost from the system becomes a liability — and liabilities accumulate until someone settles them.' },
    { type: 'weather', name: 'Pipe Burst',        effect: 'pickSteal',    desc: "Look at a player's hand, take 1 card",
      flavour: 'Old infrastructure fails. PUB replaces pipes constantly to keep Singapore\'s water loop tight.' },
    { type: 'weather', name: 'Water Rationing',   effect: 'ration',       desc: 'Everyone resets to 5 cards (Emergency Response is kept)',
      flavour: 'Singapore rationed water during the 1963-64 drought. A reminder of why water security matters.' },
  ];

  const COLLAPSE_TEMPLATE = {
    type: 'collapse', name: 'Reservoir Collapse',
    desc: 'Play Emergency Response or lose all trophies and hand',
    flavour: 'A catastrophic failure of water infrastructure. Singapore\'s diversified Four National Taps exist precisely to prevent any single point of failure.',
  };

  const EMERGENCY_TEMPLATE = {
    type: 'emergency', name: 'Emergency Response',
    desc: 'Defuses Reservoir Collapse',
    flavour: 'PUB maintains emergency protocols for major infrastructure failures. Redundancy is the backbone of water security.',
  };

  const BOSS_QUESTIONS = [
    { q: 'Which stage turns liquid water into vapour?', a: ['Evaporation','Condensation','Precipitation','Collection'], correct: 0 },
    { q: 'What process forms clouds from water vapour?', a: ['Evaporation','Condensation','Precipitation','Collection'], correct: 1 },
    { q: 'Rain, snow, and hail are forms of which stage?', a: ['Evaporation','Condensation','Precipitation','Collection'], correct: 2 },
    { q: 'What gives the water cycle its energy?', a: ['Wind','Gravity','The Sun','Lightning'], correct: 2 },
    { q: 'Clouds are actually made of what?', a: ['Gas','Tiny liquid water droplets','Dust','Ice only'], correct: 1 },
    { q: 'Which speeds up evaporation?', a: ['Cold temperature','Heat & wind','Darkness','Small surface area'], correct: 1 },
    { q: 'When water vapour cools, it turns back into?', a: ['Snow','Ice','Liquid droplets','Gas'], correct: 2 },
    { q: 'Which of these is NOT precipitation?', a: ['Rain','Snow','Hail','Fog'], correct: 3 },
    { q: 'Water in rivers flows to?', a: ['The moon','Reservoirs & the sea','The sky','Underground forever'], correct: 1 },
    { q: 'Did Singapore ever experience hail?', a: ['Never','Yes, in 2014','Every year','Only in the 1800s'], correct: 1 },
    { q: 'How many National Taps does Singapore have?', a: ['Two','Three','Four','Five'], correct: 2 },
    { q: 'NEWater is which of the Four National Taps?', a: ['Imported','Local catchment','Reclaimed water','Desalinated'], correct: 2 },
    { q: 'Where does imported water come from?', a: ['Indonesia','Malaysia (Johor)','Thailand','Australia'], correct: 1 },
    { q: 'Which National Tap uses seawater?', a: ['NEWater','Local catchment','Imported','Desalinated'], correct: 3 },
    { q: 'Desalination removes what from seawater?', a: ['Bacteria','Salt and minerals','Sand','Oxygen'], correct: 1 },
    { q: 'Which tap catches rainwater in Singapore?', a: ['Local catchment','Imported','NEWater','Desalinated'], correct: 0 },
    { q: 'What does PUB stand for?', a: ['People United for Blue','Public Utilities Board','Pure Usable Balance','Protected Urban Basins'], correct: 1 },
    { q: 'How many reservoirs does Singapore have today?', a: ['5','10','17','25'], correct: 2 },
    { q: "Singapore's first city reservoir is named what?", a: ['MacRitchie','Marina Reservoir','Bedok','Kranji'], correct: 1 },
    { q: 'Which technology purifies NEWater?', a: ['Boiling','Reverse osmosis & UV','Sand filtering','Freezing'], correct: 1 },
    { q: 'PUB aims to expand catchment to what % of land by 2060?', a: ['50%','70%','90%','100%'], correct: 2 },
    { q: "Singapore's catchment area is roughly what fraction of its land?", a: ['One-tenth','One-third','Two-thirds','All of it'], correct: 2 },
    { q: 'What is the ABC Waters Programme about?', a: ['Teaching the alphabet','Active, Beautiful, Clean waters','A building code','A school subject'], correct: 1 },
    { q: 'What does a dry spell in Singapore mean?', a: ['1 day','5 days','15+ days with <1mm rain','A whole year'], correct: 2 },
    { q: 'Climate change is expected to do what to Singapore rainfall?', a: ['Make it vanish','Intensify extremes','Stay the same','Only decrease'], correct: 1 },
    { q: 'When is Singapore World Water Day celebrated?', a: ['January','March','June','October'], correct: 1 },
    { q: "PUB's 10-Litre Challenge asks you to?", a: ['Drink 10L daily','Save 10L of water a day','Waste 10L','Carry 10L to school'], correct: 1 },
    { q: 'Which helps prevent water pollution?', a: ['Littering in drains','Dumping oil','Throwing rubbish in bins','Washing cars in rivers'], correct: 2 },
    { q: 'Littering in drains affects which stage most?', a: ['Evaporation','Condensation','Precipitation','Collection'], correct: 3 },
    { q: 'Which action saves water?', a: ['Running taps while brushing','Long showers','Turning off taps when not in use','Ignoring leaks'], correct: 2 },
    { q: "Who was PUB's 1970s water-saving cartoon mascot?", a: ['Bobo the Elephant','Sammy the Seal','Max the Monkey','Olly the Otter'], correct: 0 },
    { q: 'Singapore rationed water during which decade?', a: ['1920s','1960s','1990s','2020s'], correct: 1 },
    { q: 'Marina Barrage helps with?', a: ['Flood control & water supply','Cooking food','Power generation only','Space exploration'], correct: 0 },
    { q: 'About how many litres of water does each person in Singapore use daily?', a: ['50L','150L','500L','1000L'], correct: 1 },
    { q: 'Plants release water vapour through which process?', a: ['Breathing','Transpiration','Swimming','Freezing'], correct: 1 },
  ];

  // ============================================================
  // RNG — mulberry32. Returns a float in [0, 1). State is one uint32.
  // We persist the state in `state.rngState` and pass it explicitly.
  // ============================================================

  function rngNext(state) {
    let t = (state.rngState += 0x6D2B79F5) >>> 0;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  function rngInt(state, n) {
    return Math.floor(rngNext(state) * n);
  }

  function shuffleInPlace(arr, state) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = rngInt(state, i + 1);
      const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    }
  }

  // ============================================================
  // CARD ID FACTORY — every card instance gets a stable id.
  // ============================================================

  function makeCard(state, template) {
    state.cardIdCounter++;
    const id = 'c' + String(state.cardIdCounter).padStart(4, '0');
    return Object.assign({ id }, template);
  }

  function findCardInHand(player, cardId) {
    return player.hand.findIndex(c => c.id === cardId);
  }

  // ============================================================
  // STATE FACTORY
  // ============================================================

  function createGame(opts) {
    const mode = (opts && opts.mode) || 'crisis';
    const playerCount = (opts && opts.playerCount) || 2;
    const seed = (opts && typeof opts.seed === 'number')
      ? (opts.seed >>> 0)
      : (Math.floor(Math.random() * 0xFFFFFFFF) >>> 0);
    const playerNames = (opts && opts.playerNames) || null;

    if (playerCount < 2 || playerCount > 4) {
      throw new Error('playerCount must be 2..4');
    }
    if (mode !== 'crisis' && mode !== 'chill') {
      throw new Error('mode must be crisis or chill');
    }

    const state = {
      schema: 1,
      mode,
      seed,                  // immutable; for replay
      rngState: seed,        // mutates as RNG is consumed
      cardIdCounter: 0,
      players: [],
      current: 0,
      deck: [],
      discard: [],
      boss: null,
      bossKills: 0,
      skipTurns: {},
      weatherPlayed: false,
      mainActionUsed: false,
      drawPending: null,
      activePrompt: null,
      pendingBossQuestion: null,
      pendingCrisisCard: null,
      log: [],
      winner: null,
      turnCounter: 0,
      _promptIdCounter: 0,
    };

    for (let i = 0; i < playerCount; i++) {
      state.players.push({
        index: i,
        name: (playerNames && playerNames[i]) || ('Player ' + (i + 1)),
        hand: [],
        trophies: 0,
        out: false,
      });
    }

    buildDeck(state);
    dealInitialHands(state);
    activateBoss(state);
    pushLog(state, `Game started — ${mode === 'crisis' ? 'Crisis Mode' : 'Chill Mode'}, ${playerCount} players. Seed: ${seed}.`, 'info');
    pushLog(state, `${currentPlayer(state).name}'s turn.`, 'info');
    return state;
  }

  function buildDeck(state) {
    // 6 of each Resource, 3 of each Weather (10 kinds → 30 weather cards).
    for (let i = 0; i < 6; i++) {
      RESOURCES.forEach(r => state.deck.push(makeCard(state, r)));
    }
    for (let i = 0; i < 3; i++) {
      WEATHERS.forEach(w => state.deck.push(makeCard(state, w)));
    }
    if (state.mode === 'crisis') {
      const crisisCount = (state.players.length - 1) * 2 + 2;
      for (let i = 0; i < crisisCount; i++) {
        state.deck.push(makeCard(state, CRISES[i % CRISES.length]));
      }
      state.deck.push(makeCard(state, COLLAPSE_TEMPLATE));
    }
    shuffleInPlace(state.deck, state);
  }

  function dealInitialHands(state) {
    state.players.forEach(p => {
      for (let i = 0; i < 5; i++) {
        const c = drawNoCrisis(state);
        if (c) p.hand.push(c);
      }
      if (state.mode === 'crisis') {
        p.hand.push(makeCard(state, EMERGENCY_TEMPLATE));
      }
    });
  }

  // ============================================================
  // VIEW — redact hidden info before sending to a client.
  // ============================================================

  function viewFor(state, playerIndex) {
    return {
      schema: state.schema,
      mode: state.mode,
      current: state.current,
      turnCounter: state.turnCounter,
      weatherPlayed: state.weatherPlayed,
      mainActionUsed: state.mainActionUsed,
      deckCount: state.deck.length,
      deckCrises: state.deck.filter(c => c.type === 'crisis').length,
      deckCollapses: state.deck.filter(c => c.type === 'collapse').length,
      discardCount: state.discard.length,
      boss: state.boss
        ? { hp: state.boss.hp, maxHp: state.boss.maxHp, bucketCount: state.boss.pool.length }
        : null,
      bossKills: state.bossKills,
      players: state.players.map(p => ({
        index: p.index,
        name: p.name,
        trophies: p.trophies,
        handCount: p.hand.length,
        out: p.out,
        // Only the requesting player sees their own hand in full.
        hand: p.index === playerIndex ? p.hand.map(cloneCard) : null,
      })),
      activePrompt: redactPrompt(state.activePrompt, playerIndex),
      log: state.log.slice(-30),
      winner: state.winner,
    };
  }

  function cloneCard(c) {
    // Defensive: clients should never hold engine references.
    return Object.assign({}, c);
  }

  function redactPrompt(prompt, playerIndex) {
    if (!prompt) return null;
    // For BOSS_ANSWER we never send the `correct` field to anyone —
    // it lives in state.pendingBossQuestion which is server-only.
    const safe = {
      id: prompt.id,
      kind: prompt.kind,
      forPlayer: prompt.forPlayer,    // -1 = all players (e.g. PEER_VOTE)
      payload: prompt.payload,
      // Indicate whether *you* still need to act.
      youMustAct:
        prompt.forPlayer === playerIndex ||
        (prompt.forPlayer === -1 && !(prompt.collected && prompt.collected[playerIndex] !== undefined)),
    };
    // Multi-player prompts (PEER_VOTE) need voter routing info on the client
    // side so the next-viewer logic can pick the right voter. Not sensitive.
    if (prompt.voters)   safe.voters   = prompt.voters.slice();
    if (prompt.collected) safe.collected = Object.assign({}, prompt.collected);
    if (prompt.preview)  safe.preview  = { cardIds: prompt.preview.cardIds.slice() };
    return safe;
  }

  function isGameOver(state) {
    return state.winner;
  }

  // ============================================================
  // INTENT DISPATCHER
  // ============================================================

  function applyIntent(state, playerIndex, intent) {
    if (state.winner) {
      return fail('Game is over.');
    }
    if (!intent || typeof intent.type !== 'string') {
      return fail('Malformed intent.');
    }

    // Prompt response path — only valid when an active prompt expects this player.
    if (intent.type === 'PROMPT_RESPONSE') {
      if (!state.activePrompt) return fail('No prompt is active.');
      if (state.activePrompt.id !== intent.promptId) return fail('Prompt id mismatch (stale).');
      const allowed =
        state.activePrompt.forPlayer === playerIndex ||
        state.activePrompt.forPlayer === -1;
      if (!allowed) return fail('Not your prompt.');
      return runWithEvents(state, () => resolvePrompt(state, playerIndex, intent.value));
    }

    // Preview channel — defender of a CRISIS_CARDS prompt streams their
    // in-progress selection so spectators see live updates. Does not advance
    // state and never logs; the host still re-broadcasts the view.
    if (intent.type === 'PROMPT_PREVIEW') {
      if (!state.activePrompt) return fail('No prompt is active.');
      if (state.activePrompt.id !== intent.promptId) return fail('Prompt id mismatch (stale).');
      if (state.activePrompt.kind !== 'CRISIS_CARDS') return fail('Preview not supported for this prompt.');
      if (state.activePrompt.forPlayer !== playerIndex) return fail('Not your prompt.');
      const handIds = new Set((state.activePrompt.payload.hand || []).map(c => c.id));
      const cardIds = (intent.value && Array.isArray(intent.value.cardIds))
        ? intent.value.cardIds.filter(id => handIds.has(id))
        : [];
      state.activePrompt.preview = { cardIds };
      return { ok: true, events: [] };
    }

    // Top-level intents are blocked while a prompt is active.
    if (state.activePrompt) {
      return fail('Resolve the active prompt first.');
    }
    if (playerIndex !== state.current) {
      return fail('Not your turn.');
    }

    switch (intent.type) {
      case 'TRADE_CYCLE':    return runWithEvents(state, () => doTradeCycle(state));
      case 'CHALLENGE_BOSS': return runWithEvents(state, () => doChallengeBoss(state));
      case 'PLAY_WEATHER':   return runWithEvents(state, () => doPlayWeather(state, intent.cardId));
      case 'END_TURN':       return runWithEvents(state, () => doEndTurn(state));
      default:               return fail('Unknown intent type: ' + intent.type);
    }
  }

  function fail(error) {
    return { ok: false, error, events: [] };
  }

  // runWithEvents collects log entries pushed during dispatch so the host
  // can broadcast just the delta. Each entry has {msg, kind, ts}.
  function runWithEvents(state, fn) {
    const before = state.log.length;
    try {
      fn();
    } catch (e) {
      return { ok: false, error: e && e.message || String(e), events: [] };
    }
    return { ok: true, events: state.log.slice(before) };
  }

  function pushLog(state, msg, kind) {
    state.log.push({ ts: state.log.length, msg, kind: kind || '' });
  }

  // ============================================================
  // CORE HELPERS
  // ============================================================

  function currentPlayer(state) {
    return state.players[state.current];
  }

  function discardCards(state, cards) {
    for (const c of cards) state.discard.push(c);
  }

  function sweepDiscardToDeck(state) {
    // Rulebook: when a Crisis or Collapse is resolved, the entire discard pile
    // shuffles back into the draw pile.
    if (state.discard.length === 0) return;
    state.deck.push.apply(state.deck, state.discard);
    state.discard = [];
    shuffleInPlace(state.deck, state);
  }

  function drawCard(state) {
    if (state.deck.length === 0) {
      if (state.discard.length === 0) return null;
      state.deck = state.discard;
      state.discard = [];
      shuffleInPlace(state.deck, state);
      pushLog(state, 'Draw pile empty — discard reshuffled.', 'info');
    }
    return state.deck.pop();
  }

  function drawNoCrisis(state) {
    // Used at deal time and as crisis-bonus draws. Pulls the topmost
    // non-threat card. If only threats are left, reshuffle discard once.
    const grab = () => {
      for (let i = state.deck.length - 1; i >= 0; i--) {
        if (state.deck[i].type !== 'crisis' && state.deck[i].type !== 'collapse') {
          return state.deck.splice(i, 1)[0];
        }
      }
      return null;
    };
    let c = grab();
    if (c) return c;
    if (state.discard.length === 0) return null;
    state.deck.push.apply(state.deck, state.discard);
    state.discard = [];
    shuffleInPlace(state.deck, state);
    pushLog(state, 'Draw pile held only threats — discard reshuffled.', 'info');
    return grab();
  }

  function hasFullCycle(hand) {
    const types = ['evap','cond','precip','collect'];
    const missing = types.filter(t => !hand.some(c => c.type === t));
    if (missing.length === 0) return true;
    if (missing.length === 1 && hand.some(c => c.effect === 'wild')) return true;
    return false;
  }

  // Pulls a full cycle out of `hand` and returns the cards. Mutates the hand.
  // NEWater can stand in for exactly one missing Resource.
  function takeCycle(hand) {
    const types = ['evap','cond','precip','collect'];
    const taken = [];
    for (const t of types) {
      let i = hand.findIndex(c => c.type === t);
      if (i < 0) {
        i = hand.findIndex(c => c.effect === 'wild');
        if (i < 0) {
          // Restore and bail.
          hand.push.apply(hand, taken);
          return null;
        }
      }
      taken.push(hand.splice(i, 1)[0]);
    }
    return taken;
  }

  function wipeAndRefill(state, player, count) {
    // Reset a player to a fresh 5-card hand. Emergency Response is preserved
    // (it's a personal asset, kept face-up per the rulebook). The discard
    // pile is also swept into the deck — wipeAndRefill is only ever called
    // from a Crisis/Collapse resolution path, where the rulebook says the
    // discard returns to the deck.
    if (count === undefined) count = 5;
    const kept  = player.hand.filter(c => c.type === 'emergency');
    const wiped = player.hand.filter(c => c.type !== 'emergency');
    if (wiped.length) state.deck.push.apply(state.deck, wiped);
    player.hand = kept;
    if (state.discard.length) {
      state.deck.push.apply(state.deck, state.discard);
      state.discard = [];
    }
    shuffleInPlace(state.deck, state);
    for (let i = 0; i < count; i++) {
      const c = drawNoCrisis(state);
      if (!c) break;
      player.hand.push(c);
    }
  }

  // ============================================================
  // TOP-LEVEL ACTIONS
  // ============================================================

  function doTradeCycle(state) {
    if (state.mainActionUsed) throw new Error('Main action already used this turn.');
    const p = currentPlayer(state);
    if (!hasFullCycle(p.hand)) throw new Error('No full cycle in hand.');
    const spent = takeCycle(p.hand);
    if (!spent) throw new Error('takeCycle returned null after gate — engine bug.');
    discardCards(state, spent);
    p.trophies++;
    state.mainActionUsed = true;
    pushLog(state, `${p.name} completed the water cycle → trophy.`, 'good');
    checkWin(state);
  }

  function doChallengeBoss(state) {
    if (state.mainActionUsed) throw new Error('Main action already used this turn.');
    if (!state.boss) throw new Error('No active Boss.');
    const p = currentPlayer(state);
    if (!hasFullCycle(p.hand)) throw new Error('No full cycle in hand.');
    const spent = takeCycle(p.hand);
    if (!spent) throw new Error('takeCycle returned null after gate — engine bug.');
    state.boss.pool.push.apply(state.boss.pool, spent);
    state.mainActionUsed = true;
    pushLog(state, `${p.name} fed a full cycle to the Boss's Bucket and challenged it.`, 'info');
    // Pick a question. Server keeps the correct answer; client only sees q + choices.
    const q = BOSS_QUESTIONS[rngInt(state, BOSS_QUESTIONS.length)];
    state.pendingBossQuestion = { q: q.q, choices: q.a, correct: q.correct };
    setPrompt(state, {
      kind: 'BOSS_ANSWER',
      forPlayer: state.current,
      payload: { question: q.q, choices: q.a, bossHp: state.boss.hp },
    });
  }

  function doPlayWeather(state, cardId) {
    if (state.weatherPlayed) throw new Error('Weather already played this turn.');
    const p = currentPlayer(state);
    const idx = findCardInHand(p, cardId);
    if (idx < 0) throw new Error('Card not in hand.');
    const card = p.hand[idx];
    if (card.type !== 'weather') throw new Error('Not a weather card.');

    // Discard the card up front. From here on it's gone from the hand
    // regardless of whether the effect lands.
    p.hand.splice(idx, 1);
    discardCards(state, [card]);
    state.weatherPlayed = true;
    pushLog(state, `${p.name} played ${card.name}.`, 'info');

    switch (card.effect) {
      case 'monsoon':       return startDrawSequence(state, 2, { after: 'NONE' });
      case 'peek':          return doPeek(state);
      case 'wild':          // Played standalone is wasted — NEWater is consumed inside takeCycle.
        pushLog(state, `${p.name} wasted NEWater by playing it standalone.`, 'info');
        return;
      case 'reservoir':     // Reactive only — playing it now just discards it.
        pushLog(state, `${p.name} wasted a Reservoir card.`, 'info');
        return;
      case 'skipTurn':      return promptTarget(state, card.name, 'WEATHER_SKIP');
      case 'steal':         return promptTarget(state, card.name, 'WEATHER_STEAL');
      case 'forceDiscard':  return promptTarget(state, card.name, 'WEATHER_FORCE_DISCARD');
      case 'leak':          return promptTarget(state, card.name, 'WEATHER_LEAK');
      case 'pickSteal':     return promptTarget(state, card.name, 'WEATHER_PICK_STEAL');
      case 'ration':        return doRation(state);
      default:              throw new Error('Unknown weather effect: ' + card.effect);
    }
  }

  function doEndTurn(state) {
    const p = currentPlayer(state);
    const empty = p.hand.length === 0;
    const drawCount = empty ? 5 : 2;
    if (empty) pushLog(state, `${p.name} has no cards — drawing 5 to recover.`, 'info');
    startDrawSequence(state, drawCount, { after: 'NEXT_TURN' });
  }

  // ============================================================
  // WEATHER EFFECT IMPLEMENTATIONS (non-targeted)
  // ============================================================

  function doPeek(state) {
    // Engine reveals top 3 cards directly via a one-shot prompt. The player
    // acks the modal client-side; the engine doesn't really need a response,
    // but we use a prompt so the host can route the reveal cleanly.
    const top3 = state.deck.slice(-3).reverse().map(cloneCard);
    if (top3.length === 0) {
      pushLog(state, 'Forecast on an empty deck — wasted.', 'info');
      return;
    }
    setPrompt(state, {
      kind: 'PEEK_RESULT',
      forPlayer: state.current,
      payload: { cards: top3 },
    });
  }

  function doRation(state) {
    pushLog(state, `${currentPlayer(state).name} declared Water Rationing! Everyone resets to 5 cards.`, 'info');
    const alive = state.players.filter(p => !p.out);
    alive.forEach(p => {
      const kept  = p.hand.filter(c => c.type === 'emergency');
      const wiped = p.hand.filter(c => c.type !== 'emergency');
      if (wiped.length) state.deck.push.apply(state.deck, wiped);
      p.hand = kept;
    });
    shuffleInPlace(state.deck, state);
    alive.forEach(p => {
      const need = Math.max(0, 5 - p.hand.length);
      for (let i = 0; i < need; i++) {
        const c = drawNoCrisis(state);
        if (!c) break;
        p.hand.push(c);
      }
    });
  }

  // ============================================================
  // TARGET PICK + RESERVOIR REACTIVE CHECK
  // ============================================================

  function promptTarget(state, attackName, kind) {
    const opts = state.players
      .filter(p => p.index !== state.current && !p.out)
      .map(p => ({ index: p.index, name: p.name, handCount: p.hand.length, trophies: p.trophies }));
    if (opts.length === 0) {
      pushLog(state, `${attackName} fizzled — no valid targets.`, 'info');
      return;
    }
    if (opts.length === 1) {
      // Auto-pick the only option.
      return afterTargetChosen(state, kind, attackName, opts[0].index);
    }
    setPrompt(state, {
      kind: 'PICK_TARGET',
      forPlayer: state.current,
      payload: { attackName, options: opts },
      context: { followUp: kind, attackName },
    });
  }

  function afterTargetChosen(state, kind, attackName, targetIndex) {
    // Offer the target a Reservoir cancel before any effect lands.
    const target = state.players[targetIndex];
    const hasReservoir = target.hand.some(c => c.effect === 'reservoir');
    if (hasReservoir) {
      setPrompt(state, {
        kind: 'RESERVOIR_RESPONSE',
        forPlayer: targetIndex,
        payload: { attackName, attackerName: currentPlayer(state).name },
        context: { followUp: kind, attackName, targetIndex },
      });
      return;
    }
    return applyWeatherEffect(state, kind, targetIndex);
  }

  function applyWeatherEffect(state, kind, targetIndex) {
    const self = currentPlayer(state);
    const target = state.players[targetIndex];
    switch (kind) {
      case 'WEATHER_SKIP':
        state.skipTurns[targetIndex] = (state.skipTurns[targetIndex] || 0) + 1;
        pushLog(state, `${self.name} inflicted Dry Spell on ${target.name}.`, 'info');
        return;
      case 'WEATHER_STEAL': {
        if (target.hand.length === 0) { pushLog(state, 'Diversion fizzled.', 'info'); return; }
        const i = rngInt(state, target.hand.length);
        const stolen = target.hand.splice(i, 1)[0];
        self.hand.push(stolen);
        pushLog(state, `${self.name} diverted ${stolen.name} from ${target.name}.`, 'info');
        return;
      }
      case 'WEATHER_FORCE_DISCARD': {
        const n = Math.min(2, target.hand.length);
        if (n === 0) { pushLog(state, `Surge fizzled — ${target.name} empty.`, 'info'); return; }
        setPrompt(state, {
          kind: 'PICK_DISCARD',
          forPlayer: targetIndex,
          payload: {
            count: n,
            cards: target.hand.map(cloneCard),
            sourceName: 'Evaporation Surge',
          },
        });
        return;
      }
      case 'WEATHER_LEAK': {
        if (!state.boss) { pushLog(state, 'Pipe Leakage fizzled — no active Boss.', 'info'); return; }
        if (target.hand.length === 0) { pushLog(state, `Pipe Leakage fizzled — ${target.name} empty.`, 'info'); return; }
        setPrompt(state, {
          kind: 'PIPE_LEAKAGE_PICK',
          forPlayer: targetIndex,
          payload: {
            cards: target.hand.map(cloneCard),
            attackerName: self.name,
          },
        });
        return;
      }
      case 'WEATHER_PICK_STEAL': {
        if (target.hand.length === 0) { pushLog(state, `Pipe Burst fizzled — ${target.name} empty.`, 'info'); return; }
        setPrompt(state, {
          kind: 'PIPE_BURST_PICK',
          forPlayer: state.current,
          payload: {
            targetIndex,
            targetName: target.name,
            cards: target.hand.map(cloneCard),
          },
        });
        return;
      }
      default:
        throw new Error('Unknown weather effect kind: ' + kind);
    }
  }

  // ============================================================
  // DRAW SEQUENCE — the only place threats are resolved.
  // ============================================================

  function startDrawSequence(state, count, opts) {
    if (state.drawPending) {
      throw new Error('Draw sequence already in progress.');
    }
    state.drawPending = {
      remaining: count,
      threats: [],
      after: (opts && opts.after) || 'NONE',
    };
    pumpDraws(state);
  }

  function pumpDraws(state) {
    const dp = state.drawPending;
    if (!dp) return;
    while (dp.remaining > 0) {
      dp.remaining--;
      const card = drawCard(state);
      if (!card) {
        pushLog(state, 'Deck and discard both empty — no more draws.', 'info');
        if (checkStalemate(state)) { state.drawPending = null; return; }
        break;
      }
      if (card.type === 'crisis' || card.type === 'collapse') {
        // Defer threats until the sequence finishes so the double-threat
        // rules can be applied uniformly:
        //   - 2 crises drawn → answer 1, reshuffle the rest
        //   - crisis + collapse → ignore the crisis
        dp.threats.push(card);
        continue;
      }
      currentPlayer(state).hand.push(card);
    }
    // All draws done. Resolve at most one threat.
    if (dp.threats.length > 0) {
      const collapse = dp.threats.find(c => c.type === 'collapse');
      const crises   = dp.threats.filter(c => c.type === 'crisis');
      dp.threats = [];
      if (collapse) {
        if (crises.length > 0) {
          state.deck.push.apply(state.deck, crises);
          shuffleInPlace(state.deck, state);
          pushLog(state, `Reservoir Collapse takes priority — ${crises.length} Crisis ignored and reshuffled.`, 'info');
        }
        handleCollapse(state, collapse);
        return; // resumes via prompt → pumpDraws
      }
      const first = crises[0];
      const rest  = crises.slice(1);
      if (rest.length > 0) {
        state.deck.push.apply(state.deck, rest);
        shuffleInPlace(state.deck, state);
        pushLog(state, 'A second Crisis was drawn — only one needs to be answered. Extras reshuffled.', 'info');
      }
      handleCrisis(state, first);
      return;
    }
    // Sequence complete — fire the after-hook.
    const after = dp.after;
    state.drawPending = null;
    if (after === 'NEXT_TURN') {
      advanceToNextPlayer(state);
    }
  }

  // ============================================================
  // CRISIS + COLLAPSE
  // ============================================================

  function handleCrisis(state, card) {
    const p = currentPlayer(state);
    state.discard.push(card);
    state.pendingCrisisCard = cloneCard(card);

    const usable = p.hand
      .map((c, i) => ({ c, i }))
      .filter(x => x.c.type !== 'crisis' && x.c.type !== 'collapse' && x.c.type !== 'emergency');

    if (usable.length === 0) {
      // Auto-wipe — no usable cards.
      pushLog(state, `${p.name} has no usable cards for ${card.name}. Hand wiped.`, 'crisis');
      wipeAndRefill(state, p);
      state.pendingCrisisCard = null;
      pumpDraws(state);
      return;
    }

    setPrompt(state, {
      kind: 'CRISIS_CARDS',
      forPlayer: state.current,
      payload: {
        crisisName: card.name,
        crisisFlavour: card.flavour,
        hand: p.hand.map(cloneCard),
      },
    });
  }

  function handleCollapse(state, card) {
    const p = currentPlayer(state);
    state.discard.push(card);
    const ei = p.hand.findIndex(c => c.type === 'emergency');
    if (ei >= 0) {
      // ER is removed from the game, not recycled.
      p.hand.splice(ei, 1);
      sweepDiscardToDeck(state);
      pushLog(state, `${p.name} survived Reservoir Collapse with Emergency Response. Threat reshuffled.`, 'good');
      pumpDraws(state);
      return;
    }
    const lost = p.trophies;
    p.trophies = 0;
    wipeAndRefill(state, p);
    pushLog(state, `${p.name} lost ${lost} trophies to Reservoir Collapse.`, 'crisis');
    pumpDraws(state);
  }

  // ============================================================
  // PROMPTS
  // ============================================================

  function setPrompt(state, prompt) {
    state._promptIdCounter++;
    state.activePrompt = Object.assign({ id: 'p' + state._promptIdCounter }, prompt);
  }

  function clearPrompt(state) {
    state.activePrompt = null;
  }

  function resolvePrompt(state, playerIndex, value) {
    const prompt = state.activePrompt;
    if (!prompt) throw new Error('No active prompt.');
    switch (prompt.kind) {
      case 'BOSS_ANSWER':         return resolveBossAnswer(state, value);
      case 'PEEK_RESULT':         clearPrompt(state); return;
      case 'PICK_TARGET':         return resolvePickTarget(state, prompt, value);
      case 'RESERVOIR_RESPONSE':  return resolveReservoir(state, prompt, value);
      case 'PICK_DISCARD':        return resolvePickDiscard(state, prompt, value);
      case 'PIPE_LEAKAGE_PICK':   return resolveLeak(state, prompt, value);
      case 'PIPE_BURST_PICK':     return resolveBurst(state, prompt, value);
      case 'CRISIS_CARDS':        return resolveCrisisCards(state, prompt, value);
      case 'PEER_VOTE':           return resolvePeerVote(state, prompt, playerIndex, value);
      default: throw new Error('Unknown prompt kind: ' + prompt.kind);
    }
  }

  function resolveBossAnswer(state, value) {
    const q = state.pendingBossQuestion;
    if (!q) throw new Error('No pending boss question.');
    const choice = value && typeof value.choice === 'number' ? value.choice : -1;
    const p = currentPlayer(state);
    clearPrompt(state);
    state.pendingBossQuestion = null;

    if (choice === q.correct) {
      state.boss.hp--;
      p.trophies++;
      pushLog(state, `${p.name} answered correctly — 1 damage, +1 trophy. Boss at ${state.boss.hp} HP.`, 'good');
      if (state.boss.hp <= 0) {
        const bonus = state.boss.pool.length;
        p.hand.push.apply(p.hand, state.boss.pool);
        p.trophies++;
        state.bossKills++;
        pushLog(state, `${p.name} KILLED the Boss! +1 trophy and claimed ${bonus} bucket card${bonus===1?'':'s'}.`, 'good');
        state.boss = null;
        if (!checkWin(state)) {
          activateBoss(state);
          pushLog(state, 'A new Boss rises stronger.', 'info');
        }
        return;
      }
    } else {
      const correctName = q.choices[q.correct];
      pushLog(state, `${p.name} answered wrong (correct: ${correctName}). The cycle was spent.`, 'crisis');
    }
    checkWin(state);
  }

  function resolvePickTarget(state, prompt, value) {
    const targetIndex = value && typeof value.targetIndex === 'number' ? value.targetIndex : -1;
    const valid = prompt.payload.options.some(o => o.index === targetIndex);
    if (!valid) throw new Error('Invalid target.');
    const ctx = prompt.context;
    clearPrompt(state);
    afterTargetChosen(state, ctx.followUp, ctx.attackName, targetIndex);
  }

  function resolveReservoir(state, prompt, value) {
    const ctx = prompt.context;
    const target = state.players[ctx.targetIndex];
    const wantsCancel = !!(value && value.cancel);
    clearPrompt(state);
    if (wantsCancel) {
      const ri = target.hand.findIndex(c => c.effect === 'reservoir');
      if (ri >= 0) {
        const r = target.hand.splice(ri, 1)[0];
        discardCards(state, [r]);
        pushLog(state, `${target.name} blocked ${ctx.attackName} with Reservoir!`, 'good');
        return;
      }
    }
    applyWeatherEffect(state, ctx.followUp, ctx.targetIndex);
  }

  function resolvePickDiscard(state, prompt, value) {
    const target = state.players[prompt.forPlayer];
    const want = prompt.payload.count;
    const ids = (value && Array.isArray(value.cardIds)) ? value.cardIds : [];
    if (ids.length !== want) throw new Error(`Pick exactly ${want} card(s).`);
    const indices = ids.map(id => findCardInHand(target, id));
    if (indices.some(i => i < 0)) throw new Error('Card not in hand.');
    indices.sort((a, b) => b - a).forEach(i => {
      const c = target.hand.splice(i, 1)[0];
      discardCards(state, [c]);
    });
    pushLog(state, `${target.name} discarded ${want} card(s) to ${prompt.payload.sourceName}.`, 'info');
    clearPrompt(state);
  }

  function resolveLeak(state, prompt, value) {
    const target = state.players[prompt.forPlayer];
    const id = value && value.cardId;
    const i = findCardInHand(target, id);
    if (i < 0) throw new Error('Card not in hand.');
    if (!state.boss) {
      pushLog(state, 'Pipe Leakage fizzled — Boss vanished mid-resolution.', 'info');
      clearPrompt(state);
      return;
    }
    const lost = target.hand.splice(i, 1)[0];
    state.boss.pool.push(lost);
    pushLog(state, `${target.name} fed ${lost.name} to the Boss's Bucket via Pipe Leakage.`, 'info');
    clearPrompt(state);
  }

  function resolveBurst(state, prompt, value) {
    const targetIndex = prompt.payload.targetIndex;
    const target = state.players[targetIndex];
    const id = value && value.cardId;
    const i = findCardInHand(target, id);
    if (i < 0) throw new Error('Card not in hand.');
    const stolen = target.hand.splice(i, 1)[0];
    currentPlayer(state).hand.push(stolen);
    pushLog(state, `${currentPlayer(state).name} pipe-burst ${stolen.name} from ${target.name}.`, 'info');
    clearPrompt(state);
  }

  function resolveCrisisCards(state, prompt, value) {
    const p = currentPlayer(state);
    const giveUp = !!(value && value.giveUp);
    if (giveUp) {
      pushLog(state, `${p.name} gave up on ${state.pendingCrisisCard.name}. Hand wiped.`, 'crisis');
      wipeAndRefill(state, p);
      state.pendingCrisisCard = null;
      clearPrompt(state);
      pumpDraws(state);
      return;
    }
    const ids = (value && Array.isArray(value.cardIds)) ? value.cardIds : [];
    if (ids.length < 1) throw new Error('Pick at least 1 card.');
    const indices = ids.map(id => findCardInHand(p, id));
    if (indices.some(i => i < 0)) throw new Error('Card not in hand.');
    // Cards aren't actually discarded yet — they're held until the peer vote
    // resolves so we can return them on a fail. Stash them in prompt context
    // by removing from hand.
    const removed = [];
    indices.sort((a, b) => b - a).forEach(i => removed.push(p.hand.splice(i, 1)[0]));
    pushLog(state, `${p.name} attempts to resolve ${state.pendingCrisisCard.name} with ${removed.map(c=>c.name).join(' + ')}.`, 'info');
    clearPrompt(state);
    // Open a peer vote.
    setPrompt(state, {
      kind: 'PEER_VOTE',
      forPlayer: -1, // any non-current player can vote
      payload: {
        crisisName: state.pendingCrisisCard.name,
        defenderIndex: state.current,
        defenderName: p.name,
        cardsSpent: removed.map(cloneCard),
      },
      context: { heldCards: removed },
      collected: {},
      // How many votes are needed before tallying?
      voters: state.players
        .filter(pp => pp.index !== state.current && !pp.out)
        .map(pp => pp.index),
    });
    // 1-player edge case (testing): if there are no voters, auto-pass.
    if (state.activePrompt.voters.length === 0) {
      autoFinishPeerVote(state, true);
    }
  }

  function resolvePeerVote(state, prompt, playerIndex, value) {
    if (playerIndex === state.current) throw new Error("You can't vote on your own crisis.");
    if (!prompt.voters.includes(playerIndex)) throw new Error('Not a voter.');
    if (prompt.collected[playerIndex] !== undefined) throw new Error('Already voted.');
    prompt.collected[playerIndex] = !!(value && value.pass);
    // Tally when everyone has voted.
    if (Object.keys(prompt.collected).length >= prompt.voters.length) {
      const yes = prompt.voters.filter(v => prompt.collected[v]).length;
      const no  = prompt.voters.length - yes;
      const passed = yes > no; // simple majority; ties fail
      autoFinishPeerVote(state, passed);
    }
  }

  function autoFinishPeerVote(state, passed) {
    const prompt = state.activePrompt;
    const ctx = prompt.context;
    const cardsSpent = ctx.heldCards;
    const p = state.players[prompt.payload.defenderIndex];
    const crisisName = prompt.payload.crisisName;
    clearPrompt(state);
    state.pendingCrisisCard = null;

    if (passed) {
      // Bonus draws BEFORE the discard sweep — fresh cards from the deck.
      const bonus = Math.min(cardsSpent.length, 3);
      for (const c of cardsSpent) discardCards(state, [c]);
      const drawn = [];
      for (let i = 0; i < bonus; i++) {
        const c = drawNoCrisis(state);
        if (!c) break;
        p.hand.push(c);
        drawn.push(c);
      }
      sweepDiscardToDeck(state);
      pushLog(state, `${p.name} passed peer check — ${drawn.length} bonus card(s).`, 'good');
    } else {
      // Failed: held cards rejoin the hand only briefly — wipeAndRefill will
      // sweep them with everything else.
      p.hand.push.apply(p.hand, cardsSpent);
      wipeAndRefill(state, p);
      pushLog(state, `${p.name}'s explanation failed peer check — hand wiped.`, 'crisis');
    }
    pumpDraws(state);
  }

  // ============================================================
  // BOSS / TURN / WIN
  // ============================================================

  function activateBoss(state) {
    if (state.boss) return;
    const hp = Math.min(5, 3 + state.bossKills);
    state.boss = { hp, maxHp: hp, pool: [] };
    pushLog(state, `A Boss rises with ${hp} HP.`, 'good');
  }

  function advanceToNextPlayer(state) {
    if (state.winner) return;
    state.weatherPlayed = false;
    state.mainActionUsed = false;
    do {
      state.current = (state.current + 1) % state.players.length;
    } while (state.players[state.current].out);
    state.turnCounter++;
    if (state.skipTurns[state.current] > 0) {
      state.skipTurns[state.current]--;
      pushLog(state, `${currentPlayer(state).name} is caught in a Dry Spell — turn skipped.`, 'crisis');
      // Recurse to skip them.
      advanceToNextPlayer(state);
      return;
    }
    pushLog(state, `${currentPlayer(state).name}'s turn.`, 'info');
  }

  function checkWin(state) {
    const p = currentPlayer(state);
    if (p.trophies >= 5) {
      state.winner = { playerIndex: p.index, playerName: p.name, reason: '5 trophies' };
      pushLog(state, `${p.name} wins with 5 trophies!`, 'good');
      return true;
    }
    return false;
  }

  function checkStalemate(state) {
    if (state.deck.length > 0 || state.discard.length > 0) return false;
    const alive = state.players.filter(p => !p.out);
    const maxT = Math.max.apply(null, alive.map(p => p.trophies));
    const leaders = alive.filter(p => p.trophies === maxT);
    if (leaders.length === 1) {
      state.winner = { playerIndex: leaders[0].index, playerName: leaders[0].name, reason: 'deck exhausted' };
      pushLog(state, `Deck and discard empty. ${leaders[0].name} wins with ${maxT} trophies.`, 'good');
    } else {
      state.winner = { playerIndex: -1, playerName: leaders.map(p => p.name).join(' & '), reason: 'draw' };
      pushLog(state, `Deck and discard empty. Draw between ${leaders.map(p=>p.name).join(' & ')} at ${maxT} trophies.`, 'info');
    }
    return true;
  }

  // ============================================================
  // EXPORTS
  // ============================================================

  const api = {
    createGame,
    applyIntent,
    viewFor,
    isGameOver,
    CARD_DATA: { resources: RESOURCES, weathers: WEATHERS, crises: CRISES, bossQuestions: BOSS_QUESTIONS },
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    global.WaterCycleGame = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);

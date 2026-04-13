// Scripted scenario tests for the Water Cycle Challenge engine.
// Drives the same applyIntent surface the browser client uses.

const Game = require('../game.js');

let testCount = 0, failCount = 0;
function test(name, fn) {
  testCount++;
  try {
    fn();
    console.log('  ✓', name);
  } catch (e) {
    failCount++;
    console.log('  ✗', name);
    console.log('    ', e.message);
    if (e.stack) console.log('    ', e.stack.split('\n').slice(1, 4).join('\n     '));
  }
}
function section(title) { console.log('\n' + title); }
function assertEq(actual, expected, msg) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg || 'mismatch'}: expected ${e}, got ${a}`);
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

// Mirror the client's nextViewer logic so we can verify routing.
function nextViewer(state, viewer) {
  if (!state || state.winner) return viewer;
  const ap = state.activePrompt;
  if (ap) {
    if (ap.kind === 'PEER_VOTE') {
      for (const v of ap.voters) if (ap.collected[v] === undefined) return v;
      return state.current;
    }
    if (ap.forPlayer >= 0) return ap.forPlayer;
    return state.current;
  }
  return state.current;
}

// Helper: stack a hand with a full cycle by pulling cards out of the deck.
function forceFullCycle(state, playerIndex) {
  const types = ['evap','cond','precip','collect'];
  const p = state.players[playerIndex];
  const have = new Set(p.hand.filter(c => types.includes(c.type)).map(c => c.type));
  for (const t of types) {
    if (have.has(t)) continue;
    for (let i = state.deck.length - 1; i >= 0; i--) {
      if (state.deck[i].type === t) { p.hand.push(state.deck.splice(i, 1)[0]); break; }
    }
  }
}

// Helper: force the next card drawn to be of the given type by moving an
// existing instance of that type to the END of the deck (drawCard pops).
function stackTopOfDeck(state, type) {
  for (let i = 0; i < state.deck.length; i++) {
    if (state.deck[i].type === type) {
      const c = state.deck.splice(i, 1)[0];
      state.deck.push(c);
      return c;
    }
  }
  throw new Error('no card of type ' + type + ' in deck');
}

section('1. determinism — same seed = same game');
test('two games with seed 42 produce identical decks', () => {
  const a = Game.createGame({ mode: 'crisis', playerCount: 3, seed: 42 });
  const b = Game.createGame({ mode: 'crisis', playerCount: 3, seed: 42 });
  assertEq(a.deck.map(c=>c.name), b.deck.map(c=>c.name), 'deck order');
  assertEq(a.players.map(p=>p.hand.map(c=>c.name)), b.players.map(p=>p.hand.map(c=>c.name)), 'hands');
});

section('2. view redaction');
test('opponent hands are null in viewFor', () => {
  const s = Game.createGame({ mode: 'crisis', playerCount: 3, seed: 1 });
  const v = Game.viewFor(s, 0);
  assert(v.players[0].hand !== null, 'own hand should be visible');
  assertEq(v.players[1].hand, null, 'opponent hand');
  assertEq(v.players[2].hand, null, 'opponent hand');
  assert(v.players[1].handCount > 0, 'opponent count visible');
});
test('boss bucket only exposes count, not contents', () => {
  const s = Game.createGame({ mode: 'crisis', playerCount: 2, seed: 1 });
  s.boss.pool.push({ id: 'cZZZZ', type: 'evap', name: 'Secret', desc: '', flavour: '' });
  const v = Game.viewFor(s, 0);
  assertEq(v.boss.bucketCount, 1);
  assert(!v.boss.pool, 'pool should not be exposed');
});

section('3. trade cycle');
test('trade for trophy spends a cycle and grants 1 trophy', () => {
  const s = Game.createGame({ mode: 'chill', playerCount: 2, seed: 7 });
  forceFullCycle(s, 0);
  const before = s.players[0].hand.length;
  const r = Game.applyIntent(s, 0, { type: 'TRADE_CYCLE' });
  assert(r.ok, r.error);
  assertEq(s.players[0].trophies, 1);
  assertEq(s.players[0].hand.length, before - 4);
  assert(s.mainActionUsed, 'main action used');
});
test('cannot trade twice in one turn', () => {
  const s = Game.createGame({ mode: 'chill', playerCount: 2, seed: 7 });
  forceFullCycle(s, 0);
  forceFullCycle(s, 0); // overkill but harmless
  Game.applyIntent(s, 0, { type: 'TRADE_CYCLE' });
  const r = Game.applyIntent(s, 0, { type: 'TRADE_CYCLE' });
  assert(!r.ok, 'second trade should fail');
});
test('out-of-turn trade rejected', () => {
  const s = Game.createGame({ mode: 'chill', playerCount: 2, seed: 7 });
  forceFullCycle(s, 1);
  const r = Game.applyIntent(s, 1, { type: 'TRADE_CYCLE' });
  assert(!r.ok && r.error === 'Not your turn.');
});

section('4. boss challenge — wrong + correct answer + kill');
test('wrong answer wastes the cycle, no damage', () => {
  const s = Game.createGame({ mode: 'chill', playerCount: 2, seed: 11 });
  forceFullCycle(s, 0);
  Game.applyIntent(s, 0, { type: 'CHALLENGE_BOSS' });
  assert(s.activePrompt && s.activePrompt.kind === 'BOSS_ANSWER');
  const correct = s.pendingBossQuestion.correct;
  const wrong = (correct + 1) % 4;
  const before = s.boss.hp;
  Game.applyIntent(s, 0, { type: 'PROMPT_RESPONSE', promptId: s.activePrompt.id, value: { choice: wrong } });
  assertEq(s.boss.hp, before, 'hp unchanged on wrong answer');
  assertEq(s.players[0].trophies, 0);
});
test('correct answer: 1 damage + 1 trophy', () => {
  const s = Game.createGame({ mode: 'chill', playerCount: 2, seed: 11 });
  forceFullCycle(s, 0);
  Game.applyIntent(s, 0, { type: 'CHALLENGE_BOSS' });
  const correct = s.pendingBossQuestion.correct;
  Game.applyIntent(s, 0, { type: 'PROMPT_RESPONSE', promptId: s.activePrompt.id, value: { choice: correct } });
  assertEq(s.boss.hp, 2);
  assertEq(s.players[0].trophies, 1);
});
test('kill: full bucket goes to killer, +1 bonus trophy, new boss with +1 max HP', () => {
  const s = Game.createGame({ mode: 'chill', playerCount: 2, seed: 11 });
  // Manually drop the boss to 1 HP and put 3 cards in the bucket
  s.boss.hp = 1;
  s.boss.pool.push({ id: 'cAAA1', type: 'evap', name: 'X', desc: '', flavour: '' });
  s.boss.pool.push({ id: 'cAAA2', type: 'cond', name: 'X', desc: '', flavour: '' });
  s.boss.pool.push({ id: 'cAAA3', type: 'precip', name: 'X', desc: '', flavour: '' });
  forceFullCycle(s, 0);
  const handBefore = s.players[0].hand.length;
  Game.applyIntent(s, 0, { type: 'CHALLENGE_BOSS' });
  // After challenge cycle is in bucket — bucket should have 3+4 = 7
  assertEq(s.boss.pool.length, 7);
  const correct = s.pendingBossQuestion.correct;
  Game.applyIntent(s, 0, { type: 'PROMPT_RESPONSE', promptId: s.activePrompt.id, value: { choice: correct } });
  assertEq(s.players[0].trophies, 2, 'damage trophy + kill bonus = 2');
  // Hand: started with handBefore, took 4 for cycle (-4), got 7 from bucket (+7)
  assertEq(s.players[0].hand.length, handBefore - 4 + 7);
  assert(s.boss !== null, 'new boss spawned');
  assertEq(s.boss.maxHp, 4, 'second boss has 4 HP max');
});

section('5. crisis flow — peer vote pass + fail');
test('crisis pass: bonus draws, no hand wipe', () => {
  const s = Game.createGame({ mode: 'crisis', playerCount: 3, seed: 5 });
  // Inject a known crisis at top of deck
  const c = stackTopOfDeck(s, 'crisis');
  // Snapshot p0 hand size before drawing — they will get +1 from end-of-turn
  // draw (we only forced 1 crisis, so the second draw is a normal card).
  Game.applyIntent(s, 0, { type: 'END_TURN' });
  // After END_TURN, draw 2: first draw = top of deck (other), second = our crisis.
  // But stackTopOfDeck put ONE crisis at the end, so it's the FIRST drawn.
  // Then a second card is drawn (could be anything).
  assert(s.activePrompt && s.activePrompt.kind === 'CRISIS_CARDS', 'crisis modal expected, got ' + (s.activePrompt && s.activePrompt.kind));
  // Pick 2 cards from the modal payload
  const handCards = s.activePrompt.payload.hand
    .filter(c => c.type !== 'crisis' && c.type !== 'collapse' && c.type !== 'emergency');
  assert(handCards.length >= 2, 'enough usable cards');
  const ids = [handCards[0].id, handCards[1].id];
  Game.applyIntent(s, 0, { type: 'PROMPT_RESPONSE', promptId: s.activePrompt.id, value: { cardIds: ids } });
  // Now PEER_VOTE — voters are 1 and 2
  assertEq(s.activePrompt.kind, 'PEER_VOTE');
  assertEq(s.activePrompt.voters.sort(), [1, 2]);
  const trophiesBefore = s.players[0].trophies;
  const handBefore = s.players[0].hand.length;
  // Both vote pass
  Game.applyIntent(s, 1, { type: 'PROMPT_RESPONSE', promptId: s.activePrompt.id, value: { pass: true } });
  Game.applyIntent(s, 2, { type: 'PROMPT_RESPONSE', promptId: s.activePrompt.id, value: { pass: true } });
  // Vote tallied → bonus draws → pumpDraws fires NEXT_TURN
  assertEq(s.activePrompt, null, 'prompt cleared');
  assertEq(s.players[0].trophies, trophiesBefore, 'trophies unchanged');
  // handBefore was captured AFTER the engine moved the 2 spent cards into
  // prompt context (out of the hand). So on pass, the hand grows by exactly
  // the bonus-draw count = min(2, 3) = 2.
  assertEq(s.players[0].hand.length, handBefore + 2, 'hand grows by bonus draws');
  assertEq(s.current, 1, 'turn advanced');
});
test('crisis fail: hand wiped, refilled to 5', () => {
  const s = Game.createGame({ mode: 'crisis', playerCount: 3, seed: 6 });
  stackTopOfDeck(s, 'crisis');
  Game.applyIntent(s, 0, { type: 'END_TURN' });
  assertEq(s.activePrompt.kind, 'CRISIS_CARDS');
  const usable = s.activePrompt.payload.hand
    .filter(c => c.type !== 'crisis' && c.type !== 'collapse' && c.type !== 'emergency');
  Game.applyIntent(s, 0, { type: 'PROMPT_RESPONSE', promptId: s.activePrompt.id, value: { cardIds: [usable[0].id] } });
  assertEq(s.activePrompt.kind, 'PEER_VOTE');
  // Both vote no
  Game.applyIntent(s, 1, { type: 'PROMPT_RESPONSE', promptId: s.activePrompt.id, value: { pass: false } });
  Game.applyIntent(s, 2, { type: 'PROMPT_RESPONSE', promptId: s.activePrompt.id, value: { pass: false } });
  // Hand should be exactly 5 non-emergency + 1 emergency
  const p0 = s.players[0];
  const erCount = p0.hand.filter(c => c.type === 'emergency').length;
  const nonEr = p0.hand.filter(c => c.type !== 'emergency').length;
  assertEq(erCount, 1, 'ER preserved');
  assertEq(nonEr, 5, 'wiped & refilled to 5');
});
test('crisis give-up: same penalty as fail', () => {
  const s = Game.createGame({ mode: 'crisis', playerCount: 2, seed: 8 });
  stackTopOfDeck(s, 'crisis');
  Game.applyIntent(s, 0, { type: 'END_TURN' });
  assertEq(s.activePrompt.kind, 'CRISIS_CARDS');
  Game.applyIntent(s, 0, { type: 'PROMPT_RESPONSE', promptId: s.activePrompt.id, value: { giveUp: true } });
  // No peer vote — straight wipe
  assertEq(s.activePrompt, null);
  const p0 = s.players[0];
  const nonEr = p0.hand.filter(c => c.type !== 'emergency').length;
  assertEq(nonEr, 5, 'wiped & refilled');
});

section('6. reservoir collapse');
test('with ER: ER removed, trophies preserved, threat reshuffled', () => {
  const s = Game.createGame({ mode: 'crisis', playerCount: 2, seed: 13 });
  s.players[0].trophies = 3;
  // Drop a collapse on top
  for (let i = 0; i < s.deck.length; i++) {
    if (s.deck[i].type === 'collapse') {
      const c = s.deck.splice(i, 1)[0];
      s.deck.push(c);
      break;
    }
  }
  Game.applyIntent(s, 0, { type: 'END_TURN' });
  assertEq(s.players[0].trophies, 3, 'trophies preserved');
  const er = s.players[0].hand.filter(c => c.type === 'emergency').length;
  assertEq(er, 0, 'ER removed from game');
  // Collapse reshuffled into deck
  const collapses = s.deck.filter(c => c.type === 'collapse').length;
  assertEq(collapses, 1, 'collapse back in deck');
});
test('without ER: trophies wiped, hand refilled, collapse reshuffled', () => {
  const s = Game.createGame({ mode: 'crisis', playerCount: 2, seed: 14 });
  // Strip ER from p0 first
  s.players[0].hand = s.players[0].hand.filter(c => c.type !== 'emergency');
  s.players[0].trophies = 4;
  for (let i = 0; i < s.deck.length; i++) {
    if (s.deck[i].type === 'collapse') {
      const c = s.deck.splice(i, 1)[0];
      s.deck.push(c);
      break;
    }
  }
  Game.applyIntent(s, 0, { type: 'END_TURN' });
  assertEq(s.players[0].trophies, 0, 'trophies lost');
  const nonEr = s.players[0].hand.filter(c => c.type !== 'emergency').length;
  assertEq(nonEr, 5, 'hand refilled');
});

section('7. weather: pipe leakage routes prompt to target');
test('pipe leakage target picks from their own hand', () => {
  const s = Game.createGame({ mode: 'chill', playerCount: 3, seed: 17 });
  // Find a Pipe Leakage and put it in p0 hand
  for (let i = 0; i < s.deck.length; i++) {
    if (s.deck[i].name === 'Pipe Leakage') {
      s.players[0].hand.push(s.deck.splice(i, 1)[0]);
      break;
    }
  }
  // Strip any reservoir from p1 to avoid the cancel branch
  s.players[1].hand = s.players[1].hand.filter(c => c.effect !== 'reservoir');
  const leak = s.players[0].hand.find(c => c.name === 'Pipe Leakage');
  Game.applyIntent(s, 0, { type: 'PLAY_WEATHER', cardId: leak.id });
  // Either auto-targeted (if p1 was the only valid target) or PICK_TARGET
  if (s.activePrompt && s.activePrompt.kind === 'PICK_TARGET') {
    Game.applyIntent(s, 0, { type: 'PROMPT_RESPONSE', promptId: s.activePrompt.id, value: { targetIndex: 1 } });
  }
  // Now we should be at PIPE_LEAKAGE_PICK with forPlayer = 1 (the target)
  assertEq(s.activePrompt.kind, 'PIPE_LEAKAGE_PICK');
  assertEq(s.activePrompt.forPlayer, 1);
  // Verify nextViewer routes there
  assertEq(nextViewer(s, 0), 1, 'viewer should switch to target');
  // Target picks first card
  const pick = s.players[1].hand[0].id;
  const bucketBefore = s.boss.pool.length;
  Game.applyIntent(s, 1, { type: 'PROMPT_RESPONSE', promptId: s.activePrompt.id, value: { cardId: pick } });
  assertEq(s.boss.pool.length, bucketBefore + 1, 'card fed to bucket');
});

section('8. reservoir cancel');
test('reservoir cancels an attack and is discarded', () => {
  const s = Game.createGame({ mode: 'chill', playerCount: 2, seed: 19 });
  // Find a Dry Spell in deck → p0 hand
  for (let i = 0; i < s.deck.length; i++) {
    if (s.deck[i].name === 'Dry Spell') {
      s.players[0].hand.push(s.deck.splice(i, 1)[0]);
      break;
    }
  }
  // Strip any reservoirs already in p1's hand from the initial deal, then
  // add exactly one. Otherwise we can't tell whether the cancel consumed
  // ours or a pre-existing one.
  s.players[1].hand = s.players[1].hand.filter(c => c.effect !== 'reservoir');
  for (let i = 0; i < s.deck.length; i++) {
    if (s.deck[i].name === 'Reservoir') {
      s.players[1].hand.push(s.deck.splice(i, 1)[0]);
      break;
    }
  }
  const dry = s.players[0].hand.find(c => c.name === 'Dry Spell');
  Game.applyIntent(s, 0, { type: 'PLAY_WEATHER', cardId: dry.id });
  // 2 players → only 1 valid target → auto-target → reservoir prompt for p1
  assertEq(s.activePrompt.kind, 'RESERVOIR_RESPONSE');
  assertEq(s.activePrompt.forPlayer, 1);
  Game.applyIntent(s, 1, { type: 'PROMPT_RESPONSE', promptId: s.activePrompt.id, value: { cancel: true } });
  // No skip applied
  assertEq(s.skipTurns[1] || 0, 0, 'skip not applied');
  // Reservoir consumed
  const resv = s.players[1].hand.find(c => c.name === 'Reservoir');
  assertEq(resv, undefined, 'reservoir gone');
});

section('9. forecast peek');
test('peek returns top 3 cards in draw order', () => {
  const s = Game.createGame({ mode: 'chill', playerCount: 2, seed: 23 });
  for (let i = 0; i < s.deck.length; i++) {
    if (s.deck[i].name === 'Forecast') {
      s.players[0].hand.push(s.deck.splice(i, 1)[0]);
      break;
    }
  }
  const expectedTop3 = s.deck.slice(-3).reverse().map(c => c.name);
  const fc = s.players[0].hand.find(c => c.name === 'Forecast');
  Game.applyIntent(s, 0, { type: 'PLAY_WEATHER', cardId: fc.id });
  assertEq(s.activePrompt.kind, 'PEEK_RESULT');
  assertEq(s.activePrompt.payload.cards.map(c => c.name), expectedTop3);
  Game.applyIntent(s, 0, { type: 'PROMPT_RESPONSE', promptId: s.activePrompt.id, value: {} });
  assertEq(s.activePrompt, null);
});

section('10. water rationing');
test('rationing wipes everyone to 5 + ER preserved', () => {
  const s = Game.createGame({ mode: 'crisis', playerCount: 3, seed: 29 });
  for (let i = 0; i < s.deck.length; i++) {
    if (s.deck[i].name === 'Water Rationing') {
      s.players[0].hand.push(s.deck.splice(i, 1)[0]);
      break;
    }
  }
  const r = s.players[0].hand.find(c => c.name === 'Water Rationing');
  Game.applyIntent(s, 0, { type: 'PLAY_WEATHER', cardId: r.id });
  for (const p of s.players) {
    const er = p.hand.filter(c => c.type === 'emergency').length;
    const non = p.hand.filter(c => c.type !== 'emergency').length;
    assertEq(er, 1, p.name + ' kept ER');
    assertEq(non, 5, p.name + ' refilled to 5');
  }
});

section('11. nextViewer routing');
test('peer vote rotates through voters', () => {
  const s = Game.createGame({ mode: 'crisis', playerCount: 4, seed: 31 });
  stackTopOfDeck(s, 'crisis');
  Game.applyIntent(s, 0, { type: 'END_TURN' });
  assertEq(s.activePrompt.kind, 'CRISIS_CARDS');
  const usable = s.activePrompt.payload.hand
    .filter(c => c.type !== 'crisis' && c.type !== 'collapse' && c.type !== 'emergency');
  Game.applyIntent(s, 0, { type: 'PROMPT_RESPONSE', promptId: s.activePrompt.id, value: { cardIds: [usable[0].id] } });
  assertEq(s.activePrompt.kind, 'PEER_VOTE');
  // Voters are 1, 2, 3 in some order
  let viewer = 0;
  const seenVoters = new Set();
  for (let step = 0; step < 4 && s.activePrompt; step++) {
    const next = nextViewer(s, viewer);
    if (s.activePrompt && s.activePrompt.kind === 'PEER_VOTE') {
      assert(next !== 0, 'current player should not vote');
      seenVoters.add(next);
      Game.applyIntent(s, next, { type: 'PROMPT_RESPONSE', promptId: s.activePrompt.id, value: { pass: true } });
      viewer = next;
    }
  }
  assertEq(seenVoters.size, 3, 'all 3 voters polled');
});

section('12. win condition');
test('reaching 5 trophies sets winner', () => {
  const s = Game.createGame({ mode: 'chill', playerCount: 2, seed: 37 });
  s.players[0].trophies = 4;
  forceFullCycle(s, 0);
  Game.applyIntent(s, 0, { type: 'TRADE_CYCLE' });
  assert(s.winner, 'winner set');
  assertEq(s.winner.playerIndex, 0);
});

section('13. validation');
test('PROMPT_RESPONSE with stale id rejected', () => {
  const s = Game.createGame({ mode: 'chill', playerCount: 2, seed: 41 });
  forceFullCycle(s, 0);
  Game.applyIntent(s, 0, { type: 'CHALLENGE_BOSS' });
  const r = Game.applyIntent(s, 0, { type: 'PROMPT_RESPONSE', promptId: 'pNOPE', value: { choice: 0 } });
  assert(!r.ok, 'stale id rejected');
});
test('top-level intent during prompt rejected', () => {
  const s = Game.createGame({ mode: 'chill', playerCount: 2, seed: 41 });
  forceFullCycle(s, 0);
  Game.applyIntent(s, 0, { type: 'CHALLENGE_BOSS' });
  const r = Game.applyIntent(s, 0, { type: 'TRADE_CYCLE' });
  assert(!r.ok && /prompt/i.test(r.error));
});
test('wrong player responding to a prompt rejected', () => {
  const s = Game.createGame({ mode: 'chill', playerCount: 2, seed: 41 });
  forceFullCycle(s, 0);
  Game.applyIntent(s, 0, { type: 'CHALLENGE_BOSS' });
  const r = Game.applyIntent(s, 1, { type: 'PROMPT_RESPONSE', promptId: s.activePrompt.id, value: { choice: 0 } });
  assert(!r.ok);
});

console.log(`\n${testCount - failCount}/${testCount} passed${failCount ? ', ' + failCount + ' FAILED' : ''}`);
process.exit(failCount ? 1 : 0);

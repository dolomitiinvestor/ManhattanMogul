// Fuzz test: random bots play many full games. Checks that the engine never
// crashes, never loses or duplicates cards, and that games finish.
const assert = require('assert');
const { Game, GameError, isComplete } = require('../server/game');
const { COLORS } = require('../server/cards');

const pick = (a) => a[Math.floor(Math.random() * a.length)];

function totalCards(g) {
  let n = g.deck.length + g.discard.length;
  for (const p of g.players) n += g.allCardsOf(p).length;
  return n;
}

function randomCommand(g, p) {
  const others = g.players.filter((x) => x !== p);
  const pd = g.pending;
  if (pd) {
    if (pd.actorId === p.id) {
      const e = pd.targets.find((t) => t.stage === 'counter');
      if (e) return { cmd: 'respond', choice: Math.random() < 0.5 ? 'jsn' : 'accept', targetId: e.id };
      return null;
    }
    const e = pd.targets.find((t) => t.id === p.id && t.stage === 'respond');
    if (!e) return null;
    if (Math.random() < 0.3) return { cmd: 'respond', choice: 'jsn' };
    if (pd.kind !== 'charge') return { cmd: 'respond', choice: 'accept' };
    const payable = g.payableCards(p);
    const chosen = [];
    let sum = 0;
    for (const c of payable.sort(() => Math.random() - 0.5)) {
      if (sum >= pd.amount) break;
      chosen.push(c.id); sum += c.value;
    }
    return { cmd: 'pay', cardIds: chosen };
  }
  if (g.current !== p) return null;
  if (g.discardNeeded) return { cmd: 'discard', cardIds: p.hand.slice(0, g.discardNeeded).map((c) => c.id) };
  if (g.playsLeft === 0 || Math.random() < 0.05) return { cmd: 'endTurn' };
  const card = pick(p.hand);
  if (!card) return { cmd: 'endTurn' };
  const t = pick(others);
  const colors = Object.keys(COLORS);
  if (Math.random() < 0.15) return { cmd: 'bank', cardId: card.id };
  if (card.type === 'property' || card.type === 'wild') {
    return { cmd: 'property', cardId: card.id, color: card.type === 'property' ? card.color : card.colors === 'any' ? pick(colors) : pick(card.colors) };
  }
  if (Math.random() < 0.1) {
    const wild = p.sets.flatMap((s) => s.cards).find((c) => c.type === 'wild');
    if (wild) return { cmd: 'move', cardId: wild.id, color: wild.colors === 'any' ? pick(colors) : pick(wild.colors) };
  }
  if (card.type === 'money') return { cmd: 'bank', cardId: card.id };
  if (card.type === 'rent') {
    const color = card.colors === 'any' ? (pick(p.sets) || {}).color || 'brown' : pick(card.colors);
    const doubles = p.hand.filter((c) => c.action === 'doubleRent').map((c) => c.id).slice(0, Math.floor(Math.random() * 3));
    return { cmd: 'rent', cardId: card.id, color, targetId: t.id, doubleIds: doubles };
  }
  const loose = (pl) => pl.sets.filter((s) => !isComplete(s)).flatMap((s) => s.cards);
  const msg = { cmd: 'action', cardId: card.id, targetId: t.id };
  switch (card.action) {
    case 'slyDeal': msg.targetCardId = (pick(loose(t)) || {}).id; break;
    case 'forcedDeal': msg.targetCardId = (pick(loose(t)) || {}).id; msg.myCardId = (pick(loose(p)) || {}).id; break;
    case 'dealBreaker': msg.setId = (pick(t.sets.filter(isComplete)) || {}).id; break;
    case 'house': case 'hotel': msg.setId = (pick(p.sets) || {}).id; break;
  }
  return msg;
}

function playGame(nPlayers) {
  const g = new Game('TEST');
  for (let i = 0; i < nPlayers; i++) g.addPlayer('Bot' + i, 't' + i);
  g.start(g.hostId);
  const initial = totalCards(g);
  let steps = 0, errors = 0;
  while (g.phase === 'playing' && steps < 20000) {
    steps++;
    const actors = g.pending
      ? g.players.filter((p) => p.id === g.pending.actorId || g.pending.targets.some((t) => t.id === p.id && t.stage === 'respond'))
      : [g.current];
    const p = pick(actors);
    const msg = randomCommand(g, p);
    if (!msg) continue;
    try {
      g.handle(p.id, msg);
    } catch (e) {
      if (!(e instanceof GameError)) throw e;
      errors++;
    }
    assert.strictEqual(totalCards(g), initial, 'card count changed after ' + JSON.stringify(msg));
    for (const pl of g.players) {
      for (const s of pl.sets) {
        assert(s.cards.length > 0, 'empty set');
        assert(s.cards.length <= COLORS[s.color].size, 'oversized set');
        if (s.hotel) assert(s.house, 'hotel without house');
        if (s.house) assert(isComplete(s) && !COLORS[s.color].noBuildings, 'bad house');
      }
      const ids = g.allCardsOf(pl).map((c) => c.id);
      assert.strictEqual(new Set(ids).size, ids.length, 'duplicate card');
    }
    if (!g.pending) assert(!g.discardNeeded || g.current.hand.length > 7);
  }
  return { finished: g.phase === 'ended', steps, errors };
}

let finished = 0;
const N = 400;
for (let i = 0; i < N; i++) {
  const r = playGame(2 + (i % 7));
  if (r.finished) finished++;
}
console.log(`${finished}/${N} random games reached a winner; no invariant violations.`);
assert(finished > N * 0.8, 'too few games finished');

// Targeted scenario: Just Say No chain and rent payment.
{
  const g = new Game('T2');
  const a = g.addPlayer('A', 'a'), b = g.addPlayer('B', 'b');
  g.start(g.hostId);
  g.players = [a, b]; g.turnIdx = 0; g.pending = null; g.playsLeft = 3; g.discardNeeded = 0;
  a.hand = []; b.hand = []; a.sets = []; b.sets = []; a.bank = []; b.bank = [];
  const mk = (o) => ({ id: 'x' + Math.random(), ...o });
  const rent = mk({ type: 'rent', colors: ['darkBlue', 'green'], value: 1 });
  const dbl = mk({ type: 'action', action: 'doubleRent', value: 1 });
  const jsnA = mk({ type: 'action', action: 'justSayNo', value: 4 });
  const jsnB = mk({ type: 'action', action: 'justSayNo', value: 4 });
  a.hand.push(rent, dbl, jsnA); b.hand.push(jsnB);
  g.addProperty(a, mk({ type: 'property', color: 'darkBlue', value: 4 }), 'darkBlue');
  g.addProperty(a, mk({ type: 'property', color: 'darkBlue', value: 4 }), 'darkBlue');
  const ten = mk({ type: 'money', value: 10 });
  b.bank.push(ten, mk({ type: 'money', value: 5 }));
  g.handle(a.id, { cmd: 'rent', cardId: rent.id, color: 'darkBlue', doubleIds: [dbl.id] });
  assert.strictEqual(g.pending.amount, 16);
  assert.strictEqual(g.playsLeft, 1);
  g.handle(b.id, { cmd: 'respond', choice: 'jsn' });
  assert.strictEqual(g.pending.targets[0].stage, 'counter');
  g.handle(a.id, { cmd: 'respond', choice: 'jsn', targetId: b.id });
  assert.throws(() => g.handle(b.id, { cmd: 'pay', cardIds: [ten.id] }), GameError);
  g.handle(b.id, { cmd: 'pay', cardIds: b.bank.map((c) => c.id) });
  assert.strictEqual(g.pending, null);
  assert.strictEqual(a.bank.reduce((s, c) => s + c.value, 0), 15);
  console.log('Just Say No chain + doubled rent scenario OK.');
}

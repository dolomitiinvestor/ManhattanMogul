// Authoritative game engine. Pure logic: no networking. Runs in the host's browser.
(() => {
const { COLORS, BUILDING_RENT, RULES, buildDeck } = typeof module !== 'undefined' ? require('./cards') : window.MMCards;

class GameError extends Error {}
const fail = (msg) => { throw new GameError(msg); };

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const isPropertyCard = (c) => c.type === 'property' || c.type === 'wild';
const isRainbow = (c) => c.type === 'wild' && c.colors === 'any';
const money = (n) => `$${n}M`;

function canBeColor(card, color) {
  if (!COLORS[color]) return false;
  if (card.type === 'property') return card.color === color;
  if (card.type === 'wild') return card.colors === 'any' || card.colors.includes(color);
  return false;
}

function isComplete(set) {
  return set.cards.length >= COLORS[set.color].size && set.cards.some((c) => !isRainbow(c));
}

function setRent(set) {
  if (!set.cards.some((c) => !isRainbow(c))) return 0;
  const col = COLORS[set.color];
  let rent = col.rent[Math.min(set.cards.length, col.size) - 1];
  if (isComplete(set)) {
    if (set.house) rent += BUILDING_RENT.house;
    if (set.hotel) rent += BUILDING_RENT.hotel;
  }
  return rent;
}

class Game {
  constructor(code) {
    this.code = code;
    this.phase = 'lobby';
    this.players = [];
    this.hostId = null;
    this.deck = [];
    this.discard = [];
    this.turnIdx = 0;
    this.playsLeft = 0;
    this.discardNeeded = 0;
    this.pending = null;
    this.winnerId = null;
    this.log = [];
    this.seq = 0;          // bumps on each change so clients can detect updates
    this.nextPlayerId = 1;
    this.nextSetId = 1;
    this.nextPendingId = 1;
  }

  // ---------- lobby ----------
  addPlayer(name, token) {
    if (this.phase !== 'lobby') fail('Game already started');
    if (this.players.length >= RULES.maxPlayers) fail('Room is full');
    name = String(name || '').trim().slice(0, 20) || `Player ${this.players.length + 1}`;
    const p = { id: 'p' + this.nextPlayerId++, name, token, connected: true, hand: [], bank: [], sets: [] };
    this.players.push(p);
    if (!this.hostId) this.hostId = p.id;
    this.addLog(`${name} joined.`);
    return p;
  }

  removePlayer(id) {
    const idx = this.players.findIndex((p) => p.id === id);
    if (idx < 0) return;
    const p = this.players[idx];
    this.addLog(`${p.name} left the game.`);
    if (this.phase === 'playing') {
      for (const c of this.allCardsOf(p)) this.discard.push(c);
      const wasTurn = idx === this.turnIdx;
      if (this.pending) {
        if (this.pending.actorId === id) this.pending = null;
        else {
          this.pending.targets = this.pending.targets.filter((t) => t.id !== id);
          this.maybeFinishPending();
        }
      }
      this.players.splice(idx, 1);
      if (idx < this.turnIdx) this.turnIdx--;
      if (this.players.length < 2) {
        this.phase = 'ended';
        this.winnerId = this.players[0] ? this.players[0].id : null;
        if (this.players[0]) this.addLog(`${this.players[0].name} wins by default!`);
      } else if (wasTurn) {
        this.turnIdx = this.turnIdx % this.players.length;
        this.pending = null;
        this.startTurn();
      }
    } else {
      this.players.splice(idx, 1);
    }
    if (this.hostId === id) this.hostId = this.players[0] ? this.players[0].id : null;
    this.seq++;
  }

  start(byId) {
    if (byId !== this.hostId) fail('Only the host can start');
    if (this.phase === 'playing') fail('Already started');
    if (this.players.length < RULES.minPlayers) fail(`Need at least ${RULES.minPlayers} players`);
    const copies = Math.ceil(this.players.length / RULES.playersPerDeck);
    this.deck = shuffle(buildDeck(copies));
    this.discard = [];
    this.pending = null;
    this.winnerId = null;
    this.log = [];
    shuffle(this.players);
    for (const p of this.players) {
      p.hand = []; p.bank = []; p.sets = [];
      this.draw(p, RULES.handSize);
    }
    this.phase = 'playing';
    this.turnIdx = 0;
    this.addLog(`Game started with ${this.players.length} players${copies > 1 ? ` (${copies} decks)` : ''}.`);
    this.startTurn();
    this.seq++;
  }

  backToLobby(byId) {
    if (byId !== this.hostId) fail('Only the host can do that');
    if (this.phase !== 'ended') fail('Game is still running');
    this.phase = 'lobby';
    for (const p of this.players) { p.hand = []; p.bank = []; p.sets = []; }
    this.deck = []; this.discard = []; this.pending = null; this.winnerId = null;
    this.addLog('Back to lobby.');
    this.seq++;
  }

  // ---------- helpers ----------
  addLog(text) {
    this.log.push({ n: this.log.length ? this.log[this.log.length - 1].n + 1 : 1, text });
    if (this.log.length > 150) this.log.shift();
  }

  player(id) { return this.players.find((p) => p.id === id); }
  get current() { return this.players[this.turnIdx]; }

  draw(p, n) {
    let drawn = 0;
    for (let i = 0; i < n; i++) {
      if (!this.deck.length) {
        if (!this.discard.length) break;
        this.deck = shuffle(this.discard);
        this.discard = [];
        this.addLog('Deck reshuffled from the discard pile.');
      }
      p.hand.push(this.deck.pop());
      drawn++;
    }
    return drawn;
  }

  allCardsOf(p) {
    const out = [...p.hand, ...p.bank];
    for (const s of p.sets) {
      out.push(...s.cards);
      if (s.house) out.push(s.house);
      if (s.hotel) out.push(s.hotel);
    }
    return out;
  }

  takeFromHand(p, cardId) {
    const i = p.hand.findIndex((c) => c.id === cardId);
    if (i < 0) fail('That card is not in your hand');
    return p.hand.splice(i, 1)[0];
  }

  handCard(p, cardId) {
    const c = p.hand.find((x) => x.id === cardId);
    if (!c) fail('That card is not in your hand');
    return c;
  }

  findPropertyCard(p, cardId) {
    for (const s of p.sets) {
      const c = s.cards.find((x) => x.id === cardId);
      if (c) return { set: s, card: c };
    }
    return null;
  }

  // Remove a property card from a player's table. Returns {card, color}.
  removeProperty(p, cardId) {
    const found = this.findPropertyCard(p, cardId);
    if (!found) fail('Property not found');
    found.set.cards = found.set.cards.filter((c) => c.id !== cardId);
    return { card: found.card, color: found.set.color };
  }

  addProperty(p, card, color) {
    if (!canBeColor(card, color)) {
      color = card.type === 'property' ? card.color : card.colors === 'any' ? color : card.colors[0];
    }
    p.sets.push({ id: 's' + this.nextSetId++, color, cards: [card], house: null, hotel: null });
    this.normalize(p);
  }

  // Merge loose cards of each color into as few sets as possible and fix up buildings.
  normalize(p) {
    const result = [];
    for (const color of Object.keys(COLORS)) {
      const sets = p.sets.filter((s) => s.color === color);
      if (!sets.length) continue;
      const keep = [];
      const loose = [];
      const ids = [];
      for (const s of sets) {
        if (s.hotel && !s.house) { p.bank.push(s.hotel); s.hotel = null; }
        if ((s.house || s.hotel) && !isComplete(s)) {
          if (s.house) p.bank.push(s.house);
          if (s.hotel) p.bank.push(s.hotel);
          s.house = null; s.hotel = null;
        }
        if (s.house && isComplete(s) && s.cards.length <= COLORS[color].size) keep.push(s);
        else { loose.push(...s.cards); ids.push(s.id); }
      }
      const rank = (c) => (c.type === 'property' ? 0 : isRainbow(c) ? 2 : 1);
      loose.sort((a, b) => rank(a) - rank(b));
      const size = COLORS[color].size;
      result.push(...keep);
      for (let i = 0; i < loose.length; i += size) {
        result.push({ id: ids.shift() || 's' + this.nextSetId++, color, cards: loose.slice(i, i + size), house: null, hotel: null });
      }
    }
    p.sets = result;
  }

  completeColors(p) {
    return new Set(p.sets.filter(isComplete).map((s) => s.color)).size;
  }

  payableCards(p) {
    const out = p.bank.filter((c) => c.value > 0);
    for (const s of p.sets) {
      for (const c of s.cards) if (c.value > 0) out.push(c);
      if (s.house) out.push(s.house);
      if (s.hotel) out.push(s.hotel);
    }
    return out;
  }

  checkWinner() {
    if (this.phase !== 'playing') return;
    const order = [this.current, ...this.players.filter((p) => p !== this.current)];
    for (const p of order) {
      if (this.completeColors(p) >= RULES.setsToWin) {
        this.phase = 'ended';
        this.winnerId = p.id;
        this.pending = null;
        this.addLog(`🏆 ${p.name} wins with ${RULES.setsToWin} complete sets!`);
        return;
      }
    }
  }

  // ---------- turn flow ----------
  startTurn() {
    const p = this.current;
    const n = p.hand.length === 0 ? RULES.drawWhenEmpty : RULES.drawPerTurn;
    const drawn = this.draw(p, n);
    this.playsLeft = RULES.playsPerTurn;
    this.discardNeeded = 0;
    this.addLog(`— ${p.name}'s turn. Drew ${drawn} card${drawn === 1 ? '' : 's'}.`);
  }

  advanceTurn() {
    this.turnIdx = (this.turnIdx + 1) % this.players.length;
    this.startTurn();
  }

  requireTurn(p, { needPlay = true } = {}) {
    if (this.phase !== 'playing') fail('Game is not in progress');
    if (this.current !== p) fail("It's not your turn");
    if (this.pending) fail('Waiting for other players to respond');
    if (this.discardNeeded) fail('You must discard first');
    if (needPlay && this.playsLeft <= 0) fail('No plays left this turn — end your turn');
  }

  // ---------- command dispatcher ----------
  handle(playerId, msg) {
    const p = this.player(playerId);
    if (!p) fail('You are not in this game');
    const handlers = {
      start: () => this.start(playerId),
      backToLobby: () => this.backToLobby(playerId),
      bank: () => this.cmdBank(p, msg),
      property: () => this.cmdProperty(p, msg),
      action: () => this.cmdAction(p, msg),
      rent: () => this.cmdRent(p, msg),
      move: () => this.cmdMove(p, msg),
      endTurn: () => this.cmdEndTurn(p),
      discard: () => this.cmdDiscard(p, msg),
      respond: () => this.cmdRespond(p, msg),
      pay: () => this.cmdPay(p, msg),
    };
    const h = handlers[msg.cmd];
    if (!h) fail('Unknown command');
    h();
    this.checkWinner();
    this.seq++;
  }

  cmdBank(p, { cardId }) {
    this.requireTurn(p);
    const card = this.handCard(p, cardId);
    if (isPropertyCard(card)) fail('Properties cannot be put in the bank');
    this.takeFromHand(p, cardId);
    p.bank.push(card);
    this.playsLeft--;
    this.addLog(`${p.name} banked ${card.type === 'money' ? card.name : `${card.name} as ${money(card.value)}`}.`);
  }

  cmdProperty(p, { cardId, color }) {
    this.requireTurn(p);
    const card = this.handCard(p, cardId);
    if (!isPropertyCard(card)) fail('Not a property card');
    if (card.type === 'property') color = card.color;
    if (!canBeColor(card, color)) fail('Choose a valid color for this card');
    this.takeFromHand(p, cardId);
    this.addProperty(p, card, color);
    this.playsLeft--;
    this.addLog(`${p.name} played ${card.name}${card.type === 'wild' ? ` as ${COLORS[color].name}` : ''}.`);
  }

  cmdMove(p, { cardId, color }) {
    this.requireTurn(p, { needPlay: false });
    const found = this.findPropertyCard(p, cardId);
    if (!found) fail('Card not found on your table');
    if (found.card.type !== 'wild') fail('Only wild cards can be moved');
    if (!canBeColor(found.card, color)) fail('That card cannot be that color');
    if (found.set.color === color) fail('Already that color');
    this.removeProperty(p, cardId);
    this.addProperty(p, found.card, color);
    this.addLog(`${p.name} moved ${found.card.name} to ${COLORS[color].name}.`);
  }

  cmdEndTurn(p) {
    this.requireTurn(p, { needPlay: false });
    if (p.hand.length > RULES.maxHand) {
      this.discardNeeded = p.hand.length - RULES.maxHand;
      return;
    }
    this.advanceTurn();
  }

  cmdDiscard(p, { cardIds }) {
    if (this.phase !== 'playing' || this.current !== p || !this.discardNeeded) fail('Nothing to discard');
    if (!Array.isArray(cardIds) || new Set(cardIds).size !== this.discardNeeded) fail(`Choose exactly ${this.discardNeeded} card(s)`);
    for (const id of cardIds) this.handCard(p, id);
    for (const id of cardIds) this.discard.push(this.takeFromHand(p, id));
    this.addLog(`${p.name} discarded ${cardIds.length} card${cardIds.length === 1 ? '' : 's'}.`);
    this.discardNeeded = 0;
    this.advanceTurn();
  }

  otherPlayer(p, targetId) {
    const t = this.player(targetId);
    if (!t || t === p) fail('Choose another player');
    return t;
  }

  cmdAction(p, msg) {
    this.requireTurn(p);
    const card = this.handCard(p, msg.cardId);
    if (card.type !== 'action') fail('Not an action card');
    const a = card.action;

    // Validate everything before taking the card.
    let t, setObj, target, mine;
    switch (a) {
      case 'passGo':
      case 'birthday':
        break;
      case 'debtCollector':
        t = this.otherPlayer(p, msg.targetId);
        break;
      case 'slyDeal': {
        t = this.otherPlayer(p, msg.targetId);
        target = this.findPropertyCard(t, msg.targetCardId);
        if (!target) fail('Pick a property to steal');
        if (isComplete(target.set)) fail("Can't steal from a complete set");
        break;
      }
      case 'forcedDeal': {
        t = this.otherPlayer(p, msg.targetId);
        target = this.findPropertyCard(t, msg.targetCardId);
        mine = this.findPropertyCard(p, msg.myCardId);
        if (!target || !mine) fail('Pick one of your properties and one of theirs');
        if (isComplete(target.set) || isComplete(mine.set)) fail("Can't trade cards from a complete set");
        break;
      }
      case 'dealBreaker': {
        t = this.otherPlayer(p, msg.targetId);
        setObj = t.sets.find((s) => s.id === msg.setId);
        if (!setObj || !isComplete(setObj)) fail('Pick a complete set to steal');
        break;
      }
      case 'house':
      case 'hotel': {
        setObj = p.sets.find((s) => s.id === msg.setId);
        if (!setObj || !isComplete(setObj)) fail('Pick one of your complete sets');
        if (COLORS[setObj.color].noBuildings) fail(`Can't build on ${COLORS[setObj.color].name}`);
        if (a === 'house' && setObj.house) fail('That set already has a House');
        if (a === 'hotel' && !setObj.house) fail('A Hotel needs a House first');
        if (a === 'hotel' && setObj.hotel) fail('That set already has a Hotel');
        break;
      }
      case 'justSayNo':
        fail('Just Say No can only be used in response to an action (or banked)');
        break;
      case 'doubleRent':
        fail('Double The Rent must be played together with a Rent card');
        break;
      default:
        fail('Unknown action');
    }

    this.takeFromHand(p, card.id);
    this.playsLeft--;

    if (a === 'house' || a === 'hotel') {
      setObj[a] = card;
      this.addLog(`${p.name} added a ${card.name} to their ${COLORS[setObj.color].name} set.`);
      return;
    }

    this.discard.push(card);
    switch (a) {
      case 'passGo': {
        const n = this.draw(p, RULES.passGoDraw);
        this.addLog(`${p.name} played ${card.name} and drew ${n} cards.`);
        return;
      }
      case 'birthday':
        this.addLog(`${p.name} played ${card.name}: everyone pays ${money(RULES.birthdayAmount)}.`);
        this.createPending(p, 'charge', this.players.filter((x) => x !== p), {
          amount: RULES.birthdayAmount, label: `${card.name}! Pay ${money(RULES.birthdayAmount)} to ${p.name}`,
        });
        return;
      case 'debtCollector':
        this.addLog(`${p.name} played ${card.name} on ${t.name} (${money(RULES.debtCollectorAmount)}).`);
        this.createPending(p, 'charge', [t], {
          amount: RULES.debtCollectorAmount, label: `${card.name}: pay ${money(RULES.debtCollectorAmount)} to ${p.name}`,
        });
        return;
      case 'slyDeal':
        this.addLog(`${p.name} played ${card.name} on ${t.name}, targeting ${target.card.name}.`);
        this.createPending(p, 'slyDeal', [t], {
          targetCardId: target.card.id, label: `${card.name}: ${p.name} wants to steal your ${target.card.name}`,
        });
        return;
      case 'forcedDeal':
        this.addLog(`${p.name} played ${card.name} on ${t.name}: ${mine.card.name} ⇄ ${target.card.name}.`);
        this.createPending(p, 'forcedDeal', [t], {
          targetCardId: target.card.id, myCardId: mine.card.id,
          label: `${card.name}: ${p.name} wants to swap their ${mine.card.name} for your ${target.card.name}`,
        });
        return;
      case 'dealBreaker':
        this.addLog(`${p.name} played ${card.name} on ${t.name}'s ${COLORS[setObj.color].name} set.`);
        this.createPending(p, 'dealBreaker', [t], {
          setId: setObj.id, label: `${card.name}: ${p.name} wants to steal your complete ${COLORS[setObj.color].name} set`,
        });
        return;
    }
  }

  cmdRent(p, { cardId, color, targetId, doubleIds = [] }) {
    this.requireTurn(p);
    const card = this.handCard(p, cardId);
    if (card.type !== 'rent') fail('Not a rent card');
    if (card.colors !== 'any' && !card.colors.includes(color)) fail('This rent card does not cover that color');
    if (!COLORS[color]) fail('Choose a color');
    const sets = p.sets.filter((s) => s.color === color);
    const rent = Math.max(0, ...sets.map(setRent));
    if (rent <= 0) fail(`You have no ${COLORS[color].name} properties to charge rent on`);
    if (!Array.isArray(doubleIds)) doubleIds = [];
    doubleIds = [...new Set(doubleIds)];
    for (const id of doubleIds) {
      const d = this.handCard(p, id);
      if (d.type !== 'action' || d.action !== 'doubleRent') fail('Only Double The Rent can be added');
    }
    if (1 + doubleIds.length > this.playsLeft) fail('Not enough plays left for that many Double The Rent cards');
    let targets;
    if (card.colors === 'any') targets = [this.otherPlayer(p, targetId)];
    else targets = this.players.filter((x) => x !== p);

    this.takeFromHand(p, cardId);
    this.discard.push(card);
    for (const id of doubleIds) this.discard.push(this.takeFromHand(p, id));
    this.playsLeft -= 1 + doubleIds.length;
    const amount = rent * 2 ** doubleIds.length;
    const who = targets.length === 1 ? targets[0].name : 'everyone';
    this.addLog(`${p.name} charged ${who} ${money(amount)} rent on ${COLORS[color].name}${doubleIds.length ? ` (doubled${doubleIds.length > 1 ? ' twice' : ''})` : ''}.`);
    this.createPending(p, 'charge', targets, {
      amount, label: `Rent: pay ${money(amount)} to ${p.name} for ${COLORS[color].name}`,
    });
  }

  // ---------- pending actions (responses, Just Say No, payments) ----------
  createPending(actor, kind, targets, data) {
    this.pending = {
      id: this.nextPendingId++, kind, actorId: actor.id, ...data,
      targets: targets.map((t) => ({ id: t.id, stage: 'respond', outcome: null, jsnCount: 0 })),
    };
    for (const t of this.pending.targets) this.autoResolve(t);
    this.maybeFinishPending();
  }

  // A target who owes money but has nothing to pay and no Just Say No resolves automatically.
  autoResolve(entry) {
    if (!this.pending || this.pending.kind !== 'charge' || entry.stage !== 'respond') return;
    const t = this.player(entry.id);
    const hasJsn = t.hand.some((c) => c.action === 'justSayNo');
    if (!hasJsn && this.payableCards(t).length === 0) {
      entry.stage = 'done';
      entry.outcome = 'broke';
      this.addLog(`${t.name} has nothing to pay.`);
    }
  }

  cmdRespond(p, { choice, targetId }) {
    const pd = this.pending;
    if (!pd || this.phase !== 'playing') fail('Nothing to respond to');
    let entry;
    if (p.id === pd.actorId) {
      entry = pd.targets.find((t) => t.id === targetId && t.stage === 'counter');
      if (!entry) fail('Nothing to respond to');
    } else {
      entry = pd.targets.find((t) => t.id === p.id);
      if (!entry || entry.stage !== 'respond') fail('Nothing to respond to');
    }
    const actor = this.player(pd.actorId);
    const target = this.player(entry.id);

    if (choice === 'jsn') {
      const jsn = p.hand.find((c) => c.type === 'action' && c.action === 'justSayNo');
      if (!jsn) fail("You don't have a Just Say No");
      this.discard.push(this.takeFromHand(p, jsn.id));
      entry.jsnCount++;
      if (entry.stage === 'respond') {
        entry.stage = 'counter';
        this.addLog(`${p.name} said "Just Say No!" to ${actor.name}.`);
      } else {
        entry.stage = 'respond';
        this.addLog(`${p.name} countered ${target.name}'s Just Say No with another!`);
        this.autoResolve(entry);
      }
    } else if (choice === 'accept') {
      if (entry.stage === 'counter') {
        entry.stage = 'done';
        entry.outcome = 'blocked';
        this.addLog(`${target.name} blocked ${actor.name}'s action.`);
      } else {
        if (pd.kind === 'charge') fail('Choose cards to pay with');
        this.executeSteal(actor, target);
        entry.stage = 'done';
        entry.outcome = 'accepted';
      }
    } else {
      fail('Invalid response');
    }
    this.maybeFinishPending();
  }

  executeSteal(actor, target) {
    const pd = this.pending;
    if (pd.kind === 'slyDeal') {
      const { card, color } = this.removeProperty(target, pd.targetCardId);
      this.normalize(target);
      this.addProperty(actor, card, color);
      this.addLog(`${actor.name} stole ${card.name} from ${target.name}.`);
    } else if (pd.kind === 'forcedDeal') {
      const theirs = this.removeProperty(target, pd.targetCardId);
      const mine = this.removeProperty(actor, pd.myCardId);
      this.normalize(target); this.normalize(actor);
      this.addProperty(actor, theirs.card, theirs.color);
      this.addProperty(target, mine.card, mine.color);
      this.addLog(`${actor.name} swapped ${mine.card.name} for ${target.name}'s ${theirs.card.name}.`);
    } else if (pd.kind === 'dealBreaker') {
      const set = target.sets.find((s) => s.id === pd.setId);
      if (!set) fail('That set is gone');
      target.sets = target.sets.filter((s) => s !== set);
      actor.sets.push(set);
      this.normalize(target); this.normalize(actor);
      this.addLog(`${actor.name} took ${target.name}'s ${COLORS[set.color].name} set!`);
    }
  }

  cmdPay(p, { cardIds }) {
    const pd = this.pending;
    if (!pd || pd.kind !== 'charge') fail('Nothing to pay');
    const entry = pd.targets.find((t) => t.id === p.id);
    if (!entry || entry.stage !== 'respond') fail('Nothing to pay');
    if (!Array.isArray(cardIds)) fail('Choose cards to pay with');
    const payable = this.payableCards(p);
    const byId = new Map(payable.map((c) => [c.id, c]));
    const ids = [...new Set(cardIds)];
    for (const id of ids) if (!byId.has(id)) fail('You cannot pay with that card');
    const total = ids.reduce((s, id) => s + byId.get(id).value, 0);
    if (total < pd.amount && ids.length < payable.length) fail(`You owe ${money(pd.amount)} — select more (or everything you have)`);

    const actor = this.player(pd.actorId);
    const got = [];
    for (const id of ids) {
      const card = byId.get(id);
      const bi = p.bank.findIndex((c) => c.id === id);
      if (bi >= 0) { p.bank.splice(bi, 1); actor.bank.push(card); got.push(card.name); continue; }
      const found = this.findPropertyCard(p, id);
      if (found) {
        const { color } = this.removeProperty(p, id);
        this.addProperty(actor, card, color);
        got.push(card.name);
        continue;
      }
      const bs = p.sets.find((s) => s.house === card || s.hotel === card);
      if (bs) {
        if (bs.house === card) bs.house = null; else bs.hotel = null;
        actor.bank.push(card);
        got.push(card.name);
      }
    }
    this.normalize(p);
    this.normalize(actor);
    entry.stage = 'done';
    entry.outcome = 'paid';
    this.addLog(`${p.name} paid ${actor.name} ${money(total)}${got.length ? ` (${got.join(', ')})` : ''}.`);
    this.maybeFinishPending();
  }

  maybeFinishPending() {
    if (this.pending && this.pending.targets.every((t) => t.stage === 'done')) this.pending = null;
  }

  // ---------- views ----------
  publicSet(s) {
    return { id: s.id, color: s.color, cards: s.cards, house: s.house, hotel: s.hotel, complete: isComplete(s), rent: setRent(s) };
  }

  viewFor(playerId) {
    const me = this.player(playerId);
    const cur = this.phase === 'playing' ? this.current : null;
    return {
      code: this.code,
      seq: this.seq,
      phase: this.phase,
      you: playerId,
      hostId: this.hostId,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        connected: p.connected,
        handCount: p.hand.length,
        bank: p.bank,
        bankTotal: p.bank.reduce((s, c) => s + c.value, 0),
        sets: p.sets.map((s) => this.publicSet(s)),
        completeCount: this.completeColors(p),
      })),
      hand: me ? me.hand : [],
      deckCount: this.deck.length,
      discardCount: this.discard.length,
      discardTop: this.discard[this.discard.length - 1] || null,
      turn: cur ? { playerId: cur.id, playsLeft: this.playsLeft, discardNeeded: this.discardNeeded } : null,
      pending: this.pending,
      winnerId: this.winnerId,
      log: this.log.slice(-60),
      config: { colors: COLORS, rules: RULES },
    };
  }
}

const api = { Game, GameError, isComplete, setRent, canBeColor };
if (typeof module !== 'undefined') module.exports = api; else window.MMGame = api;
})();

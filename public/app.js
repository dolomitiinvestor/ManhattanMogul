// Manhattan Mogul client. Renders server state; every rule is enforced server-side.
(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const M = (n) => `$${n}M`;

  let ws = null;
  let S = null;              // latest state from server
  let rejoining = false;
  const ui = {
    modal: null,             // user-opened dialog/wizard
    paySel: new Set(),
    discardSel: new Set(),
    pendingKey: null,
    hideForced: false,
    lastTurnKey: null,
    chat: [],
    lastLogN: 0,
  };

  // ---------- session ----------
  const session = {
    load() { try { return JSON.parse(localStorage.getItem('mm-session')); } catch { return null; } },
    save(code, token) { try { localStorage.setItem('mm-session', JSON.stringify({ code, token })); } catch {} },
    clear() { try { localStorage.removeItem('mm-session'); } catch {} },
  };
  const savedName = () => { try { return localStorage.getItem('mm-name') || ''; } catch { return ''; } };
  const saveName = (n) => { try { localStorage.setItem('mm-name', n); } catch {} };

  // ---------- networking ----------
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);
    ws.onopen = () => {
      $('#conn').classList.add('hidden');
      const s = session.load();
      if (s) { rejoining = true; raw({ type: 'join', code: s.code, token: s.token, name: savedName() }); }
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'joined') {
        rejoining = false;
        session.save(msg.code, msg.token);
        const url = new URL(location.href);
        url.searchParams.set('room', msg.code);
        history.replaceState(null, '', url);
      } else if (msg.type === 'state') {
        onState(msg.state);
      } else if (msg.type === 'error') {
        if (rejoining) { rejoining = false; session.clear(); S = null; render(); }
        toast(msg.message, 'err');
      } else if (msg.type === 'chat') {
        ui.chat.push({ from: msg.from, text: msg.text });
        renderLog();
        if ($('#side').classList.contains('hidden')) toast(`💬 ${msg.from}: ${msg.text}`);
      } else if (msg.type === 'kicked' || msg.type === 'left') {
        if (msg.type === 'kicked') toast('You were removed from the game', 'err');
        session.clear(); S = null; ui.modal = null;
        const url = new URL(location.href); url.searchParams.delete('room'); history.replaceState(null, '', url);
        render();
      }
    };
    ws.onclose = () => {
      $('#conn').classList.remove('hidden');
      setTimeout(connect, 1500);
    };
  }
  const raw = (obj) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); else toast('Not connected', 'err'); };
  const cmd = (obj) => { ui.modal = null; raw({ type: 'cmd', ...obj }); };

  // ---------- state helpers ----------
  const me = () => S && S.players.find((p) => p.id === S.you);
  const pl = (id) => S && S.players.find((p) => p.id === id);
  const col = (c) => S.config.colors[c];
  const myTurn = () => S && S.phase === 'playing' && S.turn && S.turn.playerId === S.you;
  const canPlay = () => myTurn() && !S.pending && !S.turn.discardNeeded && S.turn.playsLeft > 0;
  const handCard = (id) => S.hand.find((c) => c.id === id);
  const hasJsn = () => S.hand.some((c) => c.action === 'justSayNo');

  function textOn(hex) {
    const h = hex.replace('#', '');
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? '#111' : '#fff';
  }

  function payableOf(p) {
    const out = p.bank.filter((c) => c.value > 0).map((c) => ({ card: c, where: 'bank' }));
    for (const s of p.sets) {
      for (const c of s.cards) if (c.value > 0) out.push({ card: c, where: 'set', color: s.color });
      if (s.house) out.push({ card: s.house, where: 'building' });
      if (s.hotel) out.push({ card: s.hotel, where: 'building' });
    }
    return out;
  }

  function onState(state) {
    const prev = S;
    S = state;
    // Reset per-pending selections.
    const pk = S.pending ? S.pending.id : null;
    if (pk !== ui.pendingKey) { ui.pendingKey = pk; ui.paySel = new Set(); ui.hideForced = false; }
    if (!S.turn || !S.turn.discardNeeded) ui.discardSel = new Set();
    // Drop a wizard that no longer makes sense.
    if (ui.modal && ui.modal.cardId && ui.modal.kind !== 'move' && !handCard(ui.modal.cardId)) ui.modal = null;
    if (ui.modal && ui.modal.kind !== 'rules' && S.phase !== 'playing') ui.modal = null;
    // Notifications
    const tk = S.turn ? `${S.turn.playerId}:${S.log.length ? S.log[S.log.length - 1].n : 0}` : null;
    if (S.turn && S.turn.playerId === S.you && (!prev || !prev.turn || prev.turn.playerId !== S.you)) {
      toast("🎲 It's your turn!", 'good');
      if (navigator.vibrate) navigator.vibrate(120);
    }
    ui.lastTurnKey = tk;
    if (forcedModal() && navigator.vibrate && (!prev || !prev.pending || prev.pending.id !== S.pending?.id)) navigator.vibrate([80, 60, 80]);
    render();
  }

  // ---------- card rendering ----------
  function rentLadder(color, highlight) {
    const c = col(color);
    return `<div class="ladder">${c.rent.map((r, i) => `<div class="${highlight && i + 1 === highlight ? 'hl' : ''}"><span>${i + 1}${i + 1 === c.size ? '★' : ''}</span><b>${M(r)}</b></div>`).join('')}</div>`;
  }

  function band(color, label) {
    const c = col(color);
    return `<div class="band" style="background:${c.hex};color:${textOn(c.hex)}">${esc(label)}</div>`;
  }

  function splitBand(colors, label) {
    if (colors === 'any') return `<div class="band rainbow">${esc(label)}</div>`;
    const [a, b] = colors.map(col);
    return `<div class="band split" style="background:linear-gradient(135deg, ${a.hex} 50%, ${b.hex} 50%)"><span>${esc(label)}</span></div>`;
  }

  // o: { mini, color (current color on table), sel, a (data-a), attrs, dim }
  function cardHTML(c, o = {}) {
    const cls = ['card', `t-${c.type}`, o.mini ? 'mini' : '', o.sel ? 'sel' : '', o.a ? 'clickable' : '', o.dim ? 'dim' : ''].join(' ');
    const data = o.a ? `data-a="${o.a}" data-id="${c.id}"` : '';
    const val = c.value > 0 ? `<div class="val">${c.value}</div>` : '';
    let inner = '';
    if (c.type === 'money') {
      inner = `<div class="money-v">${M(c.value)}</div>`;
    } else if (c.type === 'property') {
      inner = o.mini ? band(c.color, c.name) : band(c.color, c.name) + rentLadder(c.color);
    } else if (c.type === 'wild') {
      if (o.mini && o.color) {
        const h = col(o.color).hex;
        inner = `<div class="band ${c.colors === 'any' ? 'rainbow-edge' : ''}" style="background:${h};color:${textOn(h)}">Wild · ${esc(col(o.color).name)}</div>`;
      } else {
        inner = splitBand(c.colors, c.colors === 'any' ? 'Wild · any color' : 'Wild');
        if (!o.mini) {
          inner += c.colors === 'any'
            ? '<div class="desc">Use as any color. No cash value.</div>'
            : `<div class="two-ladders">${c.colors.map((k) => `<div><small>${esc(col(k).name)}</small>${rentLadder(k)}</div>`).join('')}</div>`;
        }
      }
    } else if (c.type === 'action') {
      inner = `<div class="act-title">${esc(c.name)}</div>${o.mini ? '' : `<div class="desc">${esc(c.desc)}</div>`}`;
    } else if (c.type === 'rent') {
      inner = splitBand(c.colors, c.colors === 'any' ? 'Wild Rent' : 'Rent') + (o.mini ? '' : `<div class="desc">${esc(c.desc)}</div>`);
    }
    return `<div class="${cls}" ${data} ${o.attrs || ''}>${val}${inner}</div>`;
  }

  function setHTML(s, o = {}) {
    const c = col(s.color);
    const bld = `${s.house ? '<span class="bld" title="House">🏠</span>' : ''}${s.hotel ? '<span class="bld" title="Hotel">🏨</span>' : ''}`;
    const data = o.a ? `data-a="${o.a}" data-id="${s.id}"` : '';
    return `<div class="set ${s.complete ? 'complete' : ''} ${o.a ? 'clickable' : ''} ${o.sel ? 'sel' : ''}" ${data} style="--c:${c.hex}">
      <div class="set-head"><span>${esc(c.name)} ${s.cards.length}/${c.size}</span>${bld}<span class="rent">${M(s.rent)}</span></div>
      <div class="set-cards">${s.cards.map((card) => cardHTML(card, { mini: true, color: s.color, a: o.cardA ? o.cardA(card, s) : null, sel: o.cardSel && o.cardSel(card), dim: o.cardDim && o.cardDim(card, s) })).join('')}
      ${s.house ? cardHTML(s.house, { mini: true, a: o.bldA, sel: o.cardSel && o.cardSel(s.house) }) : ''}
      ${s.hotel ? cardHTML(s.hotel, { mini: true, a: o.bldA, sel: o.cardSel && o.cardSel(s.hotel) }) : ''}</div>
    </div>`;
  }

  // ---------- screens ----------
  function render() {
    const app = $('#app');
    const keep = {};
    app.querySelectorAll('[data-keep]').forEach((el) => { keep[el.dataset.keep] = [el.scrollLeft, el.scrollTop]; });
    if (!S) app.innerHTML = homeHTML();
    else if (S.phase === 'lobby') app.innerHTML = lobbyHTML();
    else app.innerHTML = gameHTML();
    app.querySelectorAll('[data-keep]').forEach((el) => { const k = keep[el.dataset.keep]; if (k) { el.scrollLeft = k[0]; el.scrollTop = k[1]; } });
    $('#side').classList.toggle('in-game', !!S && S.phase !== 'lobby');
    if (!S || S.phase === 'lobby') $('#side').classList.add('hidden');
    renderModal();
    renderLog();
    document.title = S && S.phase === 'playing' && myTurn() ? '▶ Your turn — Manhattan Mogul' : 'Manhattan Mogul';
  }

  function homeHTML() {
    const room = new URLSearchParams(location.search).get('room') || '';
    return `<div class="home">
      <div class="logo">🏙️</div>
      <h1>Manhattan Mogul</h1>
      <p class="sub">The fast property-trading card game. 2–10 players, any device.</p>
      <div class="panel">
        <label>Your name<input id="name" maxlength="20" value="${esc(savedName())}" placeholder="e.g. Alex"></label>
        <button class="btn primary big" data-a="create">Create new game</button>
        <div class="or">or join a friend</div>
        <div class="row">
          <input id="code" maxlength="4" placeholder="CODE" value="${esc(room)}" style="text-transform:uppercase">
          <button class="btn big" data-a="join">Join</button>
        </div>
      </div>
      <button class="btn link" data-a="rules">How to play</button>
    </div>`;
  }

  function lobbyHTML() {
    const isHost = S.hostId === S.you;
    const link = `${location.origin}${location.pathname}?room=${S.code}`;
    return `<div class="home lobby">
      <h2>Game lobby</h2>
      <div class="code-box"><small>Room code</small><div class="code">${esc(S.code)}</div></div>
      <div class="share"><input readonly value="${esc(link)}"><button class="btn" data-a="copyLink">Copy link</button></div>
      <p class="sub">Friends can open the link or enter the code on their own phone or computer.</p>
      <div class="panel">
        <h3>Players (${S.players.length}/${S.config.rules.maxPlayers})</h3>
        <ul class="plist">${S.players.map((p) => `<li><span class="dot ${p.connected ? 'on' : ''}"></span>${esc(p.name)}${p.id === S.hostId ? ' <em>host</em>' : ''}${p.id === S.you ? ' <em>you</em>' : ''}
          ${isHost && p.id !== S.you ? `<button class="btn tiny" data-a="kick" data-id="${p.id}">remove</button>` : ''}</li>`).join('')}</ul>
        ${isHost
          ? `<button class="btn primary big" data-a="start" ${S.players.length < S.config.rules.minPlayers ? 'disabled' : ''}>${S.players.length < S.config.rules.minPlayers ? 'Waiting for players…' : 'Start game'}</button>`
          : '<p class="sub">Waiting for the host to start…</p>'}
      </div>
      <div class="row center"><button class="btn link" data-a="rules">How to play</button><button class="btn link" data-a="leave">Leave</button></div>
    </div>`;
  }

  function statusText() {
    if (S.phase === 'ended') {
      const w = pl(S.winnerId);
      return w ? `🏆 ${esc(w.name)} wins!` : 'Game over';
    }
    const cur = pl(S.turn.playerId);
    if (S.pending) {
      const pd = S.pending;
      const actor = pl(pd.actorId);
      const waiting = pd.targets.filter((t) => t.stage !== 'done').map((t) => (t.stage === 'counter' ? actor.name : pl(t.id)?.name)).filter(Boolean);
      return `${esc(pd.label.replace(/ your /, ' a '))} — waiting on ${esc([...new Set(waiting)].join(', '))}`;
    }
    if (myTurn()) {
      if (S.turn.discardNeeded) return `Discard ${S.turn.discardNeeded} card(s) to end your turn`;
      return S.turn.playsLeft > 0
        ? `Your turn — <b>${S.turn.playsLeft}</b> play${S.turn.playsLeft === 1 ? '' : 's'} left. Tap a card in your hand.`
        : 'No plays left — rearrange wilds or end your turn.';
    }
    return `${esc(cur.name)}'s turn (${S.turn.playsLeft} play${S.turn.playsLeft === 1 ? '' : 's'} left)`;
  }

  function oppHTML(p) {
    const isTurn = S.turn && S.turn.playerId === p.id;
    const isHost = S.hostId === S.you;
    return `<div class="opp ${isTurn ? 'turn' : ''}">
      <div class="opp-head">
        <span class="dot ${p.connected ? 'on' : ''}"></span><b>${esc(p.name)}</b>
        ${isHost && !p.connected ? `<button class="btn tiny" data-a="kick" data-id="${p.id}" title="Remove disconnected player">✕</button>` : ''}
      </div>
      <div class="opp-stats">
        <span title="Cards in hand">🂠 ${p.handCount}</span>
        <span title="Bank">💰 ${M(p.bankTotal)}</span>
        <span title="Complete sets">🏁 ${p.completeCount}/${S.config.rules.setsToWin}</span>
      </div>
      <div class="opp-sets">${p.sets.length ? p.sets.map((s) => setHTML(s)).join('') : '<span class="muted">No properties</span>'}</div>
    </div>`;
  }

  function gameHTML() {
    const m = me();
    const others = S.players.filter((p) => p.id !== S.you);
    // Put opponents in turn order after me.
    const myIdx = S.players.findIndex((p) => p.id === S.you);
    const ordered = [...S.players.slice(myIdx + 1), ...S.players.slice(0, Math.max(0, myIdx))].filter((p) => p.id !== S.you);
    const turnOn = myTurn() && !S.pending && !S.turn.discardNeeded;
    const forced = forcedModal();
    return `<div class="game">
      <header class="topbar">
        <div class="tb-left"><span class="room">${esc(S.code)}</span></div>
        <div class="tb-mid">
          <span class="pile" title="Draw pile">🂠 ${S.deckCount}</span>
          <span class="pile" title="Discard pile">🗑 ${S.discardCount}${S.discardTop ? ` · ${esc(S.discardTop.name)}` : ''}</span>
        </div>
        <div class="tb-right">
          <button class="btn tiny" data-a="rules">Rules</button>
          <button class="btn tiny" data-a="toggleLog">Log${ui.chat.length ? ' 💬' : ''}</button>
          <button class="btn tiny" data-a="leave">Leave</button>
        </div>
      </header>
      <section class="opps" data-keep="opps">${(ordered.length ? ordered : others).map(oppHTML).join('')}</section>
      <section class="status ${myTurn() ? 'mine' : ''}">
        <span>${statusText()}</span>
        ${forced && ui.hideForced ? '<button class="btn primary tiny" data-a="showForced">Respond</button>' : ''}
      </section>
      <section class="me-area">
        <div class="me-head">
          <b>${esc(m.name)} (you)</b>
          <span>💰 Bank ${M(m.bankTotal)}</span>
          <span>🏁 ${m.completeCount}/${S.config.rules.setsToWin} sets</span>
        </div>
        <div class="my-table" data-keep="table">
          ${m.sets.length ? m.sets.map((s) => setHTML(s, { cardA: (c) => (c.type === 'wild' && turnOn ? 'tableCard' : null) })).join('') : '<span class="muted">Play property cards here to build sets.</span>'}
        </div>
        <div class="my-bank" data-keep="bank">${m.bank.length ? m.bank.map((c) => cardHTML(c, { mini: true })).join('') : '<span class="muted">Bank is empty</span>'}</div>
      </section>
      <section class="handbar">
        <div class="hand" data-keep="hand">${S.hand.map((c) => cardHTML(c, { a: 'hand' })).join('') || '<span class="muted">No cards in hand</span>'}</div>
        <div class="hand-actions">
          ${myTurn() && !S.pending && !S.turn.discardNeeded ? `<button class="btn ${S.turn.playsLeft === 0 ? 'primary pulse' : ''}" data-a="endTurn">End turn</button>` : ''}
          <span class="muted small">${S.hand.length} card${S.hand.length === 1 ? '' : 's'}</span>
        </div>
      </section>
    </div>`;
  }

  // ---------- log & chat ----------
  function renderLog() {
    const el = $('#log');
    if (!S) { el.innerHTML = ''; return; }
    const items = S.log.map((l) => `<div class="l">${esc(l.text)}</div>`).join('');
    const chat = ui.chat.slice(-30).map((c) => `<div class="l chat"><b>${esc(c.from)}:</b> ${esc(c.text)}</div>`).join('');
    el.innerHTML = items + (chat ? `<div class="l sep">Chat</div>${chat}` : '');
    el.scrollTop = el.scrollHeight;
  }

  // ---------- modals ----------
  // Modals the game forces on you (you must respond before play continues).
  function forcedModal() {
    if (!S || S.phase === 'lobby') return null;
    if (S.phase === 'ended') return { kind: 'ended' };
    const pd = S.pending;
    if (pd) {
      if (pd.actorId === S.you) {
        const e = pd.targets.find((t) => t.stage === 'counter');
        if (e) return { kind: 'counter', entry: e };
      } else {
        const e = pd.targets.find((t) => t.id === S.you && t.stage === 'respond');
        if (e) return { kind: pd.kind === 'charge' ? 'pay' : 'steal', entry: e };
      }
    }
    if (myTurn() && S.turn.discardNeeded) return { kind: 'discard' };
    return null;
  }

  function modalWrap(title, body, { closable = true, footer = '', wide = false, minimize = false } = {}) {
    return `<div class="overlay" ${closable ? 'data-a="closeBg"' : ''}>
      <div class="modal ${wide ? 'wide' : ''}" role="dialog">
        <div class="modal-head"><h3>${title}</h3>
          ${minimize ? '<button class="btn tiny" data-a="hideForced">View board</button>' : ''}
          ${closable ? '<button class="icon-btn" data-a="close" aria-label="Close">✕</button>' : ''}
        </div>
        <div class="modal-body">${body}</div>
        ${footer ? `<div class="modal-foot">${footer}</div>` : ''}
      </div>
    </div>`;
  }

  function renderModal() {
    const root = $('#modal-root');
    const bodyScroll = root.querySelector('.modal-body');
    const prevScroll = bodyScroll ? bodyScroll.scrollTop : 0;
    const wasOpen = !!root.querySelector('.overlay');
    let html = '';
    const forced = forcedModal();
    if (ui.modal && ui.modal.kind === 'rules') html = rulesModal();
    else if (forced && !(ui.hideForced && forced.kind !== 'ended')) html = forcedHTML(forced);
    else if (ui.modal && S) html = wizardHTML();
    root.innerHTML = html;
    // Only animate a modal when it first opens, not on every state update.
    if (wasOpen) root.querySelector('.overlay')?.classList.add('noanim');
    const nb = root.querySelector('.modal-body');
    if (nb) nb.scrollTop = prevScroll;
  }

  function forcedHTML(f) {
    const pd = S.pending;
    if (f.kind === 'ended') {
      const w = pl(S.winnerId);
      const isHost = S.hostId === S.you;
      const body = `<div class="winner"><div class="trophy">🏆</div><h2>${w ? esc(w.name) : 'Nobody'} wins!</h2>
        ${w ? `<div class="win-sets">${w.sets.filter((s) => s.complete).map((s) => setHTML(s)).join('')}</div>` : ''}</div>`;
      return modalWrap('Game over', body, {
        closable: false,
        footer: isHost ? '<button class="btn primary" data-a="backLobby">Play again</button>' : '<span class="muted">Waiting for the host to start a new game…</span>',
      });
    }
    if (f.kind === 'counter') {
      const t = pl(f.entry.id);
      const body = `<p class="big-msg"><b>${esc(t.name)}</b> played <b>Just Say No!</b> against your action.</p>
        <p class="muted">${esc(pd.label)}</p>`;
      return modalWrap('Blocked!', body, {
        closable: false, minimize: true,
        footer: `${hasJsn() ? `<button class="btn danger" data-a="jsn" data-target="${t.id}">Just Say No back!</button>` : ''}
          <button class="btn" data-a="accept" data-target="${t.id}">Accept</button>`,
      });
    }
    if (f.kind === 'steal') {
      const actor = pl(pd.actorId);
      let detail = '';
      const m = me();
      if (pd.kind === 'slyDeal' || pd.kind === 'forcedDeal') {
        const theirs = m.sets.flatMap((s) => s.cards.map((c) => ({ c, s }))).find((x) => x.c.id === pd.targetCardId);
        detail += theirs ? `<div class="deal-row"><div><small>You lose</small>${cardHTML(theirs.c, { color: theirs.s.color })}</div>` : '<div class="deal-row">';
        if (pd.kind === 'forcedDeal') {
          const mine = actor.sets.flatMap((s) => s.cards.map((c) => ({ c, s }))).find((x) => x.c.id === pd.myCardId);
          if (mine) detail += `<div class="swap">⇄</div><div><small>You get</small>${cardHTML(mine.c, { color: mine.s.color })}</div>`;
        }
        detail += '</div>';
      } else if (pd.kind === 'dealBreaker') {
        const s = m.sets.find((x) => x.id === pd.setId);
        if (s) detail = `<div class="deal-row">${setHTML(s)}</div>`;
      }
      const body = `<p class="big-msg">${esc(pd.label)}</p>${detail}`;
      return modalWrap(`${esc(actor.name)} is making a move`, body, {
        closable: false, minimize: true,
        footer: `${hasJsn() ? '<button class="btn danger" data-a="jsn">Just Say No!</button>' : ''}<button class="btn" data-a="accept">Accept</button>`,
      });
    }
    if (f.kind === 'pay') {
      const m = me();
      const items = payableOf(m);
      const total = items.reduce((s, x) => s + x.card.value, 0);
      const sel = items.filter((x) => ui.paySel.has(x.card.id));
      const selTotal = sel.reduce((s, x) => s + x.card.value, 0);
      const all = sel.length === items.length;
      const ok = selTotal >= pd.amount || all;
      const bankItems = items.filter((x) => x.where === 'bank');
      const body = `<p class="big-msg">${esc(pd.label)}</p>
        ${total <= pd.amount ? `<p class="warn">You only have ${M(total)} on the table — you must hand over everything.</p>` : '<p class="muted">Tap cards to pay with. No change is given. Properties you give go to their table.</p>'}
        <h4>Bank</h4><div class="pick-row">${bankItems.length ? bankItems.map((x) => cardHTML(x.card, { mini: true, a: 'paySel', sel: ui.paySel.has(x.card.id) })).join('') : '<span class="muted">Empty</span>'}</div>
        <h4>Properties</h4><div class="pick-sets">${m.sets.length ? m.sets.map((s) => setHTML(s, {
          cardA: (c) => (c.value > 0 ? 'paySel' : null), bldA: 'paySel', cardSel: (c) => ui.paySel.has(c.id), cardDim: (c) => c.value === 0,
        })).join('') : '<span class="muted">None</span>'}</div>`;
      return modalWrap(`Pay ${M(pd.amount)}`, body, {
        closable: false, minimize: true, wide: true,
        footer: `<span class="pay-total ${ok ? 'ok' : ''}">Selected ${M(selTotal)} / ${M(pd.amount)}</span>
          ${hasJsn() ? '<button class="btn danger" data-a="jsn">Just Say No!</button>' : ''}
          ${total <= pd.amount ? '<button class="btn" data-a="payAll">Select all</button>' : ''}
          <button class="btn primary" data-a="pay" ${ok ? '' : 'disabled'}>Pay</button>`,
      });
    }
    if (f.kind === 'discard') {
      const n = S.turn.discardNeeded;
      const body = `<p>You have ${S.hand.length} cards. The limit is ${S.config.rules.maxHand}. Choose <b>${n}</b> to discard.</p>
        <div class="pick-row wrap">${S.hand.map((c) => cardHTML(c, { a: 'discSel', sel: ui.discardSel.has(c.id) })).join('')}</div>`;
      return modalWrap('Too many cards', body, {
        closable: false, wide: true,
        footer: `<span>${ui.discardSel.size}/${n} selected</span><button class="btn primary" data-a="discard" ${ui.discardSel.size === n ? '' : 'disabled'}>Discard</button>`,
      });
    }
    return '';
  }

  function playerButtons(list, key) {
    return `<div class="choice-list">${list.map((p) => `<button class="btn choice" data-a="wiz" data-k="${key}" data-v="${p.id}">
      <b>${esc(p.name)}</b><small>💰 ${M(p.bankTotal)} · ${p.sets.reduce((n, s) => n + s.cards.length, 0)} properties</small></button>`).join('')}</div>`;
  }

  function wizardHTML() {
    const w = ui.modal;
    const m = me();
    const others = S.players.filter((p) => p.id !== S.you);
    const playOk = canPlay();

    if (w.kind === 'move') {
      const found = m.sets.flatMap((s) => s.cards.map((c) => ({ c, s }))).find((x) => x.c.id === w.cardId);
      if (!found) { ui.modal = null; return ''; }
      const colors = found.c.colors === 'any' ? Object.keys(S.config.colors) : found.c.colors;
      const body = `<div class="center">${cardHTML(found.c)}</div><p>Move this wild card to another color (free, doesn't use a play):</p>
        <div class="color-grid">${colors.filter((k) => k !== found.s.color).map((k) => colorBtn(k, 'move', w.cardId)).join('')}</div>`;
      return modalWrap('Move wild card', body);
    }

    const card = handCard(w.cardId);
    if (!card) return '';

    if (w.kind === 'card') {
      const opts = [];
      const disabled = playOk ? '' : 'disabled';
      if (card.type === 'property') {
        opts.push(`<button class="btn primary" data-a="playProp" data-id="${card.id}" data-color="${card.color}" ${disabled}>Play to table</button>`);
      } else if (card.type === 'wild') {
        const colors = card.colors === 'any' ? Object.keys(S.config.colors) : card.colors;
        opts.push(`<p class="muted">Play as:</p><div class="color-grid">${colors.map((k) => colorBtn(k, 'playProp', card.id, !playOk)).join('')}</div>`);
      } else if (card.type === 'rent') {
        opts.push(`<button class="btn primary" data-a="startRent" data-id="${card.id}" ${disabled}>Charge rent</button>`);
      } else if (card.type === 'action') {
        const a = card.action;
        if (a !== 'justSayNo' && a !== 'doubleRent') opts.push(`<button class="btn primary" data-a="startAction" data-id="${card.id}" ${disabled}>Play ${esc(card.name)}</button>`);
        if (a === 'justSayNo') opts.push('<p class="muted">Keep this to block an action against you — or bank it.</p>');
        if (a === 'doubleRent') opts.push('<p class="muted">Play this from the “Charge rent” option on a Rent card.</p>');
      }
      if (card.type !== 'property' && card.type !== 'wild') {
        opts.push(`<button class="btn" data-a="bank" data-id="${card.id}" ${disabled}>${card.type === 'money' ? 'Put in bank' : `Bank as ${M(card.value)}`}</button>`);
      }
      const note = !myTurn() ? '<p class="muted">Wait for your turn to play cards.</p>'
        : S.pending ? '<p class="muted">Waiting for responses…</p>'
        : S.turn.playsLeft <= 0 ? '<p class="muted">No plays left this turn.</p>' : '';
      return modalWrap(esc(card.name), `<div class="center">${cardHTML(card)}</div>${note}<div class="opts">${opts.join('')}</div>`);
    }

    if (w.kind === 'rent') {
      if (!w.color) {
        const colors = (card.colors === 'any' ? Object.keys(S.config.colors) : card.colors);
        const btns = colors.map((k) => {
          const rent = Math.max(0, ...m.sets.filter((s) => s.color === k).map((s) => s.rent));
          const c = col(k);
          return `<button class="btn color-btn" style="--c:${c.hex};--t:${textOn(c.hex)}" data-a="wiz" data-k="color" data-v="${k}" ${rent > 0 ? '' : 'disabled'}>${esc(c.name)}<small>${M(rent)}</small></button>`;
        }).join('');
        return modalWrap('Charge rent for which color?', `<div class="color-grid">${btns}</div>`);
      }
      if (card.colors === 'any' && !w.targetId) return modalWrap('Charge which player?', playerButtons(others, 'targetId'));
      if (w.doubles === undefined) {
        const doubles = S.hand.filter((c) => c.action === 'doubleRent');
        const maxD = Math.min(doubles.length, S.turn.playsLeft - 1);
        if (maxD <= 0) return '';
        const rent = Math.max(...m.sets.filter((s) => s.color === w.color).map((s) => s.rent));
        const btns = [0, 1, 2].filter((n) => n <= maxD).map((n) => `<button class="btn ${n ? 'primary' : ''}" data-a="wiz" data-k="doubles" data-v="${n}">${n === 0 ? 'No double' : n === 1 ? 'Double it' : 'Double twice'} — ${M(rent * 2 ** n)}</button>`).join('');
        return modalWrap('Add Double The Rent?', `<p>Each Double The Rent uses one extra play.</p><div class="opts">${btns}</div>`);
      }
      return '';
    }

    if (w.kind === 'action') {
      const a = card.action;
      if (a === 'debtCollector') return modalWrap(`${esc(card.name)}: who pays ${M(S.config.rules.debtCollectorAmount)}?`, playerButtons(others, 'targetId'));
      if (a === 'house' || a === 'hotel') {
        const ok = m.sets.filter((s) => s.complete && !col(s.color).noBuildings && (a === 'house' ? !s.house : s.house && !s.hotel));
        const body = ok.length ? `<p>Choose a set:</p><div class="pick-sets">${ok.map((s) => setHTML(s, { a: 'wiz-set' })).join('')}</div>`
          : `<p>You need a complete set${a === 'hotel' ? ' with a House' : ''} (not Railroad/Utility) to play this. You can bank it instead.</p>`;
        return modalWrap(`Place ${esc(card.name)}`, body);
      }
      if (a === 'dealBreaker') {
        const groups = others.map((p) => {
          const sets = p.sets.filter((s) => s.complete);
          return sets.length ? `<h4>${esc(p.name)}</h4><div class="pick-sets">${sets.map((s) => setHTML(s, { a: 'wiz-set', sel: false }).replace('data-a="wiz-set"', `data-a="wiz-set" data-owner="${p.id}"`)).join('')}</div>` : '';
        }).join('');
        return modalWrap('Deal Breaker: steal which set?', groups || '<p>No one has a complete set yet.</p>', { wide: true });
      }
      if (a === 'slyDeal' || (a === 'forcedDeal' && !w.targetCardId)) {
        const groups = others.map((p) => {
          const loose = p.sets.filter((s) => !s.complete);
          return loose.length ? `<h4>${esc(p.name)}</h4><div class="pick-sets">${loose.map((s) => setHTML(s, { cardA: () => 'wiz-card' }).replaceAll('data-a="wiz-card"', `data-a="wiz-card" data-owner="${p.id}"`)).join('')}</div>` : '';
        }).join('');
        return modalWrap(a === 'slyDeal' ? 'Sly Deal: steal which property?' : 'Forced Deal: take which property?', groups || '<p>No properties available to take (complete sets are protected).</p>', { wide: true });
      }
      if (a === 'forcedDeal') {
        const loose = m.sets.filter((s) => !s.complete);
        const body = loose.length ? `<div class="pick-sets">${loose.map((s) => setHTML(s, { cardA: () => 'wiz-mine' })).join('')}</div>` : '<p>You have no properties outside complete sets to trade.</p>';
        return modalWrap('Forced Deal: give which of yours?', body, { wide: true });
      }
    }
    return '';
  }

  function colorBtn(k, a, id, disabled) {
    const c = col(k);
    return `<button class="btn color-btn" style="--c:${c.hex};--t:${textOn(c.hex)}" data-a="${a}" data-id="${id}" data-color="${k}" ${disabled ? 'disabled' : ''}>${esc(c.name)}</button>`;
  }

  function sendRent(doubles) {
    const w = ui.modal;
    const doubleIds = S.hand.filter((c) => c.action === 'doubleRent').slice(0, doubles).map((c) => c.id);
    cmd({ cmd: 'rent', cardId: w.cardId, color: w.color, targetId: w.targetId, doubleIds });
  }

  function rulesModal() {
    const r = S ? S.config.rules : { setsToWin: 3, playsPerTurn: 3, maxHand: 7 };
    return modalWrap('How to play', `<div class="rules">
      <p><b>Goal:</b> be the first to collect <b>${r.setsToWin} complete property sets</b> of different colors.</p>
      <p><b>Your turn:</b> you draw 2 cards (5 if your hand is empty), then play up to <b>${r.playsPerTurn}</b> cards. At the end of your turn you can hold at most ${r.maxHand} cards.</p>
      <p><b>Ways to play a card:</b></p>
      <ul>
        <li><b>Bank it</b> — money and action/rent cards can be put in your bank as cash.</li>
        <li><b>Property</b> — place it on your table to build sets. Wild cards can be any of their colors, and you can re-arrange them for free on your turn.</li>
        <li><b>Action</b> — use its effect, then it's discarded.</li>
      </ul>
      <p><b>Paying:</b> when you owe money you pay from your bank and/or properties on the table. No change is given. If you can't cover it, you pay everything you have. Cards in your hand are safe.</p>
      <p><b>Rent:</b> two-color rent cards charge <i>everyone</i>; Wild Rent charges one player. Add Double The Rent (uses a play) to double it — twice to quadruple.</p>
      <p><b>Just Say No</b> cancels any action against you. It can be countered by another Just Say No.</p>
      <p><b>Houses/Hotels</b> go on complete sets (not Railroads/Utilities) and add $3M/$4M rent.</p>
      <p><b>Sly Deal / Forced Deal</b> can't take properties from complete sets. <b>Deal Breaker</b> steals a whole complete set.</p>
    </div>`);
  }

  // ---------- events ----------
  function startAction(card) {
    const a = card.action;
    if (a === 'passGo' || a === 'birthday') return cmd({ cmd: 'action', cardId: card.id });
    ui.modal = { kind: 'action', cardId: card.id };
    if (a === 'debtCollector' && S.players.length === 2) {
      return cmd({ cmd: 'action', cardId: card.id, targetId: S.players.find((p) => p.id !== S.you).id });
    }
    if (a === 'house' || a === 'hotel') {
      const ok = me().sets.filter((s) => s.complete && !col(s.color).noBuildings && (a === 'house' ? !s.house : s.house && !s.hotel));
      if (ok.length === 1) return cmd({ cmd: 'action', cardId: card.id, setId: ok[0].id });
    }
    render();
  }

  function startRent(card) {
    ui.modal = { kind: 'rent', cardId: card.id };
    const m = me();
    const colors = (card.colors === 'any' ? Object.keys(S.config.colors) : card.colors)
      .filter((k) => m.sets.some((s) => s.color === k && s.rent > 0));
    if (!colors.length) { ui.modal = null; toast("You don't own any properties this rent card can charge", 'err'); render(); return; }
    if (colors.length === 1) ui.modal.color = colors[0];
    if (card.colors === 'any' && S.players.length === 2) ui.modal.targetId = S.players.find((p) => p.id !== S.you).id;
    advanceRent();
  }

  // Send the rent right away once no more choices are needed.
  function advanceRent() {
    const w = ui.modal;
    const card = handCard(w.cardId);
    const maxD = Math.min(S.hand.filter((c) => c.action === 'doubleRent').length, S.turn.playsLeft - 1);
    if (w.color && (card.colors !== 'any' || w.targetId) && maxD <= 0) return sendRent(0);
    render();
  }

  function onWiz(k, v) {
    const w = ui.modal;
    if (!w) return;
    if (w.kind === 'rent') {
      if (k === 'doubles') return sendRent(Number(v));
      w[k] = v;
      return advanceRent();
    }
    if (w.kind === 'action') {
      const card = handCard(w.cardId);
      if (k === 'targetId' && card.action === 'debtCollector') return cmd({ cmd: 'action', cardId: w.cardId, targetId: v });
    }
  }

  document.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-a]');
    if (!el || el.disabled) return;
    const a = el.dataset.a;
    const id = el.dataset.id;
    if (a === 'closeBg' && ev.target !== el) return;
    ev.stopPropagation();
    switch (a) {
      case 'create': {
        const name = $('#name').value.trim();
        if (!name) { toast('Enter your name first', 'err'); $('#name').focus(); return; }
        saveName(name);
        raw({ type: 'create', name });
        break;
      }
      case 'join': {
        const name = $('#name').value.trim();
        const code = $('#code').value.trim().toUpperCase();
        if (!name) { toast('Enter your name first', 'err'); $('#name').focus(); return; }
        if (code.length !== 4) { toast('Enter the 4-letter room code', 'err'); return; }
        saveName(name);
        const s = session.load();
        raw({ type: 'join', code, name, token: s && s.code === code ? s.token : undefined });
        break;
      }
      case 'start': cmd({ cmd: 'start' }); break;
      case 'backLobby': cmd({ cmd: 'backToLobby' }); break;
      case 'leave':
        if (S && S.phase === 'playing' && !confirm('Leave the game? Your cards will be discarded.')) return;
        raw({ type: 'leave' });
        break;
      case 'kick':
        if (confirm(`Remove ${pl(id)?.name} from the game?`)) raw({ type: 'kick', playerId: id });
        break;
      case 'copyLink': {
        const link = `${location.origin}${location.pathname}?room=${S.code}`;
        if (navigator.share && /Mobi/i.test(navigator.userAgent)) navigator.share({ title: 'Join my game', url: link }).catch(() => {});
        else navigator.clipboard?.writeText(link).then(() => toast('Link copied', 'good'), () => toast(link));
        break;
      }
      case 'rules': ui.modal = { kind: 'rules' }; renderModal(); break;
      case 'close': case 'closeBg': ui.modal = null; renderModal(); break;
      case 'toggleLog': $('#side').classList.toggle('hidden'); renderLog(); break;
      case 'hand': ui.modal = { kind: 'card', cardId: id }; renderModal(); break;
      case 'bank': cmd({ cmd: 'bank', cardId: id }); break;
      case 'playProp': cmd({ cmd: 'property', cardId: id, color: el.dataset.color }); break;
      case 'startAction': startAction(handCard(id)); break;
      case 'startRent': startRent(handCard(id)); break;
      case 'wiz': onWiz(el.dataset.k, el.dataset.v); break;
      case 'wiz-set': {
        const w = ui.modal;
        const card = handCard(w.cardId);
        if (card.action === 'dealBreaker') cmd({ cmd: 'action', cardId: w.cardId, targetId: el.dataset.owner, setId: id });
        else cmd({ cmd: 'action', cardId: w.cardId, setId: id });
        break;
      }
      case 'wiz-card': {
        const w = ui.modal;
        const card = handCard(w.cardId);
        if (card.action === 'slyDeal') cmd({ cmd: 'action', cardId: w.cardId, targetId: el.dataset.owner, targetCardId: id });
        else { w.targetId = el.dataset.owner; w.targetCardId = id; renderModal(); }
        break;
      }
      case 'wiz-mine': {
        const w = ui.modal;
        cmd({ cmd: 'action', cardId: w.cardId, targetId: w.targetId, targetCardId: w.targetCardId, myCardId: id });
        break;
      }
      case 'tableCard': ui.modal = { kind: 'move', cardId: id }; renderModal(); break;
      case 'move': cmd({ cmd: 'move', cardId: id, color: el.dataset.color }); break;
      case 'endTurn': cmd({ cmd: 'endTurn' }); break;
      case 'paySel':
        if (ui.paySel.has(id)) ui.paySel.delete(id); else ui.paySel.add(id);
        renderModal();
        break;
      case 'payAll':
        for (const x of payableOf(me())) ui.paySel.add(x.card.id);
        renderModal();
        break;
      case 'pay': cmd({ cmd: 'pay', cardIds: [...ui.paySel] }); break;
      case 'jsn': cmd({ cmd: 'respond', choice: 'jsn', targetId: el.dataset.target }); break;
      case 'accept': cmd({ cmd: 'respond', choice: 'accept', targetId: el.dataset.target }); break;
      case 'discSel':
        if (ui.discardSel.has(id)) ui.discardSel.delete(id);
        else if (ui.discardSel.size < S.turn.discardNeeded) ui.discardSel.add(id);
        renderModal();
        break;
      case 'discard': cmd({ cmd: 'discard', cardIds: [...ui.discardSel] }); break;
      case 'hideForced': ui.hideForced = true; render(); break;
      case 'showForced': ui.hideForced = false; render(); break;
    }
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && ui.modal) { ui.modal = null; renderModal(); }
    if (ev.key === 'Enter' && ev.target.id === 'code') document.querySelector('[data-a="join"]')?.click();
  });

  $('#chat-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const input = $('#chat-input');
    const text = input.value.trim();
    if (text) raw({ type: 'chat', text });
    input.value = '';
  });

  // ---------- toasts ----------
  function toast(text, kind = '') {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = text;
    $('#toasts').appendChild(el);
    setTimeout(() => el.classList.add('out'), 2800);
    setTimeout(() => el.remove(), 3300);
  }

  render();
  connect();
})();

// HTTP static server + WebSocket game rooms.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { Game, GameError } = require('./game');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') { res.end('ok'); return; }
  let file = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) {
      // Unknown paths fall back to the app so share links work.
      fs.readFile(path.join(PUBLIC, 'index.html'), (e2, html) => {
        res.writeHead(e2 ? 404 : 200, { 'Content-Type': 'text/html' });
        res.end(e2 ? 'Not found' : html);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

const rooms = new Map(); // code -> { game, sockets: Map<playerId, Set<ws>>, emptySince }

function newCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do {
    code = Array.from({ length: 4 }, () => letters[crypto.randomInt(letters.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(room) {
  for (const [pid, set] of room.sockets) {
    const view = room.game.viewFor(pid);
    for (const ws of set) send(ws, { type: 'state', state: view });
  }
}

function attach(room, player, ws) {
  ws.roomCode = room.game.code;
  ws.playerId = player.id;
  if (!room.sockets.has(player.id)) room.sockets.set(player.id, new Set());
  room.sockets.get(player.id).add(ws);
  player.connected = true;
  room.emptySince = null;
  send(ws, { type: 'joined', code: room.game.code, playerId: player.id, token: player.token });
}

function detach(ws) {
  const room = rooms.get(ws.roomCode);
  if (!room) return;
  const set = room.sockets.get(ws.playerId);
  if (set) {
    set.delete(ws);
    if (!set.size) {
      room.sockets.delete(ws.playerId);
      const p = room.game.player(ws.playerId);
      if (p) {
        p.connected = false;
        // Players who leave a lobby are removed; in-game players can reconnect.
        if (room.game.phase === 'lobby') room.game.removePlayer(p.id);
        room.game.seq++;
      }
    }
  }
  if (!room.sockets.size) room.emptySince = Date.now();
  broadcast(room);
}

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    try {
      handleMessage(ws, msg);
    } catch (e) {
      if (e instanceof GameError) send(ws, { type: 'error', message: e.message });
      else { console.error(e); send(ws, { type: 'error', message: 'Server error' }); }
    }
  });

  ws.on('close', () => detach(ws));
});

function handleMessage(ws, msg) {
  if (msg.type === 'create') {
    if (ws.roomCode) detach(ws);
    const code = newCode();
    const room = { game: new Game(code), sockets: new Map(), emptySince: null };
    rooms.set(code, room);
    const player = room.game.addPlayer(msg.name, crypto.randomUUID());
    attach(room, player, ws);
    broadcast(room);
    return;
  }

  if (msg.type === 'join') {
    const code = String(msg.code || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) throw new GameError('No game with that code');
    if (ws.roomCode && ws.roomCode !== code) detach(ws);
    // Reconnect with a saved token if we have one.
    let player = msg.token && room.game.players.find((p) => p.token === msg.token);
    if (!player) player = room.game.addPlayer(msg.name, crypto.randomUUID());
    attach(room, player, ws);
    broadcast(room);
    return;
  }

  if (msg.type === 'leave') {
    const room = rooms.get(ws.roomCode);
    if (room) {
      room.game.removePlayer(ws.playerId);
      const set = room.sockets.get(ws.playerId);
      if (set) set.delete(ws);
      if (set && !set.size) room.sockets.delete(ws.playerId);
      if (!room.sockets.size) room.emptySince = Date.now();
      broadcast(room);
    }
    ws.roomCode = null; ws.playerId = null;
    send(ws, { type: 'left' });
    return;
  }

  const room = rooms.get(ws.roomCode);
  if (!room) throw new GameError('Not in a game');

  if (msg.type === 'kick') {
    if (room.game.hostId !== ws.playerId) throw new GameError('Only the host can remove players');
    const target = room.game.player(msg.playerId);
    if (!target || target.id === ws.playerId) throw new GameError('Invalid player');
    room.game.removePlayer(target.id);
    for (const s of room.sockets.get(target.id) || []) send(s, { type: 'kicked' });
    room.sockets.delete(target.id);
    broadcast(room);
    return;
  }

  if (msg.type === 'chat') {
    const p = room.game.player(ws.playerId);
    const text = String(msg.text || '').trim().slice(0, 200);
    if (!p || !text) return;
    for (const set of room.sockets.values()) for (const s of set) send(s, { type: 'chat', from: p.name, text });
    return;
  }

  if (msg.type === 'cmd') {
    room.game.handle(ws.playerId, msg);
    broadcast(room);
  }
}

// Keep connections alive and clean up abandoned rooms.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.emptySince && now - room.emptySince > 2 * 60 * 60 * 1000) rooms.delete(code);
  }
}, 30000);

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

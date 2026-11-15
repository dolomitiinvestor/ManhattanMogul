// Fallback transport for when a direct WebRTC link can't be made (phones on
// cellular data, strict Wi-Fi, firewalls, or the PeerJS server being down).
// Messages go through free public MQTT brokers over secure WebSockets, which
// works on any network that can load a web page.
//
// The host listens on every broker at once; a guest uses whichever broker
// answers first. Each link looks like a PeerJS DataConnection to app.js:
// .open, .send(obj), .close(), .on('open' | 'data' | 'close' | 'error', fn).
(() => {
  const BROKERS = [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt',
    'wss://test.mosquitto.org:8081/mqtt',
  ];
  const ROOT = 'manhattan-mogul/v1/';
  const PING_MS = 4000;      // keepalive interval
  const DEAD_MS = 15000;     // silence after which a link counts as closed
  const JOIN_MS = 9000;      // how long a guest waits for the host to answer

  const rid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now()).replace(/-/g, '').slice(0, 16);
  const hostTopic = (code) => `${ROOT}${code}/h`;
  const guestTopic = (code, id) => `${ROOT}${code}/g/${id}`;
  const roomTopic = (code) => `${ROOT}${code}/all`; // host announcements to every guest

  function client(url) {
    return mqtt.connect(url, {
      clientId: 'mm_' + rid(),
      clean: true,
      keepalive: 30,
      reconnectPeriod: 2000,
      connectTimeout: 8000,
      protocolVersion: 4,
    });
  }

  const encode = (o) => JSON.stringify(o);
  function decode(buf) {
    try { return JSON.parse(typeof buf === 'string' ? buf : new TextDecoder().decode(buf)); } catch { return null; }
  }

  // One end of a relay link.
  class Link {
    constructor(mq, outTopic, selfId) {
      this.mq = mq; this.outTopic = outTopic; this.selfId = selfId;
      this.open = false; this.closed = false; this.relay = true;
      this.handlers = {}; this.lastSeen = Date.now();
      this.timer = setInterval(() => {
        if (!this.open) return;
        if (Date.now() - this.lastSeen > DEAD_MS) return this._end();
        this._out('ping');
      }, PING_MS);
    }
    on(ev, fn) { (this.handlers[ev] ||= []).push(fn); return this; }
    _emit(ev, arg) { for (const fn of this.handlers[ev] || []) { try { fn(arg); } catch (e) { console.error(e); } } }
    _out(k, d, via = this.mq) {
      if (this.closed || !via.connected) return;
      via.publish(this.outTopic, encode({ f: this.selfId, k, d }), { qos: 1 });
    }
    _in(m) {
      this.lastSeen = Date.now();
      if (m.k === 'd' && this.open) this._emit('data', m.d);
      else if (m.k === 'bye') this._end();
    }
    _markOpen() { if (!this.open && !this.closed) { this.open = true; this.lastSeen = Date.now(); this._emit('open'); } }
    send(obj) { if (this.open) this._out('d', obj); }
    close() { if (!this.closed) { this._out('bye'); this._end(); } }
    _end() {
      if (this.closed) return;
      this.closed = true; this.open = false;
      clearInterval(this.timer);
      if (this.onEnd) this.onEnd();
      this._emit('close');
    }
  }

  // Host: accept guests on every broker. onConnection(link) fires once per guest.
  function listen(code, onConnection) {
    const links = new Map(); // guestId -> Link
    const session = rid();   // changes when the host reloads
    const clients = BROKERS.map((url) => {
      const mq = client(url);
      // Announce this host session so guests still linked to a previous one
      // (the host reloaded) reconnect right away instead of waiting for a timeout.
      mq.on('connect', () => mq.subscribe(hostTopic(code), { qos: 1 }, () => {
        mq.publish(roomTopic(code), encode({ f: 'host', k: 'up', s: session }), { qos: 1 });
      }));
      mq.on('error', () => {});
      mq.on('message', (_t, buf) => {
        const m = decode(buf);
        if (!m || typeof m.f !== 'string' || !/^[\w]{1,40}$/.test(m.f)) return;
        let link = links.get(m.f);
        if (m.k === 'hello') {
          // A guest says hello on every broker at once and keeps whichever answers
          // first, so answer on the broker the hello came from, but don't move the
          // link: it follows the broker that carries the guest's real traffic.
          if (!link) {
            link = new Link(mq, guestTopic(code, m.f), 'host');
            link.peer = 'relay:' + m.f;
            link.onEnd = () => { if (links.get(m.f) === link) links.delete(m.f); };
            links.set(m.f, link);
            onConnection(link);
            link._markOpen();
          }
          link.lastSeen = Date.now();
          link._out('welcome', session, mq);
          return;
        }
        if (link) { link.mq = mq; link._in(m); }
      });
      return mq;
    });
    return {
      connected: () => clients.some((c) => c.connected),
      close() {
        for (const l of [...links.values()]) l.close();
        setTimeout(() => clients.forEach((c) => c.end(true)), 300);
      },
    };
  }

  // Guest: try every broker in parallel, use the first one where the host answers.
  // Resolves with an open Link, or rejects with {type:'peer-unavailable'} if no host answers.
  function connect(code) {
    return new Promise((resolve, reject) => {
      const myId = rid();
      const mine = guestTopic(code, myId);
      let winner = null, hostSession = null;
      const tries = BROKERS.map((url) => {
        const mq = client(url);
        const link = new Link(mq, hostTopic(code), myId);
        let hello = null;
        mq.on('error', () => {});
        mq.on('connect', () => {
          mq.subscribe([mine, roomTopic(code)], { qos: 1 }, () => {
            const say = () => { if (!winner && !link.closed) mq.publish(hostTopic(code), encode({ f: myId, k: 'hello' }), { qos: 1 }); };
            say();
            clearInterval(hello);
            hello = setInterval(say, 2000);
          });
        });
        mq.on('message', (_t, buf) => {
          const m = decode(buf);
          if (!m || m.f !== 'host') return;
          if (m.k === 'welcome' && !winner) {
            winner = link;
            hostSession = m.d;
            clearInterval(hello);
            clearTimeout(giveUp);
            for (const t of tries) if (t.link !== link) { t.link._end(); t.mq.end(true); }
            link.onEnd = () => setTimeout(() => mq.end(true), 300);
            resolve(link);
            link._markOpen();
            return;
          }
          if (link !== winner) return;
          if (m.k === 'up') { if (m.s !== hostSession) link._end(); return; }
          link._in(m);
        });
        return { mq, link, stop: () => clearInterval(hello) };
      });
      const giveUp = setTimeout(() => {
        if (winner) return;
        const reached = tries.some((t) => t.mq.connected);
        for (const t of tries) { t.stop(); t.link._end(); t.mq.end(true); }
        reject({ type: reached ? 'peer-unavailable' : 'network' });
      }, JOIN_MS);
    });
  }

  window.MMRelay = { listen, connect, available: typeof mqtt !== 'undefined' };
})();

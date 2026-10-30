// Mini bridge online server: rooms, seats, AI fill-in, per-player hidden information.
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const R = require('./game');

const PORT = process.env.PORT || 3000;
const DELAY = { announce: 700, decide: 700, redeal: 2200, contract: 2600, ai: 750, collect: 1300 };
const SEAT_ORDER = [2, 0, 1, 3]; // new players fill 남, 북, 동, 서 in that order
const ROOM_IDLE_MS = 30 * 60 * 1000;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.send('ok'));
const server = http.createServer(app);
const io = new Server(server);

/** code -> room */
const rooms = new Map();

function makeCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from({ length: 4 }, () => A[Math.floor(Math.random() * A.length)]).join(''); } while (rooms.has(code));
  return code;
}

function cleanName(n) {
  return String(n || '').replace(/[<>]/g, '').trim().slice(0, 12) || '손님';
}

function newRoom() {
  const room = {
    code: makeCode(),
    seats: [null, null, null, null], // pid or null (= AI)
    members: new Map(),             // pid -> { name, socketId, connected }
    hostPid: null,
    G: null,
    total: [0, 0],
    timer: null,
    lastActive: Date.now(),
  };
  rooms.set(room.code, room);
  return room;
}

const phase = room => (room.G ? room.G.phase : 'lobby');
const memberAt = (room, p) => (room.seats[p] ? room.members.get(room.seats[p]) : null);
const humanConnected = (room, p) => { const m = memberAt(room, p); return !!(m && m.connected); };

// Who chooses cards for seat p right now: a person, or the AI.
// Dummy's cards are always played by the AI (dummy stays hidden from everyone).
function humanControls(room, p) {
  const G = room.G;
  if (G && G.dummy === p && ['contract', 'play', 'done'].includes(G.phase)) return false;
  return humanConnected(room, p);
}

/* ---------- views (each player only sees their own hand) ---------- */
function view(room, pid) {
  const my = room.seats.indexOf(pid);
  const G = room.G;
  const seats = room.seats.map(sp => {
    if (!sp) return { human: false, name: 'AI', connected: true };
    const m = room.members.get(sp);
    return { human: true, name: m.name, connected: m.connected, me: sp === pid };
  });
  const out = { code: room.code, my, isHost: room.hostPid === pid, seats, phase: phase(room), total: room.total };
  if (!G) return out;
  const ord = p => (p - G.dealer + 4) % 4;
  out.game = {
    handNo: G.handNo, dealer: G.dealer, announced: G.announced,
    hcp: G.hcp.map((h, p) => (ord(p) < G.announced || !['announce'].includes(G.phase) ? h : null)),
    declarer: G.declarer, dummy: G.dummy, trump: G.trump, goal: G.goal,
    rec: G.phase === 'choose' && my === G.declarer ? G.rec : null,
    turn: G.turn, trick: G.trick, tricks: G.tricks, pendingWinner: G.pendingWinner,
    lastTrick: G.lastTrick, result: G.result,
    counts: G.hands.map(h => h.length),
    hand: my >= 0 ? G.hands[my] : [],
    target: G.goal ? R.target(G) : null,
    legal: my >= 0 && G.phase === 'play' && G.pendingWinner === null && G.turn === my && humanControls(room, my)
      ? R.legalCards(G, my) : [],
    aiTurn: G.phase === 'play' && G.turn !== null ? !humanControls(room, G.turn) : false,
  };
  return out;
}

function broadcast(room) {
  for (const [pid, m] of room.members) {
    if (m.connected && m.socketId) io.to(m.socketId).emit('state', view(room, pid));
  }
}

/* ---------- the room's clock: AI moves and automatic transitions ---------- */
function later(room, ms, fn) {
  clearTimeout(room.timer);
  room.timer = setTimeout(() => { room.timer = null; fn(); update(room); }, ms);
}

function schedule(room) {
  const G = room.G;
  if (!G) return;
  switch (G.phase) {
    case 'announce':
      if (G.announced < 4) later(room, DELAY.announce, () => { G.announced++; });
      else later(room, DELAY.decide, () => { R.decide(G); });
      break;
    case 'redeal':
      later(room, DELAY.redeal, () => { R.deal(G); });
      break;
    case 'choose':
      if (!humanConnected(room, G.declarer)) later(room, DELAY.ai, () => { R.setContract(G, G.rec.trump, G.rec.goal); });
      else clearTimeout(room.timer);
      break;
    case 'contract':
      later(room, DELAY.contract, () => { R.startPlay(G); });
      break;
    case 'play':
      if (G.pendingWinner !== null) later(room, DELAY.collect, () => { R.collect(G); });
      else if (!humanControls(room, G.turn)) later(room, DELAY.ai, () => { R.playCard(G, G.turn, R.aiChoose(G, G.turn)); });
      else clearTimeout(room.timer);
      break;
    default:
      clearTimeout(room.timer);
  }
}

function update(room) {
  room.lastActive = Date.now();
  schedule(room);
  broadcast(room);
}

function startHand(room) {
  if (!room.G) room.G = { handNo: 0, total: room.total };
  R.newHand(room.G);
}

/* ---------- membership ---------- */
function seatMember(room, pid) {
  if (room.seats.includes(pid)) return true;
  // mid-game a newcomer may take over any seat the AI is playing
  const free = SEAT_ORDER.find(p => !room.seats[p]);
  if (free === undefined) return false;
  room.seats[free] = pid;
  return true;
}

function removeMember(room, pid) {
  const i = room.seats.indexOf(pid);
  if (i >= 0) room.seats[i] = null;
  room.members.delete(pid);
  if (room.hostPid === pid) {
    const next = [...room.members.entries()].find(([, m]) => m.connected);
    room.hostPid = next ? next[0] : null;
  }
  if (!room.members.size) { clearTimeout(room.timer); rooms.delete(room.code); return; }
  update(room);
}

io.on('connection', socket => {
  let current = null; // { room, pid }

  function attach(room, pid, name, ack) {
    const existing = room.members.get(pid);
    if (!existing && !seatMember(room, pid)) return ack({ error: '방이 가득 찼어요 (사람 4명).' });
    room.members.set(pid, { name: cleanName(name), socketId: socket.id, connected: true });
    if (!room.hostPid || !room.members.get(room.hostPid)?.connected) room.hostPid = pid;
    current = { room, pid };
    socket.join(room.code);
    ack({ ok: true, code: room.code });
    update(room);
  }

  socket.on('create', ({ name, pid } = {}, ack = () => {}) => {
    if (typeof pid !== 'string' || pid.length < 8) return ack({ error: '잘못된 요청이에요.' });
    if (current) removeMember(current.room, current.pid);
    const room = newRoom();
    room.hostPid = pid;
    attach(room, pid, name, ack);
  });

  socket.on('join', ({ code, name, pid } = {}, ack = () => {}) => {
    if (typeof pid !== 'string' || pid.length < 8) return ack({ error: '잘못된 요청이에요.' });
    const room = rooms.get(String(code || '').toUpperCase().trim());
    if (!room) return ack({ error: '그런 방이 없어요. 코드를 확인해 주세요.' });
    if (current && current.room !== room) removeMember(current.room, current.pid);
    attach(room, pid, name, ack);
  });

  socket.on('sit', ({ seat } = {}) => {
    if (!current) return;
    const { room, pid } = current;
    if (phase(room) !== 'lobby' || ![0, 1, 2, 3].includes(seat) || room.seats[seat]) return;
    const i = room.seats.indexOf(pid);
    if (i >= 0) room.seats[i] = null;
    room.seats[seat] = pid;
    update(room);
  });

  socket.on('start', () => {
    if (!current) return;
    const { room, pid } = current;
    if (phase(room) !== 'lobby' || room.hostPid !== pid) return;
    startHand(room);
    update(room);
  });

  socket.on('contract', ({ trump, goal } = {}) => {
    if (!current) return;
    const { room, pid } = current;
    const G = room.G;
    if (!G || G.phase !== 'choose' || room.seats[G.declarer] !== pid) return;
    if (![0, 1, 2, 3, 4].includes(trump) || !['part', 'game'].includes(goal)) return;
    R.setContract(G, trump, goal);
    update(room);
  });

  socket.on('play', ({ card } = {}) => {
    if (!current) return;
    const { room, pid } = current;
    const G = room.G;
    if (!G) return;
    const p = room.seats.indexOf(pid);
    if (p < 0 || !humanControls(room, p)) return;
    if (R.playCard(G, p, card)) update(room);
  });

  socket.on('next', () => {
    if (!current) return;
    const { room, pid } = current;
    if (!room.G || room.G.phase !== 'done' || !room.seats.includes(pid)) return;
    startHand(room);
    update(room);
  });

  socket.on('lobby', () => {
    if (!current) return;
    const { room, pid } = current;
    if (!room.G || room.G.phase !== 'done' || room.hostPid !== pid) return;
    room.G = null; room.total = [0, 0];
    update(room);
  });

  socket.on('leave', () => {
    if (!current) return;
    const { room, pid } = current;
    current = null;
    socket.leave(room.code);
    removeMember(room, pid);
  });

  socket.on('disconnect', () => {
    if (!current) return;
    const { room, pid } = current;
    const m = room.members.get(pid);
    if (!m || m.socketId !== socket.id) return; // a newer tab took over
    if (phase(room) === 'lobby') { removeMember(room, pid); return; }
    m.connected = false; // seat is kept; the AI plays it until they come back
    if (room.hostPid === pid) {
      const next = [...room.members.entries()].find(([, x]) => x.connected);
      if (next) room.hostPid = next[0];
    }
    update(room);
  });
});

setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    const anyone = [...room.members.values()].some(m => m.connected);
    if (!anyone && now - room.lastActive > ROOM_IDLE_MS) { clearTimeout(room.timer); rooms.delete(room.code); }
  }
}, 60 * 1000).unref();

if (require.main === module) {
  server.listen(PORT, () => console.log(`미니 브릿지 서버: http://localhost:${PORT}`));
}

module.exports = { server, rooms, DELAY };

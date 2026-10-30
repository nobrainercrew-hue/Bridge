// Two people join one room and play two full hands against the AI.
// The second person drops out mid-hand; the AI must take over their seat.
const { io } = require('socket.io-client');
const { server, DELAY } = require('../server');

for (const k of Object.keys(DELAY)) DELAY[k] = 5;

function client(port, pid, name) {
  const s = io(`http://localhost:${port}`, { transports: ['websocket'], forceNew: true });
  s.pid = pid; s.name = name; s.last = null;
  s.on('state', st => {
    s.last = st;
    const g = st.game;
    if (!g) return;
    if (g.hand.length !== g.counts[st.my]) throw new Error('hand/count mismatch');
    if (JSON.stringify(st).includes('"hands"')) throw new Error('other hands leaked');
    if (st.phase === 'choose' && g.rec) s.emit('contract', g.rec);
    if (g.legal.length) s.emit('play', { card: g.legal[0] });
  });
  return s;
}
const ask = (s, ev, data) => new Promise(r => s.emit(ev, data, r));
const until = (pred, ms = 20000) => new Promise((res, rej) => {
  const t0 = Date.now();
  const iv = setInterval(() => { if (pred()) { clearInterval(iv); res(); } else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error('timeout')); } }, 10);
});

server.listen(0, async () => {
  const port = server.address().port;
  try {
    const a = client(port, 'pid-aaaaaaaa', '장호');
    const b = client(port, 'pid-bbbbbbbb', '친구');
    await until(() => a.connected && b.connected);
    const made = await ask(a, 'create', { name: a.name, pid: a.pid });
    if (!made.ok) throw new Error('create failed');
    const joined = await ask(b, 'join', { code: made.code.toLowerCase(), name: b.name, pid: b.pid });
    if (!joined.ok) throw new Error('join failed: ' + joined.error);
    await until(() => a.last && a.last.seats.filter(x => x.human).length === 2);
    console.log('seats:', a.last.seats.map(s => s.name).join(', '), '| a sits', a.last.my, '| b sits', b.last.my);

    a.emit('start');
    await until(() => a.last.phase === 'play' && a.last.game.tricks[0] + a.last.game.tricks[1] >= 4);
    b.disconnect(); // friend drops; AI should cover
    await until(() => a.last.phase === 'done');
    const r1 = a.last.game.result;
    console.log('hand 1:', r1.made ? 'made' : 'down', `${r1.won}/${r1.need}`, 'total', a.last.total, '| friend seat shows offline:', !a.last.seats[1 - 1 + (a.last.my === 2 ? 0 : 2)].connected);

    // friend comes back with the same id and gets the same seat
    const b2 = client(port, 'pid-bbbbbbbb', '친구');
    await until(() => b2.connected);
    const back = await ask(b2, 'join', { code: made.code, name: '친구', pid: 'pid-bbbbbbbb' });
    if (!back.ok) throw new Error('rejoin failed');
    await until(() => b2.last);
    console.log('rejoined seat:', b2.last.my);

    b2.emit('next');
    await until(() => a.last.game.handNo === 2 && a.last.phase === 'done');
    console.log('hand 2 done, total', a.last.total);
    console.log('PASS');
    process.exit(0);
  } catch (e) {
    console.error('FAIL', e);
    process.exit(1);
  }
});

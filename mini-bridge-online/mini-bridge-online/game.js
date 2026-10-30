// Mini bridge rules + AI. Pure game state, no networking.
// Seats: 0=북(N) 1=동(E) 2=남(S) 3=서(W), clockwise. Teams: N/S = 0, E/W = 1.
// Cards: 0..51, suit = floor(c/13) (0♠ 1♥ 2♦ 3♣), rank = c%13 (0 = "2" … 12 = "A").
// Trump: 0..3 for a suit, 4 for no-trump.

const suitOf = c => Math.floor(c / 13);
const rankOf = c => c % 13;
const team = p => p % 2;
const cardHcp = c => (rankOf(c) >= 9 ? rankOf(c) - 8 : 0);

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function deal(G) {
  const deck = shuffle([...Array(52).keys()]);
  G.hands = [0, 1, 2, 3].map(p => deck.slice(p * 13, p * 13 + 13));
  G.hcp = G.hands.map(h => h.reduce((s, c) => s + cardHcp(c), 0));
  Object.assign(G, {
    phase: 'announce', announced: 0, declarer: null, dummy: null, trump: null, goal: null, rec: null,
    turn: null, trick: [], tricks: [0, 0], played: new Set(), pendingWinner: null, lastTrick: null, result: null,
  });
}

function newHand(G) {
  G.handNo = (G.handNo || 0) + 1;
  G.dealer = (G.handNo - 1) % 4;
  deal(G);
}

// After all four have announced. Returns 'redeal' on a 20:20 tie.
function decide(G) {
  const ns = G.hcp[0] + G.hcp[2], ew = G.hcp[1] + G.hcp[3];
  if (ns === ew) { G.phase = 'redeal'; return 'redeal'; }
  const [a, b] = ns > ew ? [0, 2] : [1, 3];
  const ord = p => (p - G.dealer + 4) % 4;
  G.declarer = G.hcp[a] !== G.hcp[b] ? (G.hcp[a] > G.hcp[b] ? a : b) : (ord(a) < ord(b) ? a : b);
  G.dummy = (G.declarer + 2) % 4;
  G.rec = aiContract(G, G.declarer);
  G.phase = 'choose';
  return 'choose';
}

// Declarer knows only their own cards and partner's announced points.
function aiContract(G, d) {
  const du = (d + 2) % 4;
  const len = [0, 1, 2, 3].map(s => G.hands[d].filter(c => suitOf(c) === s).length);
  const hcp = G.hcp[d] + G.hcp[du];
  const fit = list => list.filter(s => len[s] >= 5).sort((x, y) => len[y] - len[x])[0];
  let trump = 4;
  const maj = fit([0, 1]), min = fit([2, 3]);
  if (maj !== undefined) trump = maj;
  else if (min !== undefined && (hcp >= 28 || hcp < 25)) trump = min;
  const gameAt = trump === 2 || trump === 3 ? 28 : 25;
  return { trump, goal: hcp >= gameAt ? 'game' : 'part' };
}

function setContract(G, trump, goal) {
  G.trump = trump; G.goal = goal; G.phase = 'contract';
}

function startPlay(G) {
  G.phase = 'play';
  G.turn = (G.declarer + 1) % 4;
}

function target(G) {
  return G.goal === 'part' ? 7 : (G.trump === 4 ? 9 : G.trump < 2 ? 10 : 11);
}

function legalCards(G, p) {
  const h = G.hands[p];
  if (!G.trick.length) return h.slice();
  const led = suitOf(G.trick[0].c), f = h.filter(c => suitOf(c) === led);
  return f.length ? f : h.slice();
}

function beats(G, a, b) {
  const sa = suitOf(a), sb = suitOf(b);
  if (sa === sb) return rankOf(a) > rankOf(b);
  return G.trump !== 4 && sa === G.trump;
}

function currentWinner(G) {
  let w = G.trick[0];
  for (const x of G.trick) if (beats(G, x.c, w.c)) w = x;
  return w;
}

// Returns true when the play was accepted.
function playCard(G, p, c) {
  if (G.phase !== 'play' || G.pendingWinner !== null || G.turn !== p) return false;
  if (!legalCards(G, p).includes(c)) return false;
  G.hands[p] = G.hands[p].filter(x => x !== c);
  G.played.add(c);
  G.trick.push({ p, c });
  if (G.trick.length === 4) G.pendingWinner = currentWinner(G).p;
  else G.turn = (p + 1) % 4;
  return true;
}

// Takes the finished trick. Returns true when the hand is over.
function collect(G) {
  const w = G.pendingWinner;
  G.tricks[team(w)]++;
  G.lastTrick = { cards: G.trick.slice(), winner: w };
  G.trick = []; G.pendingWinner = null; G.turn = w;
  if (G.tricks[0] + G.tricks[1] === 13) { finish(G); return true; }
  return false;
}

function trickPts(G, n) {
  if (n <= 0) return 0;
  if (G.trump === 4) return 40 + 30 * (n - 1);
  return n * (G.trump < 2 ? 30 : 20);
}

function finish(G) {
  const dt = team(G.declarer), won = G.tricks[dt], need = target(G);
  const r = { made: won >= need, won, need, dt, goal: G.goal };
  if (r.made) {
    r.trickPts = trickPts(G, won - 6);
    r.bonus = G.goal === 'game' ? 300 : 50;
    r.points = r.trickPts + r.bonus;
    G.total[dt] += r.points;
  } else {
    r.down = need - won;
    r.points = 50 * r.down;
    G.total[1 - dt] += r.points;
  }
  G.result = r; G.phase = 'done';
}

// Card choice using only own hand + cards already played.
function aiChoose(G, p) {
  const hand = G.hands[p], legal = legalCards(G, p);
  if (legal.length === 1) return legal[0];
  const t = G.trump, partner = (p + 2) % 4;
  const ours = new Set(hand);
  const isBoss = c => {
    const s = suitOf(c);
    for (let k = rankOf(c) + 1; k < 13; k++) { const x = s * 13 + k; if (!G.played.has(x) && !ours.has(x)) return false; }
    return true;
  };
  const bySuit = s => hand.filter(c => suitOf(c) === s).sort((a, b) => rankOf(a) - rankOf(b));
  const lowest = a => a.reduce((x, y) => (rankOf(y) < rankOf(x) ? y : x));
  const highest = a => a.reduce((x, y) => (rankOf(y) > rankOf(x) ? y : x));
  const declSide = p === G.declarer || p === G.dummy;

  if (!G.trick.length) {
    if (t < 4 && declSide) {
      const myT = bySuit(t);
      let out = 0;
      for (let k = 0; k < 13; k++) { const x = t * 13 + k; if (!G.played.has(x) && !ours.has(x)) out++; }
      if (out > 0 && myT.length) {
        const b = myT.filter(isBoss);
        if (b.length) return highest(b);
        if (myT.length >= 4) return lowest(myT);
      }
    }
    const bossSide = hand.filter(c => suitOf(c) !== t && isBoss(c));
    if (bossSide.length) return bossSide.sort((a, b) => bySuit(suitOf(b)).length - bySuit(suitOf(a)).length)[0];
    let best = -1, len = 0;
    for (const s of [0, 1, 2, 3]) { if (s === t) continue; const n = bySuit(s).length; if (n > len) { len = n; best = s; } }
    if (!len) return lowest(hand);
    const a = bySuit(best), top = a[a.length - 1], second = a[a.length - 2];
    if (a.length >= 2 && rankOf(top) >= 9 && rankOf(top) - rankOf(second) === 1) return top;
    return a[0];
  }

  const led = suitOf(G.trick[0].c), pos = G.trick.length, win = currentWinner(G), partnerWin = win.p === partner;
  if (legal.every(c => suitOf(c) === led)) {
    if (partnerWin) {
      if (pos === 3 || isBoss(win.c)) return lowest(legal);
      const b = legal.filter(c => rankOf(c) > rankOf(win.c) && isBoss(c));
      return b.length ? lowest(b) : lowest(legal);
    }
    if (t < 4 && suitOf(win.c) === t && led !== t) return lowest(legal);
    const beaters = legal.filter(c => rankOf(c) > rankOf(win.c));
    if (!beaters.length) return lowest(legal);
    if (pos === 3) return lowest(beaters);
    const bb = beaters.filter(isBoss);
    if (bb.length) return lowest(bb);
    return pos === 2 ? highest(beaters) : lowest(legal);
  }
  const discard = () => {
    const nonT = hand.filter(c => suitOf(c) !== t), pool = nonT.length ? nonT : hand, nb = pool.filter(c => !isBoss(c));
    return lowest(nb.length ? nb : pool);
  };
  if (partnerWin) return discard();
  if (t < 4) {
    const myT = bySuit(t);
    if (myT.length) {
      if (suitOf(win.c) === t) { const over = myT.filter(c => rankOf(c) > rankOf(win.c)); if (over.length) return lowest(over); }
      else return lowest(myT);
    }
  }
  return discard();
}

module.exports = {
  suitOf, rankOf, team, newHand, deal, decide, aiContract, setContract, startPlay,
  target, legalCards, playCard, collect, aiChoose,
};

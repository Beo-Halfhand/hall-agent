// Collusion signals from public data only: the table's log (what anyone watching sees). For every pair of seats it counts the
// chances each had to challenge the other (call Liar on their bid; call their claim) and how often it did, and compares that
// with how often each challenges everyone else. Two seats that keep passing up the chance against each other, while calling
// the rest of the table at their usual rate, are what soft play looks like. The score is the chance of that by luck:
// P(at most k calls in n chances) at the pair's own call rate on others. Low is suspicious.
//
// What it can't see from public data: Sealed Hand passes (which card went where is never public, not even after the round;
// the server keeps it), so "passes that keep help one seat" needs the server-side log. See the spec.

// A table of four has six pairs, so the bar is 0.01 shared across them (about 0.002), and a pair needs a dozen chances before
// it can be flagged at all. The first local runs flagged an honest pair at p = 0.008 over 14 chances with a bar of 0.02: short
// sessions are noisy, and a flag is an accusation.
const MIN_CHANCES = 12;
const FLAG_P = 0.002;

/** P(X <= k) for X ~ Binomial(n, p). */
export function binomCdf(k, n, p) {
  if (p <= 0) return 1;
  let sum = 0;
  let term = (1 - p) ** n; // P(X = 0)
  for (let i = 0; i <= k; i++) {
    sum += term;
    term = term * ((n - i) / (i + 1)) * (p / (1 - p));
  }
  return Math.min(1, sum);
}

/** Seat by name, for log lines that say names. Longest names first, so "Old Wick" isn't read as "Old". */
function namer(names) {
  const list = names.map((name, seat) => ({ name, seat })).filter((x) => x.name).sort((a, b) => b.name.length - a.name.length);
  return (text) => list.find((x) => text.startsWith(x.name)) ?? null;
}

/** Chances and calls, seat → seat, from a Cup & Claim log. */
function diceEvents(log, names) {
  const who = namer(names);
  const chances = {};
  const calls = {};
  const add = (m, a, b) => { (m[a] ??= {})[b] = (m[a][b] ?? 0) + 1; };
  let round = null;
  let standing = null;
  for (const e of log) {
    if (e.round !== round) { round = e.round; standing = null; }
    if (e.bid) {
      if (standing !== null && standing !== e.bid.seat) add(chances, e.bid.seat, standing);
      standing = e.bid.seat;
      continue;
    }
    if (e.say || standing === null) continue;
    if (/ folds\. The cup stays/.test(e.text)) {
      const x = who(e.text);
      if (x && x.seat !== standing) add(chances, x.seat, standing);
    } else if (e.text.includes(' calls LIAR on ')) {
      const x = who(e.text);
      if (x && x.seat !== standing) { add(chances, x.seat, standing); add(calls, x.seat, standing); }
      standing = null;
    }
  }
  return { chances, calls };
}

/** Chances and calls from a Sealed Hand log: its moves are tagged (act). */
function cardEvents(log) {
  const chances = {};
  const calls = {};
  const add = (m, a, b) => { (m[a] ??= {})[b] = (m[a][b] ?? 0) + 1; };
  let round = null;
  let open = new Set(); // seats with a claim nobody has called yet
  for (const e of log) {
    if (e.round !== round) { round = e.round; open = new Set(); }
    const a = e.act;
    if (!a || a.seat === null || a.seat === undefined) continue;
    const x = a.seat;
    if (['claim', 'check', 'call', 'fold'].includes(a.kind) || (a.kind === 'match' && !a.passNo) || (a.kind === 'raise' && !a.passNo)) {
      for (const y of open) if (y !== x) add(chances, x, y);
    }
    if (a.kind === 'call' && Number.isInteger(a.target)) { add(calls, x, a.target); open.delete(a.target); }
    if (a.kind === 'claim' || a.kind === 'stop') open.add(x);
    if (a.kind === 'fold') open.delete(x);
  }
  return { chances, calls };
}

/**
 * Pairs at one table. `names` are the seat names (index = seat), `kinds` their kinds. Returns every pair with enough chances,
 * flagged ones first.
 */
export function detectPairs({ game, log, names, kinds = [] }) {
  const { chances, calls } = game === 'sealed-hand' ? cardEvents(log) : diceEvents(log, names);
  const get = (m, a, b) => m[a]?.[b] ?? 0;
  const seats = names.map((_, i) => i);
  const rateOnOthers = (a, b) => {
    let n = 0;
    let k = 0;
    for (const c of seats) if (c !== a && c !== b) { n += get(chances, a, c); k += get(calls, a, c); }
    return { n, k, rate: n ? k / n : null };
  };
  const pairs = [];
  for (const a of seats) {
    for (const b of seats) {
      if (b <= a) continue;
      const n = get(chances, a, b) + get(chances, b, a);
      const k = get(calls, a, b) + get(calls, b, a);
      const ra = rateOnOthers(a, b);
      const rb = rateOnOthers(b, a);
      const others = ra.n + rb.n ? (ra.k + rb.k) / (ra.n + rb.n) : null;
      const p = others === null || n === 0 ? null : binomCdf(k, n, others);
      const flagged = n >= MIN_CHANCES && others !== null && (ra.n + rb.n) >= MIN_CHANCES && p !== null && p < FLAG_P;
      pairs.push({ seats: [a, b], names: [names[a], names[b]], kinds: [kinds[a] ?? null, kinds[b] ?? null], chances: n, calls: k, callRateOnEachOther: n ? +(k / n).toFixed(2) : null, callRateOnOthers: others === null ? null : +others.toFixed(2), p: p === null ? null : +p.toPrecision(2), flagged, why: flagged ? `${k} calls in ${n} chances against each other, against ${(others * 100).toFixed(0)}% on everyone else (chance by luck ${(p * 100).toFixed(2)}%)` : null });
    }
  }
  return pairs.sort((x, y) => Number(y.flagged) - Number(x.flagged) || (x.p ?? 1) - (y.p ?? 1));
}

/** Net chips per seat over the run, and between two seats how often one's gain was the other's loss in the same round. */
export function chipFlow(rounds) {
  const out = {};
  for (let i = 1; i < rounds.length; i++) {
    const before = rounds[i - 1].chips;
    const after = rounds[i].chips;
    for (let s = 0; s < after.length; s++) out[s] = (out[s] ?? 0) + ((after[s] ?? 0) - (before[s] ?? 0));
  }
  return out;
}

// Cup & Claim players. Each `decide(me, view, ctx)` returns one move built from me.legal (or null to wait).
// me: GET /me (dice, counts with wilds, legal). view: GET <table> (public state: totalDice, bid, seats).
// ctx: { rng, team } where team (colluders only) holds the partner's counts.

const pick = (rng, list) => list[Math.floor(rng() * list.length)];

/** Every bid that beats the standing one, smallest first, up to `limit` counts above the lowest. */
export function validBids(bidLegal, limit = 3) {
  const { lowest, maxCount, faces } = bidLegal;
  const out = [];
  for (let count = lowest.count; count <= Math.min(maxCount, lowest.count + limit); count++) {
    for (const face of faces) if (count > lowest.count || face >= lowest.face) out.push({ count, face });
  }
  return out;
}

/** How many of `face` the table likely holds: what I know for sure, plus a third of the dice I can't see (1s are wild). */
export function expectedCount(face, me, view, known = null) {
  const mine = me.counts?.[face] ?? me.counts?.[String(face)] ?? 0;
  const extra = known ? (known.counts[face] ?? known.counts[String(face)] ?? 0) : 0;
  const seen = me.dice.length + (known ? known.dice : 0);
  return mine + extra + Math.max(0, view.totalDice - seen) / 3;
}

/** The bid with the most room under its expected count, at the smallest legal count for its face. */
function bestBid(bidLegal, me, view, known) {
  let best = null;
  for (const face of bidLegal.faces) {
    const count = face >= bidLegal.lowest.face ? bidLegal.lowest.count : bidLegal.lowest.count + 1;
    if (count > bidLegal.maxCount) continue;
    const margin = expectedCount(face, me, view, known) - count;
    if (!best || margin > best.margin) best = { count, face, margin };
  }
  return best;
}

const legalOf = (me) => Object.fromEntries(me.legal.map((m) => [m.action, m]));

/** Always: next after a round, prove in a duel, back after being away. */
function routine(legal, rng, showRate = 0) {
  if (legal.back) return { action: 'back' };
  if (legal.next) return { action: 'next' };
  if (legal.reveal) return { action: 'reveal', mode: rng() < showRate ? 'show' : 'prove' };
  return null;
}

export const diceRandom = {
  type: 'random',
  decide(me, view, { rng }) {
    const legal = legalOf(me);
    const r = routine(legal, rng, 0.3);
    if (r) return r;
    const roll = rng();
    if (legal.liar && roll < 0.2) return { action: 'liar' };
    if (legal.fold && roll > 0.93) return { action: 'fold' };
    if (legal.bid) return { action: 'bid', ...pick(rng, validBids(legal.bid, 2).slice(0, 8)) };
    return legal.liar ? { action: 'liar' } : { action: 'fold' };
  },
};

export const diceGreedy = {
  type: 'greedy',
  decide(me, view, { rng, known = null }) {
    const legal = legalOf(me);
    const r = routine(legal, rng);
    if (r) return r;
    const standing = legal.liar?.bid ?? view.bid;
    if (legal.liar && standing && standing.count > expectedCount(standing.face, me, view, known) + 0.6) return { action: 'liar' };
    if (legal.bid) {
      const best = bestBid(legal.bid, me, view, known);
      if (best && (best.margin >= -0.4 || !legal.liar)) {
        const raise = legal.bid.raise && best.margin >= 1.5 ? { raise: legal.bid.raise.min } : {};
        return { action: 'bid', count: best.count, face: best.face, ...raise };
      }
    }
    return legal.liar ? { action: 'liar' } : { action: 'fold' };
  },
};

export const diceBluff = {
  type: 'bluff',
  decide(me, view, { rng }) {
    const legal = legalOf(me);
    const r = routine(legal, rng);
    if (r) return r;
    if (legal.bid) {
      const bid = pick(rng, validBids(legal.bid, 1));
      const raise = legal.bid.raise ? { raise: Math.max(legal.bid.raise.min, Math.floor(legal.bid.raise.max / 2)) } : {};
      return { action: 'bid', ...bid, ...raise };
    }
    return legal.liar ? { action: 'liar' } : { action: 'fold' };
  },
};

/**
 * A colluder: it reads its partner's dice through `team` (a side channel the Hall can't see), never calls Liar on its partner,
 * and bids and calls on everyone else knowing ten dice instead of five. This is what the Hall's rules forbid.
 */
export const diceColluder = {
  type: 'colluder',
  decide(me, view, { rng, team, seat }) {
    const legal = legalOf(me);
    const r = routine(legal, rng);
    if (r) return r;
    team.share(seat, { counts: me.counts, dice: me.dice.length, round: view.round });
    const partner = team.partnerOf(seat);
    const known = team.read(partner, view.round);
    const standing = legal.liar?.bid ?? view.bid;
    const partnerBid = standing && view.bid?.seat === partner;
    if (!partnerBid && legal.liar && standing && standing.count > expectedCount(standing.face, me, view, known) + 0.3) return { action: 'liar' };
    if (legal.bid) {
      const best = bestBid(legal.bid, me, view, known);
      if (best && (best.margin >= -0.6 || partnerBid || !legal.liar)) return { action: 'bid', count: best.count, face: best.face };
    }
    if (partnerBid) return legal.fold ? { action: 'fold' } : { action: 'bid', ...validBids(legal.bid, 0)[0] }; // never call the partner
    return legal.liar ? { action: 'liar' } : { action: 'fold' };
  },
};

/** Deliberately illegal moves, to check the Hall refuses them. Each returns a move or null when it doesn't apply now. */
export const diceProbes = [
  ['bid-not-higher', (me) => { const b = me.legal.find((m) => m.action === 'bid'); return b && b.above ? { action: 'bid', count: b.above.count, face: b.above.face } : null; }],
  ['bid-face-one', (me) => { const b = me.legal.find((m) => m.action === 'bid'); return b ? { action: 'bid', count: b.lowest.count + 1, face: 1 } : null; }],
  ['bid-count-zero', (me) => (me.legal.some((m) => m.action === 'bid') ? { action: 'bid', count: 0, face: 6 } : null)],
  ['raise-over-limit', (me) => { const b = me.legal.find((m) => m.action === 'bid'); return b?.raise ? { action: 'bid', ...b.lowest, raise: b.raise.max + 1 } : null; }],
  ['reveal-while-bidding', (me) => (me.legal.some((m) => m.action === 'bid') ? { action: 'reveal', mode: 'show' } : null)],
  ['next-mid-round', (me) => (me.legal.some((m) => m.action === 'bid') ? { action: 'next' } : null)],
  ['unknown-action', () => ({ action: 'peek', seat: 0 })],
];
/** Sent when legal is empty in a round: someone else's turn. */
export const diceOutOfTurn = () => ({ action: 'liar' });

// Sealed Hand players. Each `decide(me, view, ctx)` returns one move built from me.legal.
// me: GET /me (hand, legal, bestTrue, facing). view: GET <table> (public: phase, claims, top, seats).
// The rule the Hall enforces: facing a raise, a move carries match: true unless it raises higher, or it folds.

const pick = (rng, list) => list[Math.floor(rng() * list.length)];
const RANKS = '23456789TJQKA';
const rankOf = (card) => RANKS.indexOf(card[0]) + 2;
const legalOf = (me) => Object.fromEntries(me.legal.map((m) => [m.action, m]));
/** Adds match: true where the legal entry says one is owed. */
const withMatch = (move, entry) => (entry?.match ? { ...move, match: true } : move);

/** The card that helps least: a rank I hold only once, the lowest of those; never break a pair. */
export function weakestCard(hand) {
  const n = (r) => hand.filter((c) => rankOf(c) === r).length;
  const singles = hand.filter((c) => n(rankOf(c)) === 1).sort((a, b) => rankOf(a) - rankOf(b));
  return singles[0] ?? [...hand].sort((a, b) => rankOf(a) - rankOf(b))[0];
}

function routine(legal) {
  if (legal.back) return { action: 'back' };
  if (legal.next) return { action: 'next' };
  return null;
}

/** Cheap to stay in? `cost` against the stack. */
const affordable = (entry, me, view, share = 0.25) => !entry?.match || entry.match.cost <= Math.max(5, (view.seats[me.seat]?.chips ?? 0) * share);

export const cardsRandom = {
  type: 'random',
  decide(me, view, { rng }) {
    const legal = legalOf(me);
    const r = routine(legal);
    if (r) return r;
    if (legal.match && !legal.pass && !legal.claim) return rng() < 0.7 ? { action: 'match' } : { action: 'fold' };
    if (legal.stop && rng() < 0.15) return { action: 'stop', claim: pick(rng, legal.stop.options.slice(0, 6)).claim };
    if (legal.pass) return withMatch({ action: 'pass', card: pick(rng, legal.pass.cards) }, legal.pass);
    const choices = ['claim', 'call', 'check'].filter((a) => legal[a]);
    if (!choices.length) return legal.fold ? { action: 'fold' } : null;
    const a = pick(rng, choices);
    if (a === 'claim') return withMatch({ action: 'claim', claim: pick(rng, legal.claim.options.slice(0, 4)).claim }, legal.claim);
    if (a === 'call') return withMatch({ action: 'call', seat: pick(rng, legal.call.seats) }, legal.call);
    return withMatch({ action: 'check' }, legal.check);
  },
};

export const cardsGreedy = {
  type: 'greedy',
  decide(me, view, { rng, team = null, seat = null }) {
    const legal = legalOf(me);
    const r = routine(legal);
    if (r) return r;
    const partner = team ? team.partnerOf(seat) : null;
    if (legal.match && !legal.pass && !legal.claim) { // the answer after the lap
      if (legal.call && rng() < 0.3) {
        const target = legal.call.seats.find((s) => s !== partner);
        if (target !== undefined && legal.call.match && affordable(legal.call, me, view)) return { action: 'call', seat: target, match: true };
      }
      return affordable(legal.match, me, view) ? { action: 'match' } : { action: 'fold' };
    }
    if (legal.stop && legal.stop.truthful.some((t) => t.claim[0] >= 2)) return { action: 'stop', claim: legal.stop.truthful.at(-1).claim };
    if (legal.pass) {
      if (!affordable(legal.pass, me, view)) return legal.fold ? { action: 'fold' } : withMatch({ action: 'pass', card: weakestCard(me.hand) }, legal.pass);
      return withMatch({ action: 'pass', card: team ? team.passFor(seat, me.hand) ?? weakestCard(me.hand) : weakestCard(me.hand) }, legal.pass);
    }
    if (legal.claim && legal.claim.truthful.length && affordable(legal.claim, me, view)) return withMatch({ action: 'claim', claim: legal.claim.truthful[0].claim }, legal.claim);
    const top = view.top; // the claim to beat, as [cat, r1, r2]; who made it is in view.claims
    const topSeat = top ? view.claims.find((c) => JSON.stringify(c.claim) === JSON.stringify(top))?.seat : undefined;
    if (legal.call && top && top[0] >= 3 && topSeat !== undefined && topSeat !== partner && legal.call.seats.includes(topSeat) && affordable(legal.call, me, view)) return withMatch({ action: 'call', seat: topSeat }, legal.call);
    if (legal.check && affordable(legal.check, me, view)) return withMatch({ action: 'check' }, legal.check);
    if (legal.fold) return { action: 'fold' };
    if (legal.check) return withMatch({ action: 'check' }, legal.check);
    return null; // only "stop" is open (my pass is in) and I don't want to stop: wait for the others
  },
};

export const cardsBluff = {
  type: 'bluff',
  decide(me, view, { rng }) {
    const legal = legalOf(me);
    const r = routine(legal);
    if (r) return r;
    if (legal.match && !legal.pass && !legal.claim) return { action: 'match' };
    if (legal.stop && rng() < 0.35) {
      const raise = legal.stop.raise ? { raise: legal.stop.raise.min } : {};
      return { action: 'stop', claim: pick(rng, legal.stop.options.slice(2, 9)).claim, ...raise };
    }
    if (legal.pass) return withMatch({ action: 'pass', card: pick(rng, legal.pass.cards) }, legal.pass);
    if (legal.claim) {
      const raise = legal.claim.raise ? { raise: Math.max(legal.claim.raise.min, Math.floor(legal.claim.raise.max / 3)) } : {};
      const move = { action: 'claim', claim: pick(rng, legal.claim.options.slice(0, 3)).claim, ...raise };
      return raise.raise ? move : withMatch(move, legal.claim);
    }
    if (legal.check) return withMatch({ action: 'check' }, legal.check);
    return legal.fold ? { action: 'fold' } : null;
  },
};

/** A colluder at Sealed Hand: the greedy player, but it never calls its partner and passes its partner the card it can use. */
export const cardsColluder = {
  type: 'colluder',
  decide(me, view, ctx) {
    ctx.team.share(ctx.seat, { hand: me.hand, round: view.round });
    return cardsGreedy.decide(me, view, ctx);
  },
};

export const cardsProbes = [
  ['pass-card-not-held', (me) => { const p = me.legal.find((m) => m.action === 'pass'); if (!p) return null; const card = ['2c', '3d', 'Ah', 'Ks', '9h', 'Td'].find((c) => !me.hand.includes(c)); return { action: 'pass', card }; }],
  ['claim-while-passing', (me) => (me.legal.some((m) => m.action === 'pass') ? { action: 'claim', claim: [1, 14] } : null)],
  ['raise-over-limit', (me) => { const p = me.legal.find((m) => m.action === 'pass' && m.raise); return p ? { action: 'pass', card: me.hand[0], raise: p.raise.max + 1 } : null; }],
  ['claim-not-higher', (me, view) => (me.legal.some((m) => m.action === 'claim') && view.top ? { action: 'claim', claim: [1, 2] } : null)],
  ['call-self', (me) => (me.legal.some((m) => m.action === 'call' || m.action === 'check') ? { action: 'call', seat: me.seat } : null)],
  ['call-empty-seat', (me) => (me.legal.some((m) => m.action === 'check') ? { action: 'call', seat: 9 } : null)],
  ['unknown-action', () => ({ action: 'peek', seat: 0 })],
];
export const cardsOutOfTurn = (me) => ({ action: 'check' });
export { rankOf };

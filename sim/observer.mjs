// A spectator at each table: polls the public state (no token, as anyone can), keeps every log line and every round's
// result, and checks each snapshot for anything private: a card or a die before the round is over, a seat token, a seed.

import { sleep } from '../lib/hall.mjs';

const CARD = /"[2-9TJQKA][cdhs]"/;
const IN_ROUND = { 'cup-and-claim': ['bid', 'duel'], 'sealed-hand': ['pass', 'claim', 'answer'] };

export function observe({ hall, game, api, tokens, leaks, everyMs = 400 }) {
  const seen = new Map(); // log n -> entry
  const rounds = new Map(); // round -> { result, chips, names, lastDuel }
  const bids = []; // Cup & Claim: { round, seat, n } from the tagged log lines
  let last = null;
  let snapshots = 0;
  let stop = false;

  const check = (view) => {
    const text = JSON.stringify(view);
    for (const t of tokens()) if (t && text.includes(t)) leaks.push({ where: 'public state', what: 'a seat token' });
    if (IN_ROUND[game].includes(view.phase)) {
      if (game === 'sealed-hand') {
        if (CARD.test(text)) leaks.push({ where: 'public state', what: `a card code during ${view.phase}`, round: view.round });
        if (view.deal?.opened) leaks.push({ where: 'public state', what: 'the deck opened before the round settled', round: view.round });
      } else {
        if (view.seats.some((s) => 'dice' in s)) leaks.push({ where: 'public state', what: 'dice on a seat during play', round: view.round });
        if (view.fair?.opened && !view.proof) leaks.push({ where: 'public state', what: 'house seed opened during play', round: view.round });
        if (view.lastDuel?.round === view.round) leaks.push({ where: 'public state', what: 'this round\'s duel shown before it settled', round: view.round });
      }
    }
  };

  const loop = (async () => {
    while (!stop) {
      try {
        const view = await hall.state(api);
        snapshots += 1;
        check(view);
        for (const entry of view.log ?? []) {
          if (seen.has(entry.n)) continue;
          seen.set(entry.n, entry);
          if (entry.bid) bids.push({ round: entry.round ?? view.round, seat: entry.bid.seat, n: entry.n });
        }
        if (view.lastResult && !rounds.has(view.lastResult.round)) {
          rounds.set(view.lastResult.round, { result: view.lastResult, chips: view.seats.map((s) => s.chips), names: view.seats.map((s) => s.name), lastDuel: view.lastDuel?.round === view.lastResult.round ? view.lastDuel : null });
        }
        last = view;
      } catch { /* a missed poll */ }
      await sleep(everyMs);
    }
  })();

  return {
    async stop() { stop = true; await loop; },
    get data() { return { log: [...seen.values()].sort((a, b) => a.n - b.n), rounds: [...rounds.entries()].map(([round, r]) => ({ round, ...r })), bids, last, snapshots }; },
  };
}

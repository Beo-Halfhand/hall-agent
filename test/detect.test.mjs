import test from 'node:test';
import assert from 'node:assert/strict';
import { binomCdf, detectPairs } from '../sim/detect.mjs';
import { validBids, expectedCount } from '../players/dice.mjs';
import { weakestCard } from '../players/cards.mjs';

test('binomial tail', () => {
  assert.equal(binomCdf(0, 10, 0.5), 0.5 ** 10);
  assert.ok(Math.abs(binomCdf(10, 10, 0.3) - 1) < 1e-9);
  assert.equal(binomCdf(0, 5, 0), 1);
});

/** A Cup & Claim log: seats 0 and 1 never call each other; both call seat 2 and 3 often. */
function softPlayLog(rounds = 12) {
  const names = ['A', 'B', 'C', 'D'];
  const log = [];
  let n = 0;
  for (let r = 1; r <= rounds; r++) {
    log.push({ n: ++n, round: r, text: `Round ${r}.` });
    log.push({ n: ++n, round: r, text: 'A bids', bid: { seat: 0, count: 2, face: 3 } });
    log.push({ n: ++n, round: r, text: 'B bids', bid: { seat: 1, count: 3, face: 3 } }); // B passes up a call on A
    log.push({ n: ++n, round: r, text: 'C bids', bid: { seat: 2, count: 4, face: 3 } });
    if (r % 2) log.push({ n: ++n, round: r, text: "D calls LIAR on C's bid, 4 threes! Every cup answers." });
    else {
      log.push({ n: ++n, round: r, text: 'D bids', bid: { seat: 3, count: 5, face: 3 } });
      log.push({ n: ++n, round: r, text: "A calls LIAR on D's bid, 5 threes! Every cup answers." });
    }
    log.push({ n: ++n, round: r + 0.5, text: 'next' });
  }
  return { names, log };
}

test('a pair that never calls each other, but calls the rest, is flagged; honest pairs are not', () => {
  const { names, log } = softPlayLog(12);
  // B also calls C and D sometimes, so B has a rate on others.
  let n = 1000;
  for (let r = 20; r < 32; r++) {
    log.push({ n: ++n, round: r, text: 'C bids', bid: { seat: 2, count: 2, face: 4 } });
    log.push({ n: ++n, round: r, text: "B calls LIAR on C's bid, 2 fours!" });
    log.push({ n: ++n, round: r + 100, text: 'A bids', bid: { seat: 0, count: 2, face: 5 } });
    log.push({ n: ++n, round: r + 100, text: 'B bids', bid: { seat: 1, count: 3, face: 5 } });
  }
  const pairs = detectPairs({ game: 'cup-and-claim', log, names });
  const ab = pairs.find((p) => p.seats.join() === '0,1');
  assert.ok(ab.flagged, JSON.stringify(ab));
  assert.equal(ab.calls, 0);
  assert.ok(pairs.filter((p) => p.flagged).every((p) => p.seats.join() === '0,1'), 'only the pair');
});

test('Sealed Hand: chances come from the tagged moves', () => {
  const log = [];
  let n = 0;
  for (let r = 1; r <= 10; r++) {
    log.push({ n: ++n, round: r, act: { seat: 0, kind: 'claim' } });
    log.push({ n: ++n, round: r, act: { seat: 1, kind: 'check' } }); // 1 lets 0 stand
    log.push({ n: ++n, round: r, act: { seat: 2, kind: 'call', target: 0 } });
    log.push({ n: ++n, round: r, act: { seat: 1, kind: 'claim' } });
    log.push({ n: ++n, round: r, act: { seat: 0, kind: 'check' } }); // 0 lets 1 stand
    log.push({ n: ++n, round: r, act: { seat: 2, kind: 'call', target: 1 } });
    log.push({ n: ++n, round: r, act: { seat: 0, kind: 'call', target: 2 } });
    log.push({ n: ++n, round: r, act: { seat: 2, kind: 'claim' } });
    log.push({ n: ++n, round: r, act: { seat: 1, kind: 'call', target: 2 } });
  }
  const pairs = detectPairs({ game: 'sealed-hand', log, names: ['A', 'B', 'C'] });
  const ab = pairs.find((p) => p.seats.join() === '0,1');
  assert.equal(ab.calls, 0);
  assert.ok(ab.chances >= 10);
});

test('dice helpers: every bid that beats the standing one, and the expected count', () => {
  const bids = validBids({ lowest: { count: 3, face: 5 }, maxCount: 20, faces: [2, 3, 4, 5, 6] }, 1);
  assert.deepEqual(bids.slice(0, 2), [{ count: 3, face: 5 }, { count: 3, face: 6 }]);
  assert.ok(bids.every((b) => b.count > 3 || b.face >= 5));
  assert.equal(expectedCount(4, { dice: [1, 4, 2, 2, 6], counts: { 4: 2 } }, { totalDice: 20 }), 2 + 5);
  assert.equal(weakestCard(['Ah', 'Ad', '7c', '2s', 'Kd']), '2s');
});

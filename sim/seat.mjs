// One agent at one table: join, play `rounds` rounds through GET /me and POST /act, leave. Records every move, every refusal,
// every deliberate illegal probe and what the Hall answered, and the seat's stack after each round. Also checks its own /me:
// it must only ever describe this seat.

import { HallError, sleep } from '../lib/hall.mjs';
import { OUT_OF_TURN, PROBES } from '../players/index.mjs';

const IN_ROUND = { 'cup-and-claim': ['bid', 'duel'], 'sealed-hand': ['pass', 'claim', 'answer'] };
const PRIVATE_KEYS = { 'cup-and-claim': ['dice', 'counts', 'commit'], 'sealed-hand': ['hand', 'passLog', 'bestTrue'] };

export async function runSeat({ hall, game, api, name, player, rounds, rng, team = null, probe = 0, log, stats, leaks, pollMs = 700, joined = null, deadline = Infinity }) {
  const sit = joined ?? (await hall.join(api, { name, kind: 'agent' }));
  const { seat, token } = sit;
  stats.seat = seat;
  stats.tokens.push(token);
  team?.add(seat);
  log(`${name} sat at seat ${seat}`);
  const ctx = { rng, team, seat, stats };
  let played = 0;
  let lastRound = 0;
  let probesThisRound = 0;
  let outOfTurnTried = 0;
  let view = await hall.state(api);
  stats.chips.push({ round: 0, chips: view.buyIn ?? view.seats[seat]?.chips ?? null }); // what the seat sat down with

  const countRounds = (v) => {
    // Any seat's "next" deals at once, so a round is counted when its result shows, not when this seat sees "next".
    const r = v.lastResult?.round;
    if (Number.isInteger(r) && r > lastCounted && r >= firstRound) {
      lastCounted = r;
      played += 1;
      stats.rounds = played;
      stats.chips.push({ round: r, chips: v.seats[seat]?.chips ?? null, phase: v.phase });
      log(`${name} round ${r} done: stack ${v.seats[seat]?.chips}${v.lastResult?.kind ? ` (${v.lastResult.kind})` : ''}`);
    }
  };
  let lastCounted = 0;
  let idleSince = null;
  const firstRound = Math.max(1, view.round || 1);

  while (played < rounds && Date.now() < deadline) {
    let me;
    try {
      [me, view] = await Promise.all([hall.me(api, token), hall.state(api)]);
    } catch (err) {
      if (err instanceof HallError && err.status === 429) continue;
      throw err;
    }
    countRounds(view);
    if (played >= rounds) break;
    // A table that is over, or that waits on nobody (this seat broke and nobody else presses next), ends the run for this seat.
    if (view.phase === 'over') { stats.stopped = `table over: ${view.overReason ?? ''}`.trim(); log(`${name} stops: ${stats.stopped}`); break; }
    // A table still in its lobby is waiting to start (at a tNIGHT table the judge seats one player at a time): that isn't idle.
    if (!me.legal.length && !IN_ROUND[game].includes(view.phase) && view.phase !== 'lobby') {
      idleSince ??= Date.now();
      if (Date.now() - idleSince > 45_000) { stats.stopped = `no move for 45 s between rounds (stack ${view.seats[seat]?.chips})`; log(`${name} stops: ${stats.stopped}`); break; }
    } else idleSince = null;
    checkMe(me, seat, game, leaks, name);
    if (view.round !== lastRound) { lastRound = view.round; probesThisRound = 0; }
    if (!me.legal.length) {
      // Someone else's move. Now and then, try acting anyway: the Hall must refuse it.
      // Only when the turn is at least two seats away, and still not mine on a fresh read: otherwise the turn can reach me between
      // the read and the send, and a "refused" probe would be a race, not a rule.
      const n = view.seats.length;
      const far = Number.isInteger(view.turn) && view.turn !== seat && (view.turn + 1) % n !== seat;
      if (probe && outOfTurnTried < 3 && IN_ROUND[game].includes(view.phase) && far && rng() < probe / 4) {
        const fresh = await hall.me(api, token);
        if (!fresh.legal.length) {
          outOfTurnTried += 1;
          await sendProbe(hall, api, token, 'out-of-turn', OUT_OF_TURN[game](fresh, view), stats, log, name);
        }
      }
      await sleep(pollMs + Math.floor(rng() * 200));
      continue;
    }
    if (me.legal.some((m) => m.action === 'next')) {
      await sleep(1500); // let watchers see the result before the next deal, then look again: someone else may have dealt it
      [me, view] = await Promise.all([hall.me(api, token), hall.state(api)]);
      if (!me.legal.length) continue;
    }

    // A deliberate illegal move first, sometimes. The Hall must refuse it and nothing may change.
    if (probe && probesThisRound < 2 && rng() < probe) {
      const options = PROBES[game].map(([pname, make]) => [pname, make(me, view)]).filter(([, m]) => m);
      if (options.length) {
        const [pname, move] = options[Math.floor(rng() * options.length)];
        probesThisRound += 1;
        await sendProbe(hall, api, token, pname, move, stats, log, name, true);
      }
    }

    const decided = await player.decide(me, view, ctx);
    const plan = decided && decided.move !== undefined ? decided : { move: decided, source: 'scripted' };
    if (!plan.move) { await sleep(pollMs); continue; }
    try {
      await hall.act(api, token, plan.move);
      stats.moves += 1;
      if (plan.source === 'model') stats.modelMovesPlayed = (stats.modelMovesPlayed ?? 0) + 1;
    } catch (err) {
      if (!(err instanceof HallError) || err.status >= 500) throw err;
      const who = plan.source === 'model' ? 'model' : 'scripted';
      stats.refused.push({ by: who, move: plan.move, code: err.code, status: err.status });
      log(`${name} ${who} move refused: ${JSON.stringify(plan.move)} → ${err.status} ${err.code}`);
      if (plan.fallback) {
        try {
          await hall.act(api, token, plan.fallback);
          stats.moves += 1;
          stats.fallbackMoves = (stats.fallbackMoves ?? 0) + 1;
        } catch (e2) {
          if (!(e2 instanceof HallError)) throw e2;
          stats.refused.push({ by: 'fallback', move: plan.fallback, code: e2.code, status: e2.status });
        }
      }
    }
  }
  try {
    const left = await hall.leave(api, token);
    stats.left = left.queued ? 'after the round' : `with ${left.amount}`;
    log(`${name} left ${stats.left}`);
  } catch (err) {
    stats.left = `leave refused: ${err.code}`;
  }
  return stats;
}

/**
 * A probe: the Hall must answer 4xx. Anything else is an illegal move accepted, and that is a bug. A refusal must change nothing:
 * the seat's view is read just before and just after, with the table's last log line, and a change with no new log line (nobody
 * else moved) is recorded as `changed`. A change with new log lines is someone else's move, recorded as `raced`.
 */
async function sendProbe(hall, api, token, pname, move, stats, log, name, check = false) {
  const snap = async () => {
    const [m, v] = await Promise.all([hall.me(api, token), hall.state(api)]);
    return { key: JSON.stringify([m.hand ?? m.dice, m.legal?.map((l) => l.action), m.passLog?.length ?? null]), logN: v.log?.at(-1)?.n ?? 0 };
  };
  const before = check ? await snap().catch(() => null) : null;
  try {
    await hall.act(api, token, move);
    stats.probes.push({ probe: pname, move, accepted: true });
    log(`!! ${name} probe ${pname} ACCEPTED: ${JSON.stringify(move)}`);
  } catch (err) {
    if (!(err instanceof HallError)) throw err;
    const entry = { probe: pname, move, accepted: false, status: err.status, code: err.code };
    if (before) {
      const after = await snap().catch(() => null);
      if (after && after.key !== before.key) {
        if (after.logN === before.logN) { entry.changed = true; log(`!! ${name} probe ${pname} refused but the seat changed with no other move`); } else entry.raced = true;
      }
    }
    stats.probes.push(entry);
  }
}

/** /me must describe this seat and only this seat. */
function checkMe(me, seat, game, leaks, name) {
  if (me.seat !== seat) leaks.push({ where: '/me', who: name, what: `seat ${me.seat} instead of ${seat}` });
  const text = JSON.stringify(me);
  if (/"hands"|"seeds"|"tokens"|"players"/.test(text)) leaks.push({ where: '/me', who: name, what: 'a whole-table field in a seat view' });
  for (const k of PRIVATE_KEYS[game]) if (k in me && Array.isArray(me[k]) && game === 'sealed-hand' && k === 'hand' && me.hand.length > 5) leaks.push({ where: '/me', who: name, what: 'more than five cards' });
}

export const freshStats = (name, type, game) => ({ name, type, game, seat: null, tokens: [], chips: [], moves: 0, refused: [], probes: [], rounds: 0 });

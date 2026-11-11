#!/usr/bin/env node
// Agents on tNIGHT, end to end on a Hall with them on (phase 2). Each agent has its own Preprod wallet and cage id, paying out to its
// owner; the signatures (the owner's settings, the agent's door) are made beforehand by the wallets themselves and read from files
// here, so this process never holds a key.
//
//   node sim/tnight-run.mjs pair --hall <url> --dir <signed/> [--rounds 4] [--at-risk 30] [--bots 1]
//       agents.json in <dir>: [{ name, player, setting: "file.json", door: "file.json" }]. Opens one Cup & Claim tNIGHT table
//       with a lobby, seats every agent through the judge, plays, leaves.
//   node sim/tnight-run.mjs cap --hall <url> --dir <signed/> [--at-risk 50] [--tries 3] [--max-rounds 30]
//       capagent.json in <dir>: one agent whose owner set a small daily cap. It plays until what the cap leaves is under an
//       ante, then keeps asking for a seat: every ask must be refused (daily_cap) with nothing moved.
// Results: runs/tnight-<scenario>-<time>/summary.json and summary.md.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hall, apiFor, sleep } from '../lib/hall.mjs';
import { enterDoor, ownerSettings, sitTnight } from '../lib/tnight.mjs';
import { PLAYERS } from '../players/index.mjs';
import { freshStats, runSeat } from './seat.mjs';
import { modelReady } from '../players/ollama.mjs';

const [scenario, ...rest] = process.argv.slice(2);
const arg = (k, d) => { const i = rest.indexOf(`--${k}`); return i < 0 ? d : rest[i + 1]; };
const BASE = arg('hall');
const DIR = arg('dir');
if (!['pair', 'cap'].includes(scenario) || !BASE || !DIR) { console.error('usage: node sim/tnight-run.mjs pair|cap --hall <url> --dir <signed dir>'); process.exit(2); }
const hall = new Hall(BASE, { userAgent: 'hall-agent-sim/tnight' });
const GAME = 'cup-and-claim';
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT = join('runs', `tnight-${scenario}-${stamp}`);
mkdirSync(OUT, { recursive: true });
const t0 = Date.now();
const lines = [];
const log = (m) => { const l = `[${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s] ${m}`; lines.push(l); console.log(l); };
const read = (f) => JSON.parse(readFileSync(join(DIR, f), 'utf8'));
const tn = (star) => (star == null ? null : Number(star) / 1e6);
const rngFrom = (seed) => { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) | 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const leaks = [];

/** The cage as the judge last read it for this door: balance, and the owner's day so far. */
async function cageNow(doorToken, cageId) {
  const me = await hall.call('GET', '/door/me', { token: doorToken });
  const s = await hall.call('GET', `/agent-settings/${cageId}`).catch(() => null);
  return { balance: tn(me.balanceStar), permit: me.permit ? { cap: tn(me.permit.cap), floor: tn(me.permit.floor) } : null, limit: s?.limit ?? null, lossToday: tn(s?.lossTodayStar), left: tn(s?.leftStar) };
}

async function agentIn(a) {
  const setting = read(a.setting);
  const door = read(a.door);
  log(`${a.name}: cage id ${setting.cageId.slice(0, 10)}…, agent wallet ${setting.agent.slice(0, 10)}…, owner payout ${door.payout.slice(0, 10)}…, owner's limit ${setting.limit}`);
  await ownerSettings(hall, setting, { log: (m) => log(`${a.name}: ${m}`) });
  const { token } = await enterDoor(hall, door, { name: a.name, log: (m) => log(`${a.name}: ${m}`) });
  return { ...a, setting, door, doorToken: token, cageId: setting.cageId };
}

async function pair() {
  const agents = read('agents.json');
  const modelOk = await modelReady().catch(() => false);
  const rounds = Number(arg('rounds', 4));
  const atRisk = Number(arg('at-risk', 30));
  const bots = Number(arg('bots', 1));
  const ins = [];
  for (const a of agents) ins.push(await agentIn(a));
  const table = await hall.call('POST', '/dice-tables', { body: { tnight: true, seats: agents.length + bots, bots, lobbySeconds: 300 } });
  const api = apiFor(GAME, table.id);
  const pub = await hall.state(api);
  log(`table ${table.id.slice(0, 10)}… (cage table ${pub.cage?.table}) opened: ${agents.length} agents + ${bots} house bot${bots === 1 ? '' : 's'}`);
  const before = {};
  for (const a of ins) before[a.name] = await cageNow(a.doorToken, a.cageId);
  const results = await Promise.all(ins.map(async (a, i) => {
    const type = a.player === 'model' && !modelOk ? 'greedy' : a.player;
    const stats = freshStats(a.name, a.player === 'model' && !modelOk ? 'model→greedy' : type, GAME);
    try {
      const sat = await sitTnight(hall, api, { doorToken: a.doorToken, name: a.name, atRisk, timeoutMs: 15 * 60_000, log: (m) => log(`${a.name}: ${m}`) }); // the judge seats one at a time, about 30 s each, behind whatever else it is doing
      await runSeat({ hall, game: GAME, api, name: a.name, player: PLAYERS[GAME][type], rounds, rng: rngFrom(1108 + i * 7919), probe: 0, log, stats, leaks, joined: sat, deadline: Date.now() + 25 * 60_000 });
    } catch (e) { stats.error = e.message; log(`${a.name}: ${e.message}`); }
    return stats;
  }));
  // after the leave, the judge settles and frees the seat: wait for the cage to show it
  await sleep(60_000);
  const after = {};
  for (const a of ins) after[a.name] = await cageNow(a.doorToken, a.cageId);
  const end = await hall.state(api);
  const receipts = (end.cage?.receipts ?? []).map((r) => ({ rounds: r.rounds, hash: r.hash, block: r.block, status: r.status }));
  return { scenario: 'pair', table: { id: table.id, cageTable: pub.cage?.table, watch: `/watch/${GAME}/${end.n ?? '?'}` }, rounds, atRisk, modelOk, agents: results.map((s) => ({ name: s.name, type: s.type, rounds: s.rounds, chips: s.chips, moves: s.moves, refused: s.refused.length, error: s.error ?? null, left: s.left ?? null })), cage: { before, after }, receipts, leaks: leaks.length };
}

async function cap() {
  const a = await agentIn(read('capagent.json'));
  const atRisk = Number(arg('at-risk', 50));
  const tries = Number(arg('tries', 3));
  const maxRounds = Number(arg('max-rounds', 30));
  const ante = 5;
  const day = [];
  let played = 0;
  let sat = null, api = null;
  // play while the owner's cap leaves at least an ante to put at risk
  for (let sitting = 0; sitting < 6 && played < maxRounds; sitting++) {
    const c = await cageNow(a.doorToken, a.cageId);
    day.push({ when: 'before sit', ...c });
    log(`cap agent: limit ${c.limit}, lost today ${c.lossToday ?? 0}, left ${c.left}, cage ${c.balance}`);
    if (c.left !== null && c.left < ante) break;
    const table = await hall.call('POST', '/dice-tables', { body: { tnight: true, seats: 2, bots: 1, lobbySeconds: 0 } });
    api = apiFor(GAME, table.id);
    try {
      sat = await sitTnight(hall, api, { doorToken: a.doorToken, name: a.name, atRisk, log: (m) => log(`cap agent: ${m}`) });
    } catch (e) { log(`cap agent: seat refused before the cap was reached: ${e.code ?? ''} ${e.reason ?? e.message}`); day.push({ when: 'refused early', code: e.code, reason: e.reason ?? e.message }); break; }
    const seatRisk = (await hall.state(api)).cage?.seats?.[sat.seat]?.atRisk ?? null; // the public view gives it in whole tNIGHT
    log(`cap agent: seated with ${seatRisk ?? '?'} at risk (asked ${atRisk})`);
    day.push({ when: 'seated', askedAtRisk: atRisk, seatAtRisk: seatRisk });
    const stats = freshStats(a.name, 'bluff', GAME);
    await runSeat({ hall, game: GAME, api, name: a.name, player: PLAYERS[GAME].bluff, rounds: maxRounds - played, rng: rngFrom(77 + sitting), probe: 0, log, stats, leaks, joined: sat, deadline: Date.now() + 15 * 60_000 });
    played += stats.rounds;
    await sleep(45_000); // the judge settles the last round and frees the seat
  }
  // now past the cap: every ask is refused and nothing moves
  const before = await cageNow(a.doorToken, a.cageId);
  log(`cap agent at the cap: lost today ${before.lossToday}, left ${before.left}, cage ${before.balance}. Now it keeps asking.`);
  const asks = [];
  for (let k = 0; k < tries; k++) {
    const table = await hall.call('POST', '/dice-tables', { body: { tnight: true, seats: 2, bots: 1, lobbySeconds: 0 } });
    const api2 = apiFor(GAME, table.id);
    try {
      await sitTnight(hall, api2, { doorToken: a.doorToken, name: a.name, atRisk, timeoutMs: 180_000, log: (m) => log(`cap agent: ${m}`) });
      asks.push({ try: k + 1, seated: true });
      log(`cap agent: try ${k + 1} SEATED: the cap did not hold`);
    } catch (e) {
      asks.push({ try: k + 1, seated: false, code: e.code ?? null, reason: e.reason ?? e.message });
      log(`cap agent: try ${k + 1} refused: ${e.code ?? ''} ${e.reason ?? e.message}`);
    }
  }
  await sleep(20_000);
  const after = await cageNow(a.doorToken, a.cageId);
  log(`cap agent after the refusals: cage ${after.balance} (was ${before.balance}), lost today ${after.lossToday}`);
  return { scenario: 'cap', played, day, atCap: before, asks, after, held: asks.every((x) => !x.seated && x.code === 'daily_cap') && after.balance === before.balance, leaks: leaks.length };
}

const summary = scenario === 'pair' ? await pair() : await cap();
summary.seconds = Math.round((Date.now() - t0) / 1000);
summary.requests429 = hall.rateLimited;
writeFileSync(join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
writeFileSync(join(OUT, 'log.txt'), lines.join('\n') + '\n');
console.log(`\n${OUT}/summary.json`);
console.log(JSON.stringify(summary, null, 2).slice(0, 3000));

#!/usr/bin/env node
// The table simulator: many agents at once against a Hall (a local `wrangler dev` first, then staging, on play chips).
//
//   node sim/run.mjs <scenario> --hall http://127.0.0.1:8787 [--rounds N] [--seed S] [--out runs] [--probe 0.3]
//
// Scenarios:
//   model-vs-bots    Cup & Claim: one local-model agent (Ollama) against three house bots
//   mixed4           Cup & Claim: four agents at one table: random, greedy, always-bluff, model
//   mixed4-cards     Sealed Hand: four scripted agents at one table: random, greedy, always-bluff, greedy
//   spread           many agents through POST /lobby/open, both games: checks a full table spills to a new one
//   collusion        Cup & Claim: two colluders sharing dice in secret, plus a greedy and a random agent
//   collusion-cards  Sealed Hand: two colluders in adjacent seats sharing hands, plus a greedy and a random agent
//   staging4         Cup & Claim: four agents (random, greedy, bluff, model) at one table, for a shared Hall
//   local-all        model-vs-bots, mixed4, mixed4-cards, spread, collusion, collusion-cards, one after another
//
// Each run writes runs/<time>-<scenario>/: events.log, summary.json, summary.md, chips.csv.
// Model players use Ollama at OLLAMA_URL (default 127.0.0.1:11434), model OLLAMA_MODEL (default llama3.1:8b), one request
// at a time. Without Ollama they play the greedy rule and the summary says so.

import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hall, HallError, apiFor, sleep } from '../lib/hall.mjs';
import { PLAYERS, makeTeam } from '../players/index.mjs';
import { MODEL, modelReady } from '../players/ollama.mjs';
import { freshStats, runSeat } from './seat.mjs';
import { observe } from './observer.mjs';
import { detectPairs } from './detect.mjs';

const args = process.argv.slice(2);
const flag = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const scenarioArg = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1]?.startsWith('--') !== true) ?? 'mixed4';
const HALL = flag('hall', 'http://127.0.0.1:8787');
const OUT = flag('out', new URL('../runs', import.meta.url).pathname);
const SEED = Number(flag('seed', Date.now() % 100000));
const PROBE = Number(flag('probe', 0.3));
const ROUNDS = flag('rounds', null);

function rngFrom(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) | 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const SCENARIOS = {
  'model-vs-bots': { game: 'cup-and-claim', rounds: 10, tables: [{ seats: 4, lobbySeconds: 0, agents: ['model'] }] },
  mixed4: { game: 'cup-and-claim', rounds: 10, tables: [{ seats: 4, lobbySeconds: 120, agents: ['random', 'greedy', 'bluff', 'model'] }] },
  'mixed4-cards': { game: 'sealed-hand', rounds: 8, tables: [{ seats: 4, lobbySeconds: 120, agents: ['random', 'greedy', 'bluff', 'greedy'] }] },
  collusion: { game: 'cup-and-claim', rounds: 25, tables: [{ seats: 4, lobbySeconds: 120, agents: ['colluder', 'colluder', 'greedy', 'random'] }] },
  'collusion-cards': { game: 'sealed-hand', rounds: 16, tables: [{ seats: 4, lobbySeconds: 120, agents: ['colluder', 'colluder', 'greedy', 'random'] }] },
  staging4: { game: 'cup-and-claim', rounds: 8, tables: [{ seats: 4, lobbySeconds: 120, agents: ['random', 'greedy', 'bluff', 'model'] }] },
  spread: { spread: { 'cup-and-claim': { agents: 10, seats: 4 }, 'sealed-hand': { agents: 6, seats: 4 } }, rounds: 3 },
};
const NAMES = ['Ash', 'Bram', 'Cora', 'Dace', 'Edda', 'Finn', 'Gale', 'Hale', 'Isla', 'Joss', 'Kell', 'Lark', 'Mire', 'Nell', 'Orin', 'Pell'];
const SPARK = '▁▂▃▄▅▆▇█';
const spark = (xs) => { const v = xs.filter((x) => Number.isFinite(x)); if (!v.length) return ''; const lo = Math.min(...v); const hi = Math.max(...v); return v.map((x) => SPARK[hi === lo ? 3 : Math.round(((x - lo) / (hi - lo)) * 7)]).join(''); };

async function runScenario(name) {
  const sc = SCENARIOS[name];
  if (!sc) throw new Error(`No scenario ${name}. One of: ${Object.keys(SCENARIOS).join(', ')}, local-all`);
  const rounds = ROUNDS ? Number(ROUNDS) : sc.rounds;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dir = join(OUT, `${stamp}-${name}`);
  mkdirSync(dir, { recursive: true });
  const logFile = join(dir, 'events.log');
  const log = (line) => { const l = `${new Date().toISOString().slice(11, 19)} ${line}`; appendFileSync(logFile, `${l}\n`); if (process.env.SIM_QUIET !== '1') console.log(l); };
  let requests = 0;
  const hall = new Hall(HALL, { onRequest: () => { requests += 1; }, userAgent: 'hall-agent-sim/0.1' });
  const rng = rngFrom(SEED);
  const leaks = [];
  const modelOk = await modelReady();
  log(`scenario ${name} on ${HALL}, seed ${SEED}, ${rounds} rounds, probes ${PROBE}, model ${MODEL} ${modelOk ? 'ready' : 'NOT available: model seats play the greedy rule'}`);
  const t0 = Date.now();
  const deadline = t0 + Number(flag('minutes', 25)) * 60_000;
  const seats = []; // { stats, promise }
  const tables = new Map(); // api -> { game, id, observer, agents: [] }
  const allTokens = () => seats.flatMap((x) => x.stats.tokens);
  const watch = (game, api, id) => {
    if (!tables.has(api)) tables.set(api, { game, id, api, agents: [], observer: observe({ hall, game, api, tokens: allTokens, leaks }) });
    return tables.get(api);
  };
  const playerFor = (game, type) => {
    const t = type === 'model' && !modelOk ? 'greedy' : type;
    return PLAYERS[game][t];
  };
  let nameN = 0;
  const nextName = (type) => `${NAMES[nameN++ % NAMES.length]}-${type}`;

  if (sc.tables) {
    for (const t of sc.tables) {
      const made = await hall.call('POST', sc.game === 'sealed-hand' ? '/tables' : '/dice-tables', { body: { lobbySeconds: t.lobbySeconds, ...(sc.game === 'cup-and-claim' ? { seats: t.seats } : {}) } });
      const api = apiFor(sc.game, made.id);
      const table = watch(sc.game, api, made.id);
      log(`table ${made.id.slice(0, 8)} (${sc.game}, ${t.seats} seats)`);
      const team = t.agents.includes('colluder') ? makeTeam() : null;
      // Join one by one, so seats go in order (colluders sit next to each other), then play all at once.
      const joined = [];
      for (const type of t.agents) {
        const aname = nextName(type);
        const stats = freshStats(aname, type === 'model' && !modelOk ? 'model→greedy' : type, sc.game);
        const sit = await hall.join(api, { name: aname, kind: 'agent' });
        joined.push({ type, aname, stats, sit });
        table.agents.push(aname);
      }
      for (const j of joined) {
        const promise = runSeat({ hall, game: sc.game, api, name: j.aname, player: playerFor(sc.game, j.type), rounds, rng: rngFrom(SEED + seats.length * 7919), team: j.type === 'colluder' ? team : null, probe: j.type === 'model' ? 0 : PROBE, log, stats: j.stats, leaks, joined: j.sit, deadline }).catch((err) => { j.stats.error = err.message; log(`${j.aname} stopped: ${err.message}`); });
        seats.push({ stats: j.stats, promise });
      }
    }
  } else {
    // spread: everyone asks the lobby at once; a full table must spill into a new one.
    const asks = [];
    for (const [game, cfg] of Object.entries(sc.spread)) {
      for (let i = 0; i < cfg.agents; i++) {
        const type = ['greedy', 'random', 'bluff'][i % 3];
        const aname = nextName(type);
        const stats = freshStats(aname, type, game);
        stats.lobbyTries = 0;
        asks.push((async () => {
          for (let attempt = 0; attempt < 4; attempt++) {
            stats.lobbyTries += 1;
            const got = await hall.open(game, { seats: cfg.seats, lobbySeconds: 20 });
            try {
              const sit = await hall.join(got.api, { name: aname, kind: 'agent' });
              const table = watch(game, got.api, got.id);
              table.agents.push(aname);
              stats.table = got.id;
              stats.createdTable = got.created;
              return { game, api: got.api, sit, aname, type, stats };
            } catch (err) {
              if (err instanceof HallError && ['table_full', 'table_started'].includes(err.code)) { log(`${aname} found ${got.id.slice(0, 8)} ${err.code}, asking again`); continue; }
              throw err;
            }
          }
          throw new Error(`${aname}: no seat after 4 tries`);
        })());
      }
    }
    const placed = await Promise.all(asks);
    for (const p of placed) {
      log(`${p.aname} → ${p.game} table ${p.stats.table.slice(0, 8)}${p.stats.createdTable ? ' (opened it)' : ''}`);
      const promise = runSeat({ hall, game: p.game, api: p.api, name: p.aname, player: playerFor(p.game, p.type), rounds, rng: rngFrom(SEED + seats.length * 7919), probe: PROBE, log, stats: p.stats, leaks, joined: p.sit, deadline }).catch((err) => { p.stats.error = err.message; log(`${p.aname} stopped: ${err.message}`); });
      seats.push({ stats: p.stats, promise });
    }
  }

  await Promise.all(seats.map((x) => x.promise));
  await sleep(1500);
  for (const t of tables.values()) await t.observer.stop();
  const ms = Date.now() - t0;

  // ---------- the summary ----------
  const tableRows = [];
  for (const t of tables.values()) {
    const d = t.observer.data;
    const names = d.last?.seats.map((s) => s.name) ?? [];
    const kinds = d.last?.seats.map((s) => s.kind) ?? [];
    tableRows.push({ game: t.game, id: t.id, n: d.last?.n ?? null, seats: d.last?.seatsTotal ?? null, seated: names.map((n2, i) => ({ name: n2, kind: kinds[i] })), agents: t.agents.length, roundsSeen: d.rounds.length, snapshots: d.snapshots, chipsByRound: d.rounds.map((r) => ({ round: r.round, chips: r.chips })), standings: (d.last?.seats ?? []).map((x) => ({ name: x.name, kind: x.kind, chips: x.left ? x.leftWith ?? x.chips : x.chips, left: !!x.left })).sort((a, b) => b.chips - a.chips), pairs: detectPairs({ game: t.game, log: d.log, names, kinds }) });
  }
  const agents = seats.map(({ stats: s }) => {
    const chips = s.chips.map((c) => c.chips).filter((c) => c !== null);
    return {
      name: s.name, type: s.type, game: s.game, seat: s.seat, rounds: s.rounds, start: chips[0] ?? null, end: chips.at(-1) ?? null, net: chips.length ? chips.at(-1) - chips[0] : null, chips, left: s.left ?? null, stopped: s.stopped ?? null, error: s.error ?? null,
      moves: s.moves, refused: s.refused, probes: { sent: s.probes.length, refused: s.probes.filter((p) => !p.accepted).length, accepted: s.probes.filter((p) => p.accepted), changedOnRefusal: s.probes.filter((p) => p.changed).length, changed: s.probes.filter((p) => p.changed), raced: s.probes.filter((p) => p.raced).length, codes: Object.fromEntries([...new Set(s.probes.filter((p) => !p.accepted).map((p) => `${p.probe}→${p.code}`))].map((k) => [k, s.probes.filter((p) => !p.accepted && `${p.probe}→${p.code}` === k).length])), kinds: [...new Set(s.probes.map((p) => p.probe))] },
      model: s.modelCalls ? { calls: s.modelCalls, avgMs: Math.round(s.modelMs / s.modelCalls), unusable: s.modelUnusable ?? 0, movesPlayed: s.modelMovesPlayed ?? 0, refused: s.refused.filter((r) => r.by === 'model').length, fallbackMoves: s.fallbackMoves ?? 0 } : null,
      lobbyTries: s.lobbyTries ?? null,
    };
  });
  const ranked = [...agents].filter((a) => a.net !== null).sort((a, b) => b.net - a.net);
  const summary = {
    scenario: name, hall: HALL, seed: SEED, rounds, minutes: +(ms / 60000).toFixed(1), requests, rateLimited: hall.rateLimited, model: { name: MODEL, ready: modelOk },
    winner: ranked[0] ? { name: ranked[0].name, type: ranked[0].type, net: ranked[0].net } : null,
    agents, tables: tableRows,
    probes: { sent: agents.reduce((n, a) => n + a.probes.sent, 0), refused: agents.reduce((n, a) => n + a.probes.refused, 0), accepted: agents.flatMap((a) => a.probes.accepted), changedOnRefusal: agents.reduce((n, a) => n + a.probes.changedOnRefusal, 0), raced: agents.reduce((n, a) => n + a.probes.raced, 0), codes: agents.reduce((m, a) => { for (const [k, v] of Object.entries(a.probes.codes)) m[k] = (m[k] ?? 0) + v; return m; }, {}) },
    leaks: { checked: tableRows.reduce((n, t) => n + t.snapshots, 0), found: leaks },
    flagged: tableRows.flatMap((t) => t.pairs.filter((p) => p.flagged).map((p) => ({ table: t.n, game: t.game, ...p }))),
  };
  if (name === 'spread') {
    summary.spread = Object.fromEntries(Object.entries(sc.spread).map(([game, cfg]) => {
      const ts = tableRows.filter((t) => t.game === game);
      return [game, { agents: cfg.agents, seatsPerTable: cfg.seats, tables: ts.length, expected: Math.ceil(cfg.agents / cfg.seats), agentsPerTable: ts.map((t) => t.agents), overfull: ts.filter((t) => t.agents > cfg.seats).length, retries: agents.filter((a) => a.game === game).reduce((n, a) => n + (a.lobbyTries - 1), 0) }];
    }));
  }
  writeFileSync(join(dir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(join(dir, 'chips.csv'), ['agent,type,game,round,chips', ...seats.flatMap(({ stats: s }) => s.chips.map((c) => `${s.name},${s.type},${s.game},${c.round},${c.chips}`))].join('\n') + '\n');
  writeFileSync(join(dir, 'summary.md'), markdown(summary));
  log(`done in ${summary.minutes} min: ${dir}`);
  return { dir, summary };
}

function markdown(s) {
  const lines = [`# ${s.scenario}`, '', `Hall ${s.hall} · seed ${s.seed} · ${s.rounds} rounds a seat · ${s.minutes} min · ${s.requests} requests · 429s waited out: ${s.rateLimited} · model ${s.model.name} ${s.model.ready ? 'ready' : 'not available (model seats played greedy)'}`, ''];
  lines.push(`**Best agent:** ${s.winner ? `${s.winner.name} (${s.winner.type}), ${s.winner.net >= 0 ? '+' : ''}${s.winner.net}` : 'none'}`, '');
  for (const t of s.tables) if (t.standings?.length) lines.push(`**Table ${t.n ?? t.id.slice(0, 8)} at the end** (every seat, house bots included; a house bot that runs dry is bought back in): ${t.standings.map((x) => `${x.name}${x.kind === 'agent' ? ' (agent)' : x.kind === 'house' ? ' (house)' : ''} ${x.chips}${x.left ? ' (left with)' : ''}`).join(', ')}`, '');
  lines.push('| agent | type | game | seat | rounds | start → end | net | chips over time | moves | refused | probes refused / sent |', '|---|---|---|---|---|---|---|---|---|---|---|');
  for (const a of s.agents) lines.push(`| ${a.name} | ${a.type} | ${a.game} | ${a.seat} | ${a.rounds}${a.stopped ? ' (stopped early)' : ''} | ${a.start} → ${a.end} | ${a.net >= 0 ? '+' : ''}${a.net} | ${spark(a.chips)} | ${a.moves} | ${a.refused.length} | ${a.probes.refused} / ${a.probes.sent} |`);
  const models = s.agents.filter((a) => a.model);
  if (models.length) {
    lines.push('', '**Model seats:**', '');
    for (const a of models) lines.push(`- ${a.name}: ${a.model.calls} model calls, ${a.model.avgMs} ms each on average, ${a.model.movesPlayed} of its moves played as the model said, ${a.model.refused} illegal moves suggested and refused by the Hall, ${a.model.unusable} unusable answers (timeout or not JSON), ${a.model.fallbackMoves} fallback moves`);
  }
  lines.push('', `**Illegal moves:** ${s.probes.sent} deliberate probes, ${s.probes.refused} refused, ${s.probes.accepted.length} accepted${s.probes.accepted.length ? ` (BUG: ${s.probes.accepted.map((p) => p.probe).join(', ')})` : ''}; a refusal changed the seat with nobody else moving: ${s.probes.changedOnRefusal} (another seat moved in between: ${s.probes.raced}). By probe and answer: ${Object.entries(s.probes.codes).map(([k, v]) => `${k} ×${v}`).join(', ') || 'none'}. Other refusals (a player's own move, usually a race with the clock or another seat): ${s.agents.reduce((n, a) => n + a.refused.length, 0)}.`);
  lines.push('', `**Anything seen that shouldn't be:** ${s.leaks.found.length ? s.leaks.found.map((l) => `${l.where}: ${l.what}`).join('; ') : 'nothing'} (${s.leaks.checked} public snapshots checked, plus every /me).`);
  if (s.spread) {
    lines.push('', '**Auto-open:**', '');
    for (const [g, x] of Object.entries(s.spread)) lines.push(`- ${g}: ${x.agents} agents, ${x.seatsPerTable} seats a table → ${x.tables} tables (expected ${x.expected}), agents per table ${x.agentsPerTable.join(', ')}, overfull ${x.overfull}, lobby retries ${x.retries}`);
  }
  lines.push('', '**Collusion check (public log only):**', '');
  for (const t of s.tables) {
    lines.push(`- ${t.game} table ${t.n ?? t.id.slice(0, 8)}: ${t.roundsSeen} rounds seen`);
    for (const p of t.pairs.filter((x) => x.chances >= 3).slice(0, 6)) lines.push(`  - ${p.flagged ? '**FLAGGED** ' : ''}${p.names.join(' & ')}: ${p.calls} calls in ${p.chances} chances against each other, ${p.callRateOnOthers === null ? 'n/a' : `${Math.round(p.callRateOnOthers * 100)}%`} on others, p=${p.p ?? 'n/a'}`);
  }
  return `${lines.join('\n')}\n`;
}

const list = scenarioArg === 'local-all' ? ['model-vs-bots', 'mixed4', 'mixed4-cards', 'spread', 'collusion', 'collusion-cards'] : [scenarioArg];
const results = [];
for (const name of list) results.push(await runScenario(name));
if (results.length > 1) console.log(results.map((r) => r.dir).join('\n'));

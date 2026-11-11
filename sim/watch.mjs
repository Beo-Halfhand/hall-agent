#!/usr/bin/env node
// Watch a live table from outside, as any spectator can, and write the same checks the simulator makes: stacks over time,
// anything private in the public state, and the collusion check. For a test night: run it before the first deal, stop it
// (Ctrl-C) when the table is done.
//
//   node sim/watch.mjs --hall https://halfhand.app --game cup-and-claim --table <id> [--minutes 60] [--out runs]

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hall, apiFor, sleep } from '../lib/hall.mjs';
import { observe } from './observer.mjs';
import { detectPairs } from './detect.mjs';

const args = process.argv.slice(2);
const flag = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const HALL = flag('hall', 'https://halfhand.app');
const GAME = flag('game', 'cup-and-claim');
const TABLE = flag('table');
const MINUTES = Number(flag('minutes', 60));
const OUT = flag('out', new URL('../runs', import.meta.url).pathname);
if (!TABLE) { console.error('--table <id> is needed (the id from the table link, or from GET /lobby/tables).'); process.exit(1); }

const hall = new Hall(HALL, { userAgent: 'hall-agent-watch/0.1' });
const api = apiFor(GAME, TABLE);
const leaks = [];
const obs = observe({ hall, game: GAME, api, tokens: () => [], leaks, everyMs: 1000 });
let stopping = false;
const finish = async () => {
  if (stopping) return;
  stopping = true;
  await obs.stop();
  const d = obs.data;
  const names = d.last?.seats.map((s) => s.name) ?? [];
  const kinds = d.last?.seats.map((s) => s.kind) ?? [];
  const pairs = detectPairs({ game: GAME, log: d.log, names, kinds });
  const dir = join(OUT, `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-watch-${TABLE.slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  const summary = { hall: HALL, game: GAME, table: TABLE, n: d.last?.n ?? null, rounds: d.rounds.length, snapshots: d.snapshots, seats: names.map((name, i) => ({ name, kind: kinds[i], chips: d.rounds.map((r) => r.chips[i]) })), leaks, pairs };
  writeFileSync(join(dir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  const lines = [`# Table ${summary.n ?? TABLE.slice(0, 8)} (${GAME})`, '', `${summary.rounds} rounds watched, ${summary.snapshots} snapshots. Private data in public: ${leaks.length ? leaks.map((l) => l.what).join('; ') : 'none'}.`, '', '| seat | kind | stacks by round |', '|---|---|---|'];
  for (const s of summary.seats) lines.push(`| ${s.name} | ${s.kind} | ${s.chips.join(' → ')} |`);
  lines.push('', 'Collusion check (public log):', '');
  for (const p of pairs.filter((x) => x.chances >= 3)) lines.push(`- ${p.flagged ? '**FLAGGED** ' : ''}${p.names.join(' & ')}: ${p.calls} calls in ${p.chances} chances against each other, ${p.callRateOnOthers === null ? 'n/a' : `${Math.round(p.callRateOnOthers * 100)}%`} on others, p=${p.p ?? 'n/a'}`);
  writeFileSync(join(dir, 'summary.md'), `${lines.join('\n')}\n`);
  console.log(`written: ${dir}`);
  process.exit(0);
};
process.on('SIGINT', finish);
console.log(`watching ${HALL}${api} for up to ${MINUTES} min (Ctrl-C to stop and write the summary)`);
const end = Date.now() + MINUTES * 60_000;
while (Date.now() < end && !stopping) {
  await sleep(5000);
  if (obs.data.last?.phase === 'over') break;
}
await finish();

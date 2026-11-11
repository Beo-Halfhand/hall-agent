// A local-model player for Cup & Claim, through Ollama's /api/chat. The model sees what the seat sees (its dice, the public
// bid, its legal moves) and answers one JSON move. Its move is sent to the Hall as it is, so an illegal one is refused there and
// counted; then the greedy rule plays instead. One request at a time per process (a shared gate), so a fleet box isn't swamped.
//
// Default model: llama3.1:8b, small context (2048), unloaded two minutes after its last use. Set OLLAMA_URL / OLLAMA_MODEL.

import { diceGreedy, expectedCount, validBids } from './dice.mjs';

const URL_BASE = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434';
export const MODEL = process.env.OLLAMA_MODEL ?? 'llama3.1:8b';
const TIMEOUT_MS = 45_000;

let gate = Promise.resolve();
/** Runs `fn` after every earlier model call has finished. */
function oneAtATime(fn) {
  const run = gate.then(fn, fn);
  gate = run.catch(() => {});
  return run;
}

const SYSTEM = [
  'You play Cup & Claim, a liar\'s dice game, for play chips. Every player has 5 dice under a cup; you see only yours. 1s are wild:',
  'they count as any face. A bid {count, face} says "at least count dice on the whole table show face". A new bid must beat the',
  'standing one: a higher count, or the same count and a higher face. Faces 2 to 6 only. "liar" calls the standing bid too high:',
  'everyone\'s dice are counted and whoever is wrong pays. "fold" sits the round out. Each die you cannot see shows a given face',
  '(wilds included) with chance 1/3. Reply with ONE JSON object and nothing else: {"action":"bid","count":N,"face":F} or',
  '{"action":"liar"} or {"action":"fold"}. You may add "raise": n to a bid. Choose only from the legal moves you are given.',
].join(' ');

export function promptFor(me, view) {
  const legal = Object.fromEntries(me.legal.map((m) => [m.action, m]));
  const lines = [
    `Your dice: ${me.dice.join(', ')}. Your count of each face, 1s included: ${[2, 3, 4, 5, 6].map((f) => `${f}s=${me.counts[f]}`).join(', ')}.`,
    `Dice on the table: ${view.totalDice} (${view.totalDice - me.dice.length} you can't see).`,
    view.bid ? `Standing bid: at least ${view.bid.count} dice showing ${view.bid.face}, by ${view.seats[view.bid.seat]?.name ?? 'someone'}. Expected count of ${view.bid.face}s: ${expectedCount(view.bid.face, me, view).toFixed(1)}.` : 'No bid yet: you open.',
    'Legal moves now:',
    legal.bid ? `- bid: lowest legal bid is ${legal.bid.lowest.count} x ${legal.bid.lowest.face}s, count at most ${legal.bid.maxCount}${legal.bid.raise ? `, optional raise ${legal.bid.raise.min}-${legal.bid.raise.max}` : ''}. Some legal bids: ${validBids(legal.bid, 1).slice(0, 8).map((b) => `${b.count}x${b.face}`).join(' ')}` : null,
    legal.liar ? '- liar' : null,
    legal.fold ? '- fold' : null,
    'Your move, as one JSON object:',
  ];
  return lines.filter(Boolean).join('\n');
}

/** Asks the model. Returns { move, raw, ms } or { error, raw, ms }. */
export async function askModel(me, view) {
  return oneAtATime(async () => {
    const t0 = Date.now();
    try {
      const res = await fetch(`${URL_BASE}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: MODEL, stream: false, format: 'json', keep_alive: '2m', options: { num_ctx: 2048, temperature: 0.4, num_predict: 60 }, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: promptFor(me, view) }] }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const data = await res.json();
      const raw = data?.message?.content ?? '';
      const move = JSON.parse(raw);
      if (!move || typeof move.action !== 'string') return { error: 'no_action', raw, ms: Date.now() - t0 };
      for (const k of ['count', 'face', 'raise']) if (move[k] !== undefined) move[k] = Number(move[k]);
      return { move, raw, ms: Date.now() - t0 };
    } catch (err) {
      return { error: err.name === 'TimeoutError' ? 'timeout' : 'unparseable', raw: String(err.message).slice(0, 120), ms: Date.now() - t0 };
    }
  });
}

export const diceModel = {
  type: 'model',
  usesModel: true,
  /** Routine moves (next, prove, back) need no model. Otherwise the model's move, with the greedy one as the fallback. */
  async decide(me, view, ctx) {
    const legal = Object.fromEntries(me.legal.map((m) => [m.action, m]));
    if (legal.back || legal.next || legal.reveal) return { move: diceGreedy.decide(me, view, ctx), source: 'routine' };
    const asked = await askModel(me, view);
    ctx.stats.modelCalls = (ctx.stats.modelCalls ?? 0) + 1;
    ctx.stats.modelMs = (ctx.stats.modelMs ?? 0) + asked.ms;
    const fallback = diceGreedy.decide(me, view, ctx);
    if (asked.error) {
      ctx.stats.modelUnusable = (ctx.stats.modelUnusable ?? 0) + 1;
      return { move: fallback, source: `fallback:${asked.error}` };
    }
    return { move: asked.move, fallback, source: 'model' };
  },
};

/** Is Ollama up, with the model there? */
export async function modelReady() {
  try {
    const tags = await (await fetch(`${URL_BASE}/api/tags`, { signal: AbortSignal.timeout(3000) })).json();
    return tags.models?.some((m) => m.name === MODEL) ?? false;
  } catch {
    return false;
  }
}

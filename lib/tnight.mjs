// tNIGHT for agents (phase 2): an agent with its own Midnight Preprod wallet, paying out to its owner. Three steps over HTTP, each
// signed elsewhere (the agent's wallet, or the owner's), so this file never holds a key:
//   1. the owner's settings: POST /agent-settings, signed by the owner's wallet (the cage id's payout). Waits for the judge.
//   2. the door: POST /door, signed by the agent's own wallet. Waits for the judge. One door token works at every tNIGHT table.
//   3. a seat: POST <api>/cage-seat with the door token and how much to put at risk. The judge seats it from the cage: nothing to
//      sign. Waits for the block (about 30 s to a minute). Then play as at a chip table, with the seat token.
// The table rules hold: at most 250 at risk in a seat, the owner's daily cap (1,000 by default), and Stop.

import { HallError, sleep } from './hall.mjs';

const STAR = 1_000_000n;

/** Posts an owner's signed settings and waits for the judge. Returns the setting in force. Throws if refused. */
export async function ownerSettings(hall, signed, { timeoutMs = 240_000, log = () => {} } = {}) {
  for (let tries = 0; ; tries++) {
    try { await hall.call('POST', '/agent-settings', { body: signed }); break; } catch (e) {
      if (e.code === 'older_setting') break; // the same or a newer one is already there
      if (tries >= 3 || !(e.status === 503 || e.status === 429)) throw e;
      log(`settings: ${e.code}, trying again`);
      await sleep(5000);
    }
  }
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const s = await hall.call('GET', `/agent-settings/${signed.cageId}`);
    if (s.current?.signedAt === signed.signedAt) { log(`owner's setting in force: ${s.current.limit}`); return s.current; }
    if (s.pending?.signedAt === signed.signedAt && s.pending.status === 'refused') throw new Error(`the judge refused the owner's setting: ${s.pending.reason}`);
    await sleep(4000);
  }
  throw new Error('the judge has not checked the owner\'s setting yet');
}

/** Enters the door with a session the agent's wallet signed. Returns the door token once the judge has verified it. */
export async function enterDoor(hall, signed, { name, avatar, timeoutMs = 240_000, log = () => {} } = {}) {
  const { token } = await hall.call('POST', '/door', { body: { ...signed, name, avatar, kind: 'agent' } });
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const me = await hall.call('GET', '/door/me', { token });
    if (me.status === 'verified') { log(`in at the door: cage balance ${Number(me.balanceStar ?? 0) / 1e6} tNIGHT`); return { token, door: me }; }
    if (me.status === 'refused') throw new Error(`the door refused: ${me.reason}`);
    await sleep(3000);
  }
  throw new Error('the judge has not checked the door yet');
}

/** A tNIGHT table of this game with a free seat, waiting to start: the judge keeps one warm at each game. */
export async function warmTable(hall, game) {
  const { tables } = await hall.tables();
  return tables.find((t) => t.tnight && t.game === game && t.joinable && t.phase === 'lobby') ?? null;
}

/**
 * Asks the judge for a seat at a tNIGHT table and waits until it is seated. Returns { seat, token, atRiskStar } for the table's
 * own routes. A refusal throws HallError-like { code, reason }: daily_cap, agent_stopped, need_grant, table_full …
 */
export async function sitTnight(hall, api, { doorToken, name, atRisk, timeoutMs = 300_000, log = () => {} }) {
  const claim = await hall.call('POST', `${api}/cage-seat`, { body: { doorToken, name, atRiskStar: String(BigInt(atRisk) * STAR) } });
  const t0 = Date.now();
  let step = null;
  while (Date.now() - t0 < timeoutMs) {
    const c = await hall.call('GET', `${api}/cage-seat`, { token: claim.token });
    if (c.status === 'seated') { log(`seated by the judge at seat ${c.seat}`); return { seat: c.seat, token: claim.token, receipt: c.receipt ?? null }; }
    if (c.status === 'refused') { const e = new HallError(409, { error: c.code ?? 'refused', message: c.reason }, 'POST', `${api}/cage-seat`); e.reason = c.reason; throw e; }
    if (c.step && c.step !== step) { step = c.step; log(`judge: ${step}`); }
    await sleep(3000);
  }
  throw new Error('the judge has not seated it yet');
}

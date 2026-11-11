// A small agent for Cup & Claim: sits at a table against the house, plays a few rounds, leaves. Node 18 or newer.
//   node agent-example.mjs [hall-url] [rounds]
// It needs no account: joining without a player token plays on the table's own chips. Every call is a plain HTTP request.
const HALL = process.argv[2] ?? 'https://halfhand.app';
const ROUNDS = Number(process.argv[3] ?? 3);

async function call(method, path, token, body) {
  const res = await fetch(HALL + path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${data.error}: ${data.message}`);
  return data;
}

// 1. A table of two: me and Tally, the house. (To join someone else's, read GET /games and POST its /join.)
const { id } = await call('POST', '/dice-tables', null, { lobbySeconds: 0, seats: 2 });
const table = `/dice-tables/${id}`;

// 2. Sit down. The seat token in the reply is your key to this seat: keep it, it is shown once.
const { seat, token } = await call('POST', `${table}/join`, null, { name: 'ExampleAgent', kind: 'agent' });
console.log(`seated at seat ${seat} of table ${id.slice(0, 8)}…`);

// 3. Play. Ask what is legal, answer it, repeat. An empty legal list means it is not your move yet.
let rounds = 0;
while (rounds < ROUNDS) {
  const me = await call('GET', `${table}/me`, token);
  const legal = Object.fromEntries(me.legal.map((move) => [move.action, move]));
  if (!me.legal.length) { await new Promise((r) => setTimeout(r, 400)); continue; }

  let move;
  if (legal.next) {
    const view = await call('GET', table);
    console.log(`round ${view.round}: ${view.lastResult?.kind}, my stack ${view.seats[seat].chips}`);
    rounds += 1;
    if (rounds >= ROUNDS) break;
    move = { action: 'next' };
  } else if (legal.reveal) {
    move = { action: 'reveal', mode: 'prove' };
  } else {
    // Guess how many of a face the whole table holds: my own count (1s are wild) plus a third of the other dice.
    const view = await call('GET', table);
    const others = view.totalDice - me.dice.length;
    const expected = (face) => me.counts[face] + others / 3;
    const bid = legal.bid;
    if (legal.liar && legal.liar.bid.count > expected(legal.liar.bid.face) + 1) move = { action: 'liar' };
    else if (bid && bid.lowest.count <= bid.maxCount) move = { action: 'bid', ...bid.lowest };
    else move = legal.liar ? { action: 'liar' } : { action: 'fold' };
  }
  await call('POST', `${table}/act`, token, move);
  console.log('played', JSON.stringify(move));
}

// 4. Leave. Between rounds your stack is paid out at once; mid-round it is paid when the round ends.
const left = await call('POST', `${table}/leave`, token, {});
console.log(left.queued ? 'leaving after this round' : `left with ${left.amount} chips`);

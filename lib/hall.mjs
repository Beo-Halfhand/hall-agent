// A tiny client for the Hall's agent API. No dependencies: Node 18+ fetch. Every method is one HTTP request (plus polite
// retries on 429). The whole API is in /agents/llms.txt on any Hall.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class HallError extends Error {
  constructor(status, data, method, path) {
    super(`${method} ${path}: ${status} ${data?.error ?? ''}: ${data?.message ?? ''}`);
    this.status = status;
    this.code = data?.error ?? null;
    this.data = data;
  }
}

export class Hall {
  /** `base`: the Hall's address, such as https://halfhand.app. `onRequest` sees every request (for counting). */
  constructor(base, { onRequest = null, maxRetries = 4, userAgent = 'hall-agent/0.1' } = {}) {
    this.base = base.replace(/\/$/, '');
    this.onRequest = onRequest;
    this.maxRetries = maxRetries;
    this.userAgent = userAgent;
    this.rateLimited = 0;
  }

  /** One request. Returns the JSON body. Throws HallError on a 4xx/5xx (after waiting out 429s). */
  async call(method, path, { token = null, body = undefined } = {}) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(this.base + path, {
        method,
        headers: { 'user-agent': this.userAgent, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        redirect: 'manual',
      });
      this.onRequest?.({ method, path, status: res.status });
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = { error: 'not_json', message: text.slice(0, 200) }; }
      if (res.status === 429 && attempt < this.maxRetries) {
        this.rateLimited += 1;
        const wait = Math.min(15, Number(res.headers.get('retry-after') ?? 5)) * 1000;
        await sleep(wait);
        continue;
      }
      if (res.status >= 400) throw new HallError(res.status, data, method, path);
      return data;
    }
  }

  // The lobby.
  open(game, opts = {}) { return this.call('POST', '/lobby/open', { body: { game, ...opts } }); }
  tables() { return this.call('GET', '/lobby/tables'); }

  // A seat. `api` is /dice-tables/<id> or /tables/<id>.
  join(api, { name, kind = 'agent', playerToken = null, buyIn } = {}) { return this.call('POST', `${api}/join`, { token: playerToken, body: { name, kind, ...(buyIn ? { buyIn } : {}) } }); }
  me(api, token) { return this.call('GET', `${api}/me`, { token }); }
  state(api) { return this.call('GET', api); }
  act(api, token, move) { return this.call('POST', `${api}/act`, { token, body: move }); }
  say(api, token, text) { return this.call('POST', `${api}/say`, { token, body: { text } }); }
  leave(api, token) { return this.call('POST', `${api}/leave`, { token, body: {} }); }
}

export const apiFor = (game, id) => `${game === 'sealed-hand' ? '/tables' : '/dice-tables'}/${id}`;
export { sleep };

import { DurableObject } from 'cloudflare:workers';
import { RoomService, UPDATE_MS, MAX_INPUT_BYTES, hashToken, parseInput } from './room-service.js';
import { IDLE_CLOSE_CODE } from '../multiplayer/inactivity.js';

const json = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const errorBody = error => ({ type: 'error', status: error.status || 503,
  ...(error.code ? { code: error.code } : {}),
  error: error.status ? error.message : 'The lake is reconnecting…' });

export class LakeRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.service = new RoomService();
    this.clients = new Set();
    this.owners = new Map();
    this.limits = new Map();
    this.timer = null;
    this.frame = 0;
  }

  rateLimit(id, now) {
    let limit = this.limits.get(id);
    if (!limit) {
      for (const [key, value] of this.limits) if (now - value.at > 15000) this.limits.delete(key);
      if (this.limits.size >= 128) throw Object.assign(new Error('The lake is busy. Try again shortly.'), { status: 429 });
      limit = { at: now, budget: 60 };
      this.limits.set(id, limit);
    }
    limit.budget = Math.min(60, limit.budget + Math.max(0, now - limit.at) * .04);
    limit.at = now;
    if (limit.budget < 1) throw Object.assign(new Error('Too many updates.'), { status: 429 });
    limit.budget--;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const now = Date.now();
      this.service.tick(now);
      for (const client of this.clients) {
        if (!client.id) {
          if (now - client.openedAt > 5000) this.close(client, 1008, 'Join timed out');
          continue;
        }
        if (now - client.lastAckAt > 5000) { this.close(client, 1013, 'Connection too slow'); continue; }
        if (client.awaitingFrame && client.frameAck < client.awaitingFrame) continue;
        try {
          this.send(client, { type: 'snapshot', echo: client.echo, ...this.service.view(client.id, client.hash, client.wakeSince, now) });
        } catch (error) {
          this.send(client, errorBody(error));
          this.close(client, error.code === 'idle' ? IDLE_CLOSE_CODE : 1012, error.code === 'idle' ? 'Inactive for 3 minutes' : 'Rejoin the lake');
        }
      }
      if (!this.clients.size && !this.service.active) { clearInterval(this.timer); this.timer = null; }
    }, UPDATE_MS);
  }

  send(client, data) {
    try {
      if (client.socket.readyState !== 1 || (client.socket.bufferedAmount || 0) > 512000) {
        this.close(client, 1013, 'Connection too slow'); return;
      }
      const frame = ++this.frame;
      client.socket.send(JSON.stringify({ ...data, frame }));
      client.lastFrame = frame;
    } catch { this.close(client, 1011, 'Reconnect'); }
  }

  close(client, code = 1000, reason = 'Left the lake') {
    this.clients.delete(client);
    if (this.owners.get(client.id) === client) this.owners.delete(client.id);
    // Unexpected closes retain the reservation for a short reconnect. Only an
    // explicit leave ends the session and removes its boats immediately.
    try { client.socket.close(code, reason); } catch {}
  }

  async message(client, text) {
    if (!this.clients.has(client)) return;
    const input = parseInput(text), now = Date.now();
    this.rateLimit(input.id, now);
    if (client.id && (input.id !== client.id || input.token !== client.token)) throw Object.assign(new Error('Invalid session.'), { status: 403 });
    if (!client.id && input.action !== 'join') throw Object.assign(new Error('Join the lake first.'), { status: 410 });
    const hash = client.hash || await hashToken(input.token);
    if (!this.clients.has(client)) return;
    const result = this.service.action(input, hash, Date.now());
    if (result.code === 'idle') {
      this.send(client, { type: 'error', ...result });
      this.close(client, IDLE_CLOSE_CODE, 'Inactive for 3 minutes'); return;
    }
    if (!client.id) {
      const previous = this.owners.get(input.id);
      client.id = input.id; client.hash = hash; client.token = input.token;
      this.owners.set(input.id, client);
      if (previous && previous !== client) this.close(previous, 1000, 'Connection replaced');
    }
    client.wakeSince = Number.isSafeInteger(input.wakeSince) ? input.wakeSince : 0;
    if (Number.isSafeInteger(input.frameAck) && input.frameAck > client.frameAck && input.frameAck <= client.lastFrame) {
      client.frameAck = input.frameAck; client.lastAckAt = now;
    }
    if (input.action === 'leave') { this.close(client); return; }
    // Syncs are coalesced into the 20 Hz stream; join/reset have immediate,
    // explicitly tagged replies so delayed snapshots cannot release a reset.
    if (input.action !== 'sync') {
      this.send(client, { type: 'reply', action: input.action, requestSeq: input.seq,
        resetRevision: input.resetRevision, echo: input.sentAt, ...result });
      // Wait until the client has installed its spawn and full wake history.
      // Otherwise a slow join would queue that history again every 50 ms.
      client.awaitingFrame = client.lastFrame;
    }
    else client.echo = input.sentAt;
    // Deliver both owners' collision corrections immediately, including a
    // collision caused by the other player's update.
    for (const other of this.clients) {
      const p = this.service.room.players[other.id];
      if (p?.correction && p.correction.seq !== other.sentCorrection && (!other.awaitingFrame || other.frameAck >= other.awaitingFrame)) {
        other.sentCorrection = p.correction.seq;
        this.send(other, { type: 'snapshot', ...this.service.view(other.id, other.hash, other.wakeSince, Date.now()) });
      }
    }
  }

  async fetch(request) {
    if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      if (this.clients.size >= 24) return json({ error: 'The lake is busy.' }, 503);
      const [browser, socket] = Object.values(new WebSocketPair());
      socket.accept();
      const client = { socket, openedAt: Date.now(), lastAckAt: Date.now(), frameAck: 0, lastFrame: 0,
        wakeSince: 0, pending: 0, chain: Promise.resolve() };
      this.clients.add(client);
      socket.addEventListener('message', event => {
        if (++client.pending > 8) { this.close(client, 1008, 'Too many updates'); return; }
        client.chain = client.chain.then(() => this.message(client, event.data))
          .catch(error => { this.send(client, errorBody(error)); if ([400, 403, 413, 429].includes(error.status)) this.close(client, 1008, 'Invalid update'); })
          .finally(() => client.pending--);
      });
      socket.addEventListener('close', () => this.close(client));
      socket.addEventListener('error', () => this.close(client, 1011, 'Reconnect'));
      this.start();
      return new Response(null, { status: 101, webSocket: browser });
    }
    try {
      if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405);
      if (Number(request.headers.get('Content-Length')) > MAX_INPUT_BYTES) return json({ error: 'Update too large.' }, 413);
      const input = parseInput(await request.text());
      this.rateLimit(input.id, Date.now());
      const hash = await hashToken(input.token);
      const result = this.service.action(input, hash, Date.now());
      this.start();
      return json(result, result.status || 200);
    } catch (error) { const body = errorBody(error); return json(body, body.status); }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return json({ ok: true, transport: 'websocket', updateHz: 20 });
    if (!['/lake', '/api/lake'].includes(url.pathname)) return new Response('Not found', { status: 404 });
    const origin = request.headers.get('Origin');
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(value => value.trim());
    if (origin && !allowed.includes(origin)) return json({ error: 'Use the game on its public site.' }, 403);
    if (url.pathname === '/lake' && request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'WebSocket required.' }, 426);
    return env.LAKE_ROOM.getByName('shared-lake').fetch(request);
  }
};

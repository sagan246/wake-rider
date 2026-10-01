// Exercise a running Wrangler server, or a deployed endpoint passed as argv[2].
import assert from 'node:assert/strict';
import { createSocketClient } from '../multiplayer/socket-client.js';
import { createSimulator } from '../simulation/simulator.js';
import { OSWEGO_MAP as lake } from '../maps/catalog.js';
import { SHARED_LAKE_RULES } from '../simulation/defaults.js';

const base = process.argv[2] || 'http://127.0.0.1:8787';
const url = new URL('/lake', base).href.replace(/^http/, 'ws');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message) {
  const deadline = Date.now() + 8000;
  while (!check() && Date.now() < deadline) await sleep(40);
  assert.ok(check(), message);
}
const clients = [], sockets = [], stats = [];
const extra = { id: crypto.randomUUID(), token: crypto.randomUUID() + crypto.randomUUID(), physicsVersion: SHARED_LAKE_RULES.version };
const post = async input => {
  const response = await fetch(new URL('/api/lake', base), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  assert.equal(response.status, 200); return response.json();
};
try {
  // A slow reader must receive only one initial full-history reply until it
  // acknowledges installing the spawn/history. This also covers busy lakes.
  const probe = new WebSocket(url), probeMessages = [];
  probe.addEventListener('message', event => probeMessages.push(JSON.parse(event.data)));
  await until(() => probe.readyState === 1, 'Delayed-ack test socket connects');
  probe.send(JSON.stringify({ ...extra, action: 'join', seq: 0, name: 'Delayed-ack test' }));
  await until(() => probeMessages.some(m => m.type === 'reply'), 'Join gets an immediate reply');
  await sleep(250);
  assert.equal(probeMessages.length, 1, 'No duplicate full-history snapshots before the initial acknowledgment');
  probe.send(JSON.stringify({ ...extra, action: 'leave' }));
  await until(() => probe.readyState === 3, 'Explicit leave closes the connection');
  extra.id = crypto.randomUUID();
  for (let i = 0; i < 2; i++) {
    const sim = createSimulator({ map: lake }), stat = { spawns: 0, frames: 0, ids: new Set() };
    stats.push(stat);
    const client = createSocketClient({ url, socketFactory: address => {
      const socket = new WebSocket(address); sockets[i] = socket;
      socket.addEventListener('message', event => {
        const data = JSON.parse(event.data);
        if (data.type === 'snapshot') { stat.frames++; for (const p of data.players) stat.ids.add(p.id); }
      });
      return socket;
    }, read: () => ({ ...sim.getState(), name: `Connection test ${i + 1}`, botCount: i === 0 ? 1 : 0, paused: true }),
    onSpawn: spawn => { stat.spawns++; sim.reset(spawn); },
    onCorrection: event => sim.applyNetworkCorrection(event),
    onWakes: (events, now, receipt) => sim.receiveSharedWakes(events, now, receipt) });
    clients.push(client); client.setMap('oswego');
  }
  await until(() => clients.every(client => client.ready && client.getPeers().length >= 2), 'Two live sockets see each other and the optional bot');
  const framesAt = stats[0].frames, botBefore = clients[0].getPeers().find(p => p.isBot).boat;
  await sleep(2100);
  const frames = stats[0].frames - framesAt;
  assert.ok(frames >= 30, `Expected near-20Hz snapshots; got ${frames} in 2.1s`);
  const botAfter = clients[0].getPeers().find(p => p.isBot).boat;
  assert.ok(Math.hypot(botAfter.x - botBefore.x, botAfter.y - botBefore.y) > .1, 'Room timer moves bots');
  const joined = await post({ ...extra, action: 'join', name: 'HTTP compatibility test' });
  assert.ok(joined.players.some(p => p.id === clients[0].self.id), 'HTTP and WebSocket join the same lake');
  await until(() => stats[0].ids.has(extra.id), 'HTTP visitor is broadcast to WebSocket players');
  const spawnCount = stats[0].spawns; sockets[0].close();
  await until(() => clients[0].ready && sockets[0].readyState === 1, 'Client reconnects');
  assert.equal(stats[0].spawns, spawnCount, 'Reconnect preserves current boat instead of relaunching');
  clients[0].reset(); await until(() => stats[0].spawns > spawnCount && clients[0].ready, 'Reset acknowledged through WebSocket');
  console.log(`Live realtime checks passed: ${(frames / 2.1).toFixed(1)} snapshots/sec, two players, autonomous bot, shared HTTP room, reconnect and reset.`);
} finally {
  for (const client of clients) client.leave();
  await post({ ...extra, action: 'leave' });
  await sleep(100);
}

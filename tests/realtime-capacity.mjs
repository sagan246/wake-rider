// Fill only the local Wrangler room; never occupy the public lake for a test.
import assert from 'node:assert/strict';
import { createSocketClient } from '../multiplayer/socket-client.js';
import { createSimulator } from '../simulation/simulator.js';
import { OSWEGO_MAP as lake } from '../maps/catalog.js';
import { MAX_PLAYERS } from '../multiplayer/room-limits.js';

const url = 'ws://127.0.0.1:8787/lake';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message) {
  const deadline = Date.now() + 10000;
  while (!check() && Date.now() < deadline) await sleep(25);
  assert.ok(check(), message);
}
const clients = [], stats = [];
function addPlayer(index) {
  const sim = createSimulator({ map: lake });
  const stat = { frames: 0, fullReplies: 0, messages: [] }; stats.push(stat);
  const client = createSocketClient({ url, socketFactory: address => {
    const socket = new WebSocket(address);
    socket.addEventListener('message', event => {
      const data = JSON.parse(event.data);
      if (data.type === 'snapshot') stat.frames++;
      if (data.code === 'room_full') stat.fullReplies++;
    });
    return socket;
  }, read: () => ({ ...sim.getState(), name: `Capacity test ${index + 1}`, botCount: index === 0 ? 3 : 0, paused: true }),
  onSpawn: spawn => sim.reset(spawn), onCorrection: event => sim.applyNetworkCorrection(event),
  onWakes: (events, now, receipt) => sim.receiveSharedWakes(events, now, receipt),
  onStatus: ({ message }) => stat.messages.push(message) });
  clients.push(client); client.setMap('oswego'); return client;
}
try {
  const owner = addPlayer(0);
  await until(() => owner.ready && owner.getPeers().filter(p => p.isBot).length === 3, 'Owner adds three shared bots');
  for (let index = 1; index < MAX_PLAYERS; index++) {
    const client = addPlayer(index); await until(() => client.ready, `Player ${index + 1} joins`);
  }
  await until(() => owner.getPeers().length === MAX_PLAYERS - 1 && owner.getPeers().every(p => !p.isBot), 'Sixteen humans displace all bots');
  assert.equal(new Set([owner.self.color, ...owner.getPeers().map(p => p.color)]).size, MAX_PLAYERS);
  const waiting = addPlayer(MAX_PLAYERS), stat = stats.at(-1), startFrames = stats[0].frames, start = performance.now();
  await until(() => stat.fullReplies >= 4, 'The next player receives repeated full-room responses');
  assert.equal(waiting.ready, false); assert.match(waiting.status, /Lake full \(16\/16 players\)/);
  assert.ok(stat.messages.filter(m => !m.startsWith('Joining')).every(m => m.startsWith('Lake full')), 'Automatic retry never replaces full with reconnecting');
  const frequency = (stats[0].frames - startFrames) / ((performance.now() - start) / 1000);
  assert.ok(frequency >= 15, `Crowded room keeps streaming; got ${frequency.toFixed(1)} snapshots/sec`);
  // Free a human slot. The owner's bot request may refill it first; the waiting
  // human must still win admission without a reset or a page refresh.
  clients[1].leave();
  await until(() => waiting.ready, 'Waiting player automatically joins when space opens');
  await until(() => waiting.getPeers().length === MAX_PLAYERS - 1 && waiting.getPeers().every(p => !p.isBot), 'Admitted human displaces any returning bot');
  assert.ok(!waiting.status.includes('full'));
  console.log(`Live capacity passed: ${MAX_PLAYERS} humans, unique colors, human priority over bots, clear full notice, automatic admission; ${frequency.toFixed(1)} snapshots/sec locally.`);
} finally {
  for (const client of clients) client.leave();
  await sleep(150);
}

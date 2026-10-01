import assert from 'node:assert/strict';
import { createLakeClient } from '../multiplayer/http-client.js';
import { OSWEGO_MAP as lake } from '../maps/catalog.js';

const fullMessage = 'Lake full (16/16 players). Waiting for a spot — retrying automatically…';
const body = { ...lake.spawn, vx: 0, vy: 0, z: 0, pitch: 0, roll: 0 };
let responseMode = 'full', spawns = 0;
const actions = [];
const client = createLakeClient({ read: () => ({ boat: body, tube: body }), onSpawn: () => spawns++, onCorrection: () => {},
  fetcher: async (_, options) => {
    const request = JSON.parse(options.body); actions.push(request.action);
    if (request.action === 'leave') return Response.json({ left: true });
    if (responseMode === 'full') return Response.json({ code: 'room_full', error: fullMessage }, { status: 409 });
    if (responseMode === 'offline') throw new Error('Offline');
    return Response.json({ serverTime: Date.now(), self: { id: request.id, name: 'Tester', spawn: lake.spawn }, players: [], wakeEvents: [] });
  }
});
async function until(check) {
  const deadline = Date.now() + 2500;
  while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(check(), 'Expected HTTP retry state');
}
try {
  client.setMap('oswego'); await until(() => client.status === fullMessage);
  client.reset(); assert.equal(client.status, fullMessage);
  responseMode = 'ready'; await until(() => client.ready); assert.equal(spawns, 1);
  responseMode = 'full'; await until(() => client.status === fullMessage);
  const lastRequest = actions.length;
  responseMode = 'ready'; await until(() => client.ready);
  assert.equal(actions[lastRequest], 'join', 'A full reconnect retries join rather than reset');
  assert.equal(spawns, 2);
  responseMode = 'full'; await until(() => client.status === fullMessage);
  responseMode = 'offline'; await until(() => /Connection interrupted/.test(client.status));
  client.setMap('open'); assert.equal(client.status, 'Solo · Open Water');
} finally { client.leave(); }
console.log('HTTP capacity checks passed: clear full notice, retry, successful admission, expired reservation and network failure.');

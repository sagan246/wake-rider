import assert from 'node:assert/strict';
import { createSocketClient } from '../multiplayer/socket-client.js';
import { createLakeClient } from '../multiplayer/client.js';
import { OSWEGO_MAP as lake } from '../maps/catalog.js';

let time = 100, tasks = new Map(), nextTimer = 0;
const schedule = (fn, delay) => { tasks.set(++nextTimer, { fn, at: time + delay }); return nextTimer; };
const cancel = id => tasks.delete(id);
function advance(ms) {
  const end = time + ms;
  for (;;) {
    const first = [...tasks].sort((a, b) => a[1].at - b[1].at)[0];
    if (!first || first[1].at > end) break;
    tasks.delete(first[0]); time = first[1].at; first[1].fn();
  }
  time = end;
}
class Socket {
  readyState = 0; bufferedAmount = 0; listeners = {}; sent = [];
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  emit(type, value = {}) { for (const fn of this.listeners[type] || []) fn(value); }
  open() { this.readyState = 1; this.emit('open'); }
  send(value) { this.sent.push(JSON.parse(value)); }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.emit('close'); }
  message(value) { this.emit('message', { data: JSON.stringify(value) }); }
}
const sockets = [], spawns = [], bumps = [];
const body = { ...lake.spawn, vx: 0, vy: 0, z: 0, pitch: 0, roll: 0 };
const client = createSocketClient({ url: 'wss://example.test/lake', socketFactory: () => { const s = new Socket(); sockets.push(s); return s; },
  clock: () => time, schedule, cancel, read: () => ({ boat: body, tube: body }),
  onSpawn: value => spawns.push(value), onCorrection: value => bumps.push(value) });
let frame = 0;
function reply(socket, { resumed = false, epoch = 'epoch-a', correction = null } = {}) {
  const request = socket.sent.at(-1);
  socket.message({ type: 'reply', action: request.action, requestSeq: request.seq, frame: ++frame, epoch, resumed,
    serverTime: time, self: { id: request.id, spawn: lake.spawn, name: 'Tester', correction }, players: [], wakeEvents: [], wakeCursor: 0 });
}
function snapshot(socket, correction = null) {
  const request = socket.sent.at(-1);
  socket.message({ type: 'snapshot', frame: ++frame, epoch: 'epoch-a', serverTime: time,
    self: { id: request.id, name: 'Tester', correction }, players: [], wakeEvents: [], wakeCursor: 0 });
}
client.setMap('open'); assert.equal(sockets.length, 0);
client.setMap('oswego'); const s1 = sockets.at(-1); s1.open(); reply(s1); assert.equal(client.ready, true); assert.equal(spawns.length, 1);
advance(1000); assert.ok(s1.sent.filter(m => m.action === 'sync').length >= 19, 'At least 19 movement updates in one second');
snapshot(s1, { seq: 9, dx: 1, dy: 0, dvx: 0, dvy: 0 }); assert.equal(bumps.length, 1);
s1.close(); advance(250); const s2 = sockets.at(-1); s2.open(); reply(s2, { resumed: true });
assert.equal(spawns.length, 1, 'A short reconnect does not teleport the boat to launch');
s1.emit('close'); assert.equal(client.ready, true, 'Late events from an old socket do not affect its replacement');
client.reset(); advance(50); assert.equal(s2.sent.at(-1).action, 'reset');
client.reset(); reply(s2, { resumed: true }); assert.equal(client.ready, false, 'An old reset reply does not release a newer reset');
advance(50); reply(s2, { resumed: true }); assert.equal(client.ready, true);
s2.close(); client.reset(); advance(250); const s3 = sockets.at(-1); s3.open(); reply(s3, { resumed: true });
assert.equal(client.ready, false, 'A reset requested during reconnect remains pending');
advance(50); assert.equal(s3.sent.at(-1).action, 'reset'); reply(s3, { resumed: true });
s3.close(); advance(250); const s4 = sockets.at(-1); s4.open(); reply(s4, { resumed: false });
snapshot(s4, { seq: 1, dx: 1, dy: 0, dvx: 0, dvy: 0 });
assert.equal(bumps.length, 2, 'A recreated reservation in the same room accepts correction sequence 1');
s4.close(); advance(250); const s5 = sockets.at(-1);
advance(3000); assert.equal(s5.readyState, 0, 'A new connection has its own handshake timeout');
s5.open(); const beforeEpoch = spawns.length; reply(s5, { epoch: 'epoch-b' }); assert.equal(spawns.length, beforeEpoch + 1);
client.setMap('open'); s5.emit('message', { data: '{}' }); advance(5000); assert.equal(client.ready, false); assert.equal(tasks.size, 0);

let configCalls = 0, finishConfig, unwantedSocket = 0;
const facade = createLakeClient({ read: () => ({ boat: body, tube: body }), socketFactory: () => { unwantedSocket++; return new Socket(); },
  fetcher: () => { configCalls++; return new Promise(resolve => { finishConfig = () => resolve(Response.json({ websocketUrl: 'wss://example.test/lake' })); }); } });
facade.setMap('open'); assert.equal(configCalls, 0);
facade.setMap('oswego'); facade.setMap('open'); finishConfig(); await new Promise(resolve => setImmediate(resolve));
assert.equal(unwantedSocket, 0, 'A delayed config response cannot reconnect after switching to solo');
console.log('Socket client passed: 20 Hz sends, no reconnect teleport, reset races, fresh correction counters, room restart and solo isolation.');

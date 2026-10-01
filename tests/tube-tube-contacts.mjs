import assert from 'node:assert/strict';
import { tubeTubeContactResponse } from '../multiplayer/tube-contacts.js';
import { applyRoomAction, resolveTubeContacts } from '../multiplayer/room.js';
import { stepBot } from '../multiplayer/bots.js';
import { SHARED_LAKE_RULES as rules } from '../simulation/defaults.js';
import { METERS_PER_UNIT as M } from '../maps/catalog.js';

const pose = (x = 0, y = 0, extra = {}) => ({
  x, y, vx: 0, vy: 0, z: 0, angle: 0, pitch: 0, roll: 0, riderOn: true, ...extra
});
const radius = rules.tubeRadius * 2;
const mass = body => body.riderOn === false ? rules.emptyTubeMass : rules.loadedTubeMass;
const close = (a, b, message, tolerance = 1e-6) =>
  assert.ok(Math.abs(a - b) <= tolerance, `${message}: ${a} vs ${b}`);
const corrected = (body, change) => ({
  ...body, x: body.x + change.dx, y: body.y + change.dy,
  vx: body.vx + change.dvx, vy: body.vy + change.dvy
});
function finite(change) {
  for (const key of ['dx', 'dy', 'dvx', 'dvy', 'normalX', 'normalY', 'impact'])
    assert.ok(Number.isFinite(change[key]), `${key} remains finite`);
}
function conserved(a, b, hit) {
  for (const axis of ['x', 'y']) {
    close(mass(a) * hit.a[`dv${axis}`] + mass(b) * hit.b[`dv${axis}`], 0,
      `The ${axis} impulse conserves total momentum`, 1e-5);
    close(mass(a) * hit.a[`d${axis}`] + mass(b) * hit.b[`d${axis}`], 0,
      `Depenetration preserves the ${axis} center of mass`, 1e-5);
  }
  const nextA = corrected(a, hit.a), nextB = corrected(b, hit.b);
  assert.ok(Math.hypot(nextA.x - nextB.x, nextA.y - nextB.y) >= radius - 1e-5,
    'Corrected tube circles do not overlap');
  const relative = (nextA.vx - nextB.vx) * hit.a.normalX
    + (nextA.vy - nextB.vy) * hit.a.normalY;
  assert.ok(relative >= -1e-7, 'Relative normal velocity separates the tubes');
  finite(hit.a); finite(hit.b);
}

const beforeA = pose(-radius / 2 - 30, 0, { vx: 50 });
const beforeB = pose(radius / 2 + 30, 0, { vx: -50 });
const a = pose(-radius / 2 + 1, 0, { vx: 50 });
const b = pose(radius / 2 - 1, 0, { vx: -50 });
const headOn = tubeTubeContactResponse(a, beforeA, b, beforeB);
assert.ok(headOn, 'Two moving tubes collide head on');
assert.ok(a.vx + headOn.a.dvx < 0 && b.vx + headOn.b.dvx > 0,
  'Equal tubes rebound from a head-on impact');
assert.ok(headOn.a.dx < 0 && headOn.b.dx > 0);
close(headOn.a.normalX, -headOn.b.normalX, 'Normals point in opposite directions');
assert.ok(headOn.a.impact > 0 && headOn.b.impact > 0);
conserved(a, b, headOn);

const emptyB = { ...b, riderOn: false };
const unequal = tubeTubeContactResponse(a, beforeA, emptyB, { ...beforeB, riderOn: false });
assert.ok(unequal);
assert.ok(Math.abs(unequal.b.dvx) > Math.abs(unequal.a.dvx),
  'An empty tube changes velocity more than a tube carrying its rider');
conserved(a, emptyB, unequal);

const still = pose();
const fastA = pose(radius * 2, 0, { vx: 200 });
const fastBefore = pose(-radius * 2, 0, { vx: 200 });
const crossed = tubeTubeContactResponse(fastA, fastBefore, still, still);
assert.ok(crossed, 'A complete crossing between network updates is detected');
assert.ok(fastA.x + crossed.a.dx < still.x + crossed.b.dx,
  'A fast crossing restores the original encounter order instead of passing through');
conserved(fastA, still, crossed);

const glancingA = pose(0, radius * .7, { vx: 60 });
const glance = tubeTubeContactResponse(glancingA, pose(-radius * 2, radius * .7, { vx: 60 }), still, still);
assert.ok(glance, 'A glancing tube collision is detected');
assert.ok(glance.a.dvy > 0 && glance.b.dvy < 0, 'Glancing contact deflects both tubes sideways');
conserved(glancingA, still, glance);

assert.equal(tubeTubeContactResponse(pose(radius + 2, 0), pose(radius + 3, 0), still, still), null,
  'Nearby separate tubes do not collide');
assert.equal(tubeTubeContactResponse(pose(radius * 2, 0, { vx: 30 }), pose(radius - 1, 0, { vx: 30 }), still, still), null,
  'A separating tube outside the circle is not rewound into another impact');
const zeroOverlap = tubeTubeContactResponse(still, still, still, still);
assert.ok(zeroOverlap, 'Coincident stationary centers are safely separated');
conserved(still, still, zeroOverlap);
close(zeroOverlap.a.dvx, 0, 'Stationary overlap adds no velocity');
close(zeroOverlap.b.dvx, 0, 'Stationary overlap adds no velocity');

const high = rules.tubeClearance * 3;
assert.equal(tubeTubeContactResponse({ ...a, z: high }, { ...beforeA, z: high }, b, beforeB), null,
  'A high airborne tube passes over a tube on the water');
assert.ok(tubeTubeContactResponse({ ...a, z: high }, { ...beforeA, z: high }, { ...b, z: high }, { ...beforeB, z: high }),
  'Two airborne tubes at the same height can still collide');
assert.ok(tubeTubeContactResponse(
  pose(-radius + 30, 0, { vx: 50, z: rules.tubeClearance * 2 }),
  pose(-radius - 10, 0, { vx: 50, z: 0 }), still, still
), 'The height gate samples contact time rather than only the final height');

const now = 100000;
function joinedRoom(botCount = 0) {
  const room = {};
  applyRoomAction(room, { id: 'tube-a', action: 'join', physicsVersion: rules.version, botCount }, 'hash-a', now);
  if (!botCount) applyRoomAction(room, { id: 'tube-b', action: 'join', physicsVersion: rules.version }, 'hash-b', now);
  for (const p of Object.values(room.players)) { p.graceUntil = 0; p.paused = false; p.poseAt = now; }
  return room;
}
function placePair(a, b) {
  a.boat = pose(-2720 / M, 720 / M);
  b.boat = pose(-2680 / M, 720 / M);
  b.tube = pose(-2700 / M, 720 / M);
  a.tube = pose(b.tube.x - radius - .5 / M, b.tube.y, { vx: 8 / M });
  return { ...a.tube, x: b.tube.x - radius + .15 / M };
}
function sync(room, p, token, seq, at, extra = {}) {
  return applyRoomAction(room, {
    id: p.id, action: 'sync', physicsVersion: rules.version, seq, ack: 0,
    boat: { ...p.boat }, tube: { ...p.tube }, paused: false, ...extra
  }, token, at);
}
{
  const room = joinedRoom(), a = room.players['tube-a'], b = room.players['tube-b'];
  const incoming = placePair(a, b), boatA = { ...a.boat }, boatB = { ...b.boat };
  const result = sync(room, a, 'hash-a', 1, now + 200, { tube: incoming });
  assert.ok(result.self.correction?.tube && b.correction?.tube,
    'Both human tube owners receive tube-only corrections');
  assert.deepEqual(a.boat, boatA, 'A tube/tube impact does not directly move the first boat');
  assert.deepEqual(b.boat, boatB, 'A tube/tube impact does not directly move the second boat');
  for (const owner of [a, b]) for (const key of ['dx', 'dy', 'dvx', 'dvy'])
    assert.equal(owner.correction[key], 0, 'A tube contact does not masquerade as a convoy correction');
  const fixed = { ...a.tube }, aSeq = a.correction.seq, bSeq = b.correction.seq;
  sync(room, a, 'hash-a', 2, now + 250, { tube: incoming });
  assert.deepEqual(a.tube, fixed, 'An unacknowledged old pose cannot undo the contact');
  assert.equal(a.correction.seq, aSeq); assert.equal(b.correction.seq, bSeq);
  sync(room, a, 'hash-a', 3, now + 300, { ack: aSeq });
  assert.equal(a.correction, null);
  assert.equal(b.correction.seq, bSeq, 'The second owner retains its event until its own acknowledgment');
  sync(room, b, 'hash-b', 1, now + 350, { ack: bSeq });
  assert.equal(b.correction, null);
}
{
  const room = joinedRoom(), a = room.players['tube-a'], b = room.players['tube-b'];
  let next = placePair(a, b), oldTube = { ...a.tube }; a.tube = next;
  resolveTubeContacts(room, a, { ...a.boat }, oldTube, now + 200);
  assert.ok(a.correction?.tube && b.correction?.tube);
  const seq = a.eventSeq;
  a.correction = b.correction = null;
  next = placePair(a, b); a.tube = next;
  resolveTubeContacts(room, b, { ...b.boat }, { ...b.tube }, now + 250);
  assert.ok(a.eventSeq > seq, 'Either owner can initiate a renewed impact after acknowledgment');
  const repeatedSeq=a.eventSeq;
  resolveTubeContacts(room, b, { ...b.boat }, { ...b.tube }, now + 1000);
  assert.equal(a.eventSeq,repeatedSeq,'Unacknowledged impacts are never multiplied');
}
{
  const room = joinedRoom(), a = room.players['tube-a'], b = room.players['tube-b'];
  const next = placePair(a, b), oldTube = { ...a.tube }; a.tube = next;
  b.graceUntil = now + 2000;
  resolveTubeContacts(room, a, { ...a.boat }, oldTube, now + 200);
  assert.equal(a.correction, null, 'Spawn grace protects either member of a tube pair');
  b.graceUntil = 0; b.correction = { seq: 9, dx: 0, dy: 0, dvx: 1, dvy: 0 };
  resolveTubeContacts(room, a, { ...a.boat }, oldTube, now + 300);
  assert.equal(a.correction, null, 'A new tube contact cannot overwrite an owner\'s pending hull event');
  assert.equal(b.correction.seq, 9);
}
{
  const room = joinedRoom(1), a = room.players['tube-a'], b = Object.values(room.players).find(p => p.isBot);
  a.boat = pose(-2720 / M, 720 / M); a.tube = pose(-2700 / M, 720 / M);
  b.boat = pose(-2680 / M, 720 / M);
  b.tube = pose(a.tube.x, a.tube.y + radius + .2 / M, { vy: -5 / M });
  b.tubeBounce = { vx: 0, vy: -5 / M };
  const boatA = { ...a.boat };
  sync(room, a, 'hash-a', 1, now + 100, { paused: true, botCount: 1 });
  assert.ok(a.correction?.tube && b.correction?.tube,
    'The real bot advancement path collides its tube with a human tube');
  assert.deepEqual(a.boat, boatA);
  assert.ok(a.tube.vy < 0 && b.tube.vy > -5 / M, 'Momentum is transferred to the human tube');
  assert.ok(b.tubeBounce && Number.isFinite(b.tubeBounce.vy), 'Bot collision momentum is retained for later steps');
}
{
  const room = joinedRoom(2), [a, b] = Object.values(room.players).filter(p => p.isBot);
  const next = placePair(a, b), oldTube = { ...a.tube }; a.tube = next;
  resolveTubeContacts(room, a, { ...a.boat }, oldTube, now + 200);
  assert.ok(a.correction?.tube && b.correction?.tube, 'Two bot tubes receive the same shared collision response');
  assert.ok(a.tubeBounce?.vx < 0 && b.tubeBounce?.vx > 0,
    'Both bots retain their opposite impulses');
  const bx = b.tube.x;
  stepBot(b, room.players, .1);
  assert.ok(b.tube.x > bx, 'A struck bot tube continues moving from the collision impulse');
}

console.log('Tube/tube contacts passed: moving sweeps, glancing and high-speed hits, masses and momentum, height clearance, symmetric corrections/acknowledgments, renewed impacts, grace and bots.');

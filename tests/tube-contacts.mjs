import assert from 'node:assert/strict';
import { sweptTubeHull, tubeContactResponse } from '../multiplayer/tube-contacts.js';
import { applyRoomAction, resolveTubeContacts } from '../multiplayer/room.js';
import { stepBot } from '../multiplayer/bots.js';
import { SHARED_LAKE_RULES as rules } from '../simulation/defaults.js';
import { METERS_PER_UNIT as M } from '../maps/catalog.js';

const pose = (x = 0, y = 0, extra = {}) => ({
  x, y, vx: 0, vy: 0, angle: 0, z: 0, pitch: 0, roll: 0, riderOn: true, ...extra
});
const close = (actual, expected, tolerance = 1e-6, message = 'Values should match') =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} vs ${expected}`);
const finite = value => {
  if (value && typeof value === 'object') for (const item of Object.values(value)) finite(item);
  else if (typeof value === 'number') assert.ok(Number.isFinite(value), 'Collision data stays finite');
};
const hull = pose();
const side = rules.beam / 2 + rules.tubeRadius;
const bow = rules.length / 2 + rules.tubeRadius;

// The side and rounded bow use the actual hull, not its much larger enclosing circle.
const sideBefore = pose(0, side + 40, { vy: -50 });
const sideAfter = pose(0, side - 5, { vy: -50 });
const sideHit = sweptTubeHull(sideAfter, sideBefore, hull, hull);
assert.ok(sideHit, 'A tube moving into the hull side makes contact');
close(sideHit.t, 40 / 45, 1e-4, 'The side sweep finds the first contact');
assert.ok(sideHit.ny > .99 && Math.abs(sideHit.nx) < .01);
assert.ok(sideHit.y >= side - 1e-5, 'The safe center clears the hull side');

const bowBefore = pose(bow + 40, 0, { vx: -50 });
const bowAfter = pose(bow - 5, 0, { vx: -50 });
const bowHit = sweptTubeHull(bowAfter, bowBefore, hull, hull);
assert.ok(bowHit, 'A tube moving into the rounded bow makes contact');
assert.ok(bowHit.nx > .99 && Math.abs(bowHit.ny) < .01);
assert.ok(bowHit.x >= bow - 1e-5);
assert.equal(sweptTubeHull(pose(0, side + 4), pose(0, side + 8), hull, hull), null,
  'A nearby tube outside the beam does not collide');
const centerOverlap = sweptTubeHull(pose(1, 0, { vx: 10 }), pose(0, 0, { vx: 10 }), hull, hull);
assert.ok(centerOverlap, 'An initial center-axis overlap is resolved');
const axisHalf = (rules.length - rules.beam) / 2;
const axisX = Math.max(-axisHalf, Math.min(axisHalf, centerOverlap.x));
assert.ok(Math.hypot(centerOverlap.x - axisX, centerOverlap.y) >= side - 1e-5,
  'The zero-distance fallback puts the tube outside the entire capsule, not elsewhere along its center axis');

const crossingBefore = pose(0, side + 40, { vy: -100 });
const crossingAfter = pose(0, -side - 40, { vy: -100 });
const crossing = tubeContactResponse(crossingAfter, crossingBefore, hull, hull);
assert.ok(crossing, 'A complete hull crossing between packets is detected');
assert.ok(crossing.tube.dvy > 0, 'The crossing bounces off the entry side');
assert.ok(crossingAfter.y + crossing.tube.dy >= side - 1e-5,
  'A fast tube is put back on the entry side, not teleported through the hull');

const movingBefore = pose(-rules.length, 0, { vx: 90 });
const movingAfter = pose(rules.length, 0, { vx: 90 });
const stationaryTube = pose();
const movingImpact = tubeContactResponse(stationaryTube, stationaryTube, movingAfter, movingBefore);
assert.ok(movingImpact, 'A moving boat sweeps into a stationary tube');
assert.ok(movingImpact.tube.dvx > 0 && movingImpact.boat.dvx < 0);
assert.ok(stationaryTube.x + movingImpact.tube.dx > movingAfter.x,
  'The corrected tube is outside the current boat transform');

const airborne = rules.tubeClearance * 2;
assert.equal(sweptTubeHull(
  { ...crossingAfter, z: airborne }, { ...crossingBefore, z: airborne }, hull, hull
), null, 'An airborne tube passes over a hull when vertical clearance is sufficient');
const liftingBefore = pose(0, side + 10, { z: 0 });
const liftingAfter = pose(0, side - 30, { z: rules.tubeClearance * 2 });
assert.ok(sweptTubeHull(liftingAfter, liftingBefore, hull, hull),
  'Vertical clearance is sampled at impact, before a departing tube rises above the hull');

const response = tubeContactResponse(sideAfter, sideBefore, hull, hull);
assert.ok(response.tube.dvy > 0 && response.boat.dvy < 0);
assert.ok(response.tube.dvy > Math.abs(response.boat.dvy) * 10,
  'The light tube responds much more than the heavy boat');
close(rules.loadedTubeMass * response.tube.dvy + rules.boatMass * response.boat.dvy, 0, 1e-5,
  'The normal impulse is equal and opposite');
assert.ok(sideAfter.vy + response.tube.dvy - response.boat.dvy > 0,
  'Relative normal velocity points away after the impact');
assert.ok(response.tube.impact > 0 && response.tube.normalY > .99);
finite(response); finite(crossing); finite(movingImpact);

const glancingBefore=pose(-1/M,side+.1/M,{vx:10/M,vy:-1/M});
const glancingAfter=pose(1/M,side-.1/M,{vx:10/M,vy:-1/M});
const glancing=tubeContactResponse(glancingAfter,glancingBefore,hull,hull);
assert.ok(glancing);
close(glancing.tube.dx,0,1e-6,'A glancing impact keeps the tube\'s travel along the hull');
close(glancing.tube.dvx,0,1e-6,'A glancing impact preserves tangent velocity');
assert.ok(glancingAfter.y+glancing.tube.dy>=side,'The glancing tube still clears the side');

const turningBefore=pose(0,0,{angle:-.1}),turningAfter=pose(0,0,{angle:.1});
const nearBow=pose(bow-.01/M,0);
assert.equal(sweptTubeHull(nearBow,nearBow,turningBefore,turningBefore),null,'Rotating bow starts clear');
assert.equal(sweptTubeHull(nearBow,nearBow,turningAfter,turningAfter),null,'Rotating bow ends clear');
const turningHit=tubeContactResponse(nearBow,nearBow,turningAfter,turningBefore);
assert.ok(turningHit,'A turning bow cannot sweep through a stationary tube between packets');
assert.ok(Math.hypot(turningHit.tube.dx,turningHit.tube.dy)>0,'Rotation contact separates the tube');
finite(turningHit);

const startTime = 100000;
function joinedRoom(botCount = 0) {
  const room = {};
  applyRoomAction(room, { id: 'tube-owner', action: 'join', physicsVersion: rules.version, botCount }, 'tube-hash', startTime);
  if (!botCount) applyRoomAction(room, { id: 'hull-owner', action: 'join', physicsVersion: rules.version }, 'hull-hash', startTime);
  const a = room.players['tube-owner'];
  const b = Object.values(room.players).find(p => p.id !== a.id);
  for (const p of [a, b]) { p.graceUntil = 0; p.paused = false; p.poseAt = startTime; }
  return { room, a, b };
}
function placeSideContact(a, b) {
  b.boat = pose(-2700 / M, 720 / M);
  b.tube = pose(-2700 / M, 744 / M);
  a.boat = pose(-2722 / M, 720 / M);
  a.tube = pose(b.boat.x, b.boat.y + side + 1 / M, { vy: -8 / M });
  return { ...a.tube, y: b.boat.y + side - .5 / M };
}
function sync(room, p, hash, seq, now, extra = {}) {
  return applyRoomAction(room, {
    id: p.id, action: 'sync', physicsVersion: rules.version, seq, ack: 0,
    boat: { ...p.boat }, tube: { ...p.tube }, paused: false, ...extra
  }, hash, now);
}

// The human update path must preserve the towing boat and deliver the new
// tube-specific payload using the same reliable correction acknowledgment.
{
  const { room, a, b } = joinedRoom();
  const incomingTube = placeSideContact(a, b);
  const ownBoat = { ...a.boat };
  const result = sync(room, a, 'tube-hash', 1, startTime + 200, { tube: incomingTube });
  assert.ok(result.self.correction?.tube, 'A tube update is resolved against another boat');
  assert.deepEqual(a.boat, ownBoat, 'The tube correction does not move or accelerate its towing boat');
  for (const key of ['dx', 'dy', 'dvx', 'dvy']) assert.equal(a.correction[key], 0,
    'Legacy convoy fields are zero for a tube-only impact');
  assert.ok(b.correction, 'The struck boat receives its smaller opposite impulse');
  const correctedTube = { ...a.tube }, serial = a.correction.seq;
  sync(room, a, 'tube-hash', 2, startTime + 250, { tube: incomingTube });
  assert.deepEqual(a.tube, correctedTube, 'An old unacknowledged pose cannot undo a tube collision');
  assert.equal(a.correction.seq, serial, 'Repeated requests do not multiply the collision impulse');
  sync(room, a, 'tube-hash', 3, startTime + 300, { ack: serial });
  assert.equal(a.correction, null, 'The tube correction clears after acknowledgment');
}

// Updating the hull owner must also find the stationary remote tube. The
// towing boat sits clear of the moving hull, so a boat/boat contact cannot pass this test.
{
  const { room, a, b } = joinedRoom();
  a.boat = pose(-2722 / M, 720 / M);
  a.tube = pose(-2700 / M, 720 / M);
  b.boat = pose(-2710 / M, 720 / M, { vx: 40 / M });
  b.tube = pose(-2699 / M, 744 / M);
  const ownBoat = { ...a.boat };
  sync(room, b, 'hull-hash', 1, startTime + 200, { boat: { ...b.boat, x: -2699 / M } });
  assert.ok(a.correction?.tube, 'A hull update collides with another player\'s tube');
  assert.ok(a.correction.tube.dvx > 0 && b.correction.dvx < 0);
  assert.deepEqual(a.boat, ownBoat);
}

{
  const { room, a, b } = joinedRoom();
  let nextTube = placeSideContact(a, b);
  let previousTube = { ...a.tube };
  a.tube = nextTube;
  resolveTubeContacts(room, a, { ...a.boat }, previousTube, startTime + 200);
  assert.ok(a.correction?.tube);
  const serial = a.eventSeq;
  a.correction = b.correction = null;
  nextTube = placeSideContact(a, b); previousTube = { ...a.tube }; a.tube = nextTube;
  resolveTubeContacts(room, a, { ...a.boat }, previousTube, startTime + 250);
  assert.ok(a.eventSeq > serial, 'An acknowledged pair can respond to a renewed impact within 400 ms');
  const repeatedSerial=a.eventSeq;
  resolveTubeContacts(room, a, { ...a.boat }, previousTube, startTime + 1000);
  assert.equal(a.eventSeq,repeatedSerial,'A pending correction cannot be applied twice');
}

{
  const { room, a, b } = joinedRoom();
  const nextTube = placeSideContact(a, b), previousTube = { ...a.tube };
  a.tube = nextTube; a.graceUntil = startTime + 2000;
  resolveTubeContacts(room, a, { ...a.boat }, previousTube, startTime + 200);
  assert.equal(a.correction, null, 'Spawn grace also protects a tube/hull pair');
  delete room.players[b.id]; a.graceUntil = 0;
  a.tube = { ...a.boat };
  resolveTubeContacts(room, a, { ...a.boat }, { ...a.tube }, startTime + 300);
  assert.equal(a.correction, null, 'The server never double-resolves a player\'s own boat and tube');
}

// A bot has to retain actual tube momentum. Position-only towing silently
// erases the rebound on the next server step.
{
  const { room, b } = joinedRoom(1);
  b.boat = pose(-2700 / M, 720 / M);
  b.tube = pose(-2718 / M, 720 / M, { vy: 2 / M });
  b.tubeBounce = { vx: 0, vy: 2 / M };
  const y = b.tube.y;
  stepBot(b, room.players, .1);
  assert.ok(b.tube.y > y, 'A bot tube carries its lateral collision velocity into the next step');
  assert.ok(b.tube.vy > 0, 'Bot towing does not erase the complete rebound');
}

// Exercise the room's real bot advancement call, not just the exported helper.
{
  const { room, a, b } = joinedRoom(1);
  a.boat = pose(-2700 / M, 720 / M);
  a.tube = pose(-2722 / M, 720 / M);
  b.boat = pose(a.boat.x + 20 / M, a.boat.y + side + .2 / M);
  b.tube = pose(a.boat.x, a.boat.y + side + .2 / M, { vy: -5 / M });
  b.tubeBounce = { vx: 0, vy: -5 / M };
  sync(room, a, 'tube-hash', 1, startTime + 100, { paused: true, botCount: 1 });
  assert.ok(a.correction, 'Advancing a bot detects its tube hitting a human boat');
  assert.ok(a.boat.vy < 0, 'The human boat receives the bot tube\'s impact');
  assert.ok(b.tube.y >= a.boat.y + side - 1 / M, 'The bot tube is pushed clear of the hull');
  const reboundY = b.tube.y;
  sync(room, a, 'tube-hash', 2, startTime + 200, { ack: a.correction.seq, paused: true, botCount: 1 });
  assert.ok(b.tube.y > reboundY, 'The actual bot impact continues rebounding on the following server step');
  finite(b.tube);
}

console.log('Shared tube contacts passed: swept hull geometry, airborne clearance, impulses, both update directions, acknowledgments, renewed impacts, spawn grace and bot rebounds.');

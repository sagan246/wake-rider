import assert from 'node:assert/strict';
import { startBoatBump, stepBoatBump } from '../physics/boat-bump.js';
import { updateBoatPlanar } from '../physics/boat.js';
import { createBoatState } from '../physics/state.js';
import { createSimulator } from '../simulation/simulator.js';
import { SHARED_LAKE_RULES as rules } from '../simulation/defaults.js';
import { BOT_PADS, stepBot } from '../multiplayer/bots.js';
import { METERS_PER_UNIT as M } from '../maps/catalog.js';

const dt = 1 / 120;
const neutral = { throttle: 0, steer: 0, maxSpeedMph: 45, dt };
const ordinary = { ...createBoatState(), angle: 0, vy: 3 / M };
const gliding = { ...ordinary };
startBoatBump(gliding, 0, 3 / M);
assert.equal(gliding.vy, ordinary.vy, 'Glide does not amplify the incoming impulse');
let energy = gliding.vx ** 2 + gliding.vy ** 2;
for (let i = 0; i < 240; i++) {
  updateBoatPlanar(ordinary, neutral);
  updateBoatPlanar(gliding, neutral);
  const nextEnergy = gliding.vx ** 2 + gliding.vy ** 2;
  assert.ok(nextEnergy <= energy + 1e-8, 'Unpowered glide continues dissipating energy');
  energy = nextEnergy;
}
assert.ok(gliding.y > ordinary.y * 1.8, 'The same sideways shove carries substantially farther');
const coastMeters = { before: ordinary.y * M, after: gliding.y * M };
for (let i = 0; i < 120; i++) updateBoatPlanar(gliding, neutral);
assert.equal(gliding.bumpGlideTime, 0, 'Normal hull resistance fully returns');
const recovered = { ...gliding, bumpGlideTime: 0 };
updateBoatPlanar(recovered, neutral);
updateBoatPlanar(gliding, neutral);
assert.deepEqual(gliding, recovered, 'An expired glide has exactly ordinary handling');

const backwards = { ...createBoatState(), angle: 0, vx: -5 / M };
startBoatBump(backwards, -5 / M, 0);
updateBoatPlanar(backwards, neutral);
assert.ok(backwards.vx > -5 / M, 'Water drag reduces backward collision motion');
assert.ok(backwards.vx < -4.9 / M, 'Reverse propulsion limit does not abruptly erase a backward shove');
for (let i = 0; i < 1200; i++) updateBoatPlanar(backwards, neutral);
assert.equal(backwards.bumpReverseCoast, false, 'Backward impact recovery ends after slowing naturally');
const heldReverse = { ...createBoatState(), angle: 0, vx: -5 / M };
startBoatBump(heldReverse, -5 / M, 0);
for (let i = 0; i < 1200; i++) updateBoatPlanar(heldReverse, { ...neutral, throttle: -.48 });
assert.ok(heldReverse.vx >= -32 - 1e-8, 'Holding reverse cannot sustain collision overspeed');
assert.equal(heldReverse.bumpReverseCoast, false, 'Powered reverse also returns to normal handling');
const powered = { ...createBoatState(), angle: 0, vx: -31.99 };
for (let i = 0; i < 120; i++) updateBoatPlanar(powered, { ...neutral, throttle: -.48 });
assert.ok(powered.vx >= -32 - 1e-8, 'Powered reverse still respects its speed limit');

const duration = gliding.bumpGlideTime;
startBoatBump(gliding, 0, 0);
assert.equal(gliding.bumpGlideTime, duration, 'Stationary separation cannot start a glide');
startBoatBump(gliding, 0, 3 / M);
const maximum = gliding.bumpGlideTime;
for (let i = 0; i < 50; i++) startBoatBump(gliding, (i % 2 ? -1 : 1) * 30 / M, 0);
assert.equal(gliding.bumpGlideTime, maximum, 'Repeated and opposite impacts cannot stack unbounded carry');
assert.ok(stepBoatBump(gliding, dt) > 0, 'Some resistance always remains');

// Exercise the actual client correction and complete tow simulation, not just
// the damping helper. Both cases start with precisely the same velocity change.
const rider = { mass: 130, grip: 75, color: '#78aef0' };
const correction = { dx: 0, dy: 0, dvx: 0, dvy: 3 / M };
const sims = [createSimulator(), createSimulator()];
for (const [i, sim] of sims.entries()) {
  sim.reset({ x: 0, y: 0, angle: 0 });
  sim.applyNetworkCorrection({ ...correction, boatBump: !!i });
  for (let frame = 0; frame < 240; frame++) sim.step({ dt, throttle: { forward: 0, reverse: 0 },
    steer: 0, maxSpeedMph: 45, cruiseEnabled: false, cruiseSpeedMph: 20, rider });
}
assert.ok(sims[1].getState().boat.y > sims[0].getState().boat.y * 1.5,
  'The correction retains its longer carry through real rope and water physics');
sims[1].reset();
assert.equal(sims[1].getState().boat.bumpGlideTime, 0, 'Reset clears collision recovery');
sims[1].applyNetworkCorrection({ ...correction, dvy: 0, tube: { dx: 0, dy: 0, dvx: 0, dvy: 20 } });
assert.equal(sims[1].getState().boat.bumpGlideTime, 0, 'Tube-only corrections leave boat resistance alone');

// A bot must carry the same shove instead of immediately steering it away.
function bot() {
  const pad = BOT_PADS[2], boat = { ...createBoatState(), ...pad,
    vx: Math.cos(pad.angle) * 9.15 / M, vy: Math.sin(pad.angle) * 9.15 / M };
  const reach = rules.ropeLength + rules.length * .55;
  return { id: 'test-bot', botSlot: 1, waypoint: pad.waypoint, length: rules.length,
    beam: rules.beam, ropeLength: rules.ropeLength, boat,
    tube: { ...boat, x: boat.x - Math.cos(boat.angle) * reach,
      y: boat.y - Math.sin(boat.angle) * reach, riderOn: true } };
}
const baseline = bot(), normalBot = bot(), glideBot = bot();
const bumpX = -Math.sin(baseline.boat.angle) * 3 / M;
const bumpY = Math.cos(baseline.boat.angle) * 3 / M;
for (const p of [normalBot, glideBot]) { p.boat.vx += bumpX; p.boat.vy += bumpY; }
startBoatBump(glideBot.boat, bumpX, bumpY);
for (let i = 0; i < 20; i++) for (const p of [baseline, normalBot, glideBot]) stepBot(p, { [p.id]: p }, .1);
const offset = p => Math.hypot(p.boat.x - baseline.boat.x, p.boat.y - baseline.boat.y) * M;
assert.ok(offset(glideBot) > offset(normalBot) * 1.4, 'Bot autopilot lets a shove travel farther');
for (let i = 0; i < 10; i++) stepBot(glideBot, { [glideBot.id]: glideBot }, .1);
assert.equal(glideBot.boat.bumpGlideTime, 0, 'Bot cruising response returns after the glide');
console.log(`Boat bump carry passed: 3 m/s side shove travels ${coastMeters.after.toFixed(2)} m vs ${coastMeters.before.toFixed(2)} m in 2 s; dissipative coast, reset, reverse, tow and bot recovery.`);

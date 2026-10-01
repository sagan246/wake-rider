import assert from 'node:assert/strict';

import {
  CONFIG,
  FEET_PER_UNIT,
  LAB_MAX_MPH,
  MPH_PER_UNIT,
  STANDARD_GRAVITY,
  STANDARD_GRAVITY_FT_PER_SECOND_SQUARED,
  STANDARD_MAX_MPH,
  UNITS_PER_FOOT
} from '../physics/config.js';
import { clamp, len, normAngle } from '../physics/math.js';
import { createRope } from '../physics/rope.js';
import { emitWake, sampleWater, updateWakes } from '../physics/wake.js';
import { boatHeadingDegrees, towPoint, updateBoatPlanar, updateBoatWaterResponse } from '../physics/boat.js';
import { properAccelerationG, ropeTensionForState, tubeCenterBehindBoat, tubeTowPoint, updateTowSystem } from '../physics/tow.js';
import { createFallenRider, updateFallenRider, updateRiderGripState } from '../physics/rider.js';
import { applyBoatProfile, applyBoatTowAttachment, BOAT_PROFILES, DEFAULT_BOAT_ID } from '../physics/boats.js';
import { advanceReplay, createReplay } from '../replay.js';
import { createCruiseState, updateCruiseThrottle } from '../physics/cruise.js';
import { boatTubeSeparation, resolveBoatTubeCollision } from '../physics/collision.js';
import { createBoatState, createTubeState } from '../physics/state.js';

const DEFAULT_TUBE_FRICTION = .8;

function makeBoat() {
  return createBoatState();
}

function makeTube(boat, angle = boat.angle) {
  const center = tubeCenterBehindBoat(boat, angle);
  return createTubeState(center, angle);
}

function allNumbersFinite(body, message) {
  for (const value of Object.values(body).filter(value => typeof value === 'number')) {
    assert.ok(Number.isFinite(value), message);
  }
}

function segmentDistanceFromTube(a, b, tube) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = (b.z || 0) - (a.z || 0);
  const lengthSquared = dx * dx + dy * dy + dz * dz || 1;
  const t = Math.max(0, Math.min(1, (
    (tube.x - a.x) * dx
    + (tube.y - a.y) * dy
    + (tube.z - (a.z || 0)) * dz
  ) / lengthSquared));
  return Math.hypot(
    a.x + dx * t - tube.x,
    a.y + dy * t - tube.y,
    (a.z || 0) + dz * t - tube.z
  );
}

function simulateBoat(maxSpeedMph, steer = 0, seconds = 30, dt = 1 / 120) {
  const boat = makeBoat();
  for (let time = 0; time < seconds; time += dt) {
    updateBoatPlanar(boat, { throttle: 1, steer, maxSpeedMph, dt });
  }
  return boat;
}

function runCruise(boat, cruiseState, seconds, targetSpeedMph = 20, maxSpeedMph = 45, driverThrottle = 1) {
  let highestCommand = 0;
  for (let time = 0; time < seconds; time += 1 / 120) {
    const throttle = updateCruiseThrottle(cruiseState, {
      enabled: true,
      targetSpeedMph,
      currentSpeedMph: Math.max(0, boat.speed) * MPH_PER_UNIT,
      driverThrottle,
      maxSpeedMph,
      dt: 1 / 120
    });
    highestCommand = Math.max(highestCommand, throttle);
    updateBoatPlanar(boat, { throttle, steer: 0, maxSpeedMph, dt: 1 / 120 });
  }
  return highestCommand;
}

const cruiseBoat = makeBoat();
const cruiseState = createCruiseState();
runCruise(cruiseBoat, cruiseState, 35);
assert.ok(
  Math.abs(cruiseBoat.speed * MPH_PER_UNIT - 20) < .45,
  `Cruise should settle near its 20 mph set speed (${(cruiseBoat.speed * MPH_PER_UNIT).toFixed(2)} mph)`
);
cruiseBoat.vx *= .65;
cruiseBoat.vy *= .65;
cruiseBoat.speed *= .65;
const recoveryCommand = runCruise(cruiseBoat, cruiseState, 1.5);
assert.ok(recoveryCommand > .35, 'Cruise should add power after a turn or tow load pulls speed down');
runCruise(cruiseBoat, cruiseState, 8);
assert.ok(cruiseBoat.speed * MPH_PER_UNIT > 19, 'Cruise should recover close to its set speed after a disturbance');
const idleCruiseState = createCruiseState();
assert.equal(
  updateCruiseThrottle(idleCruiseState, { enabled: true, targetSpeedMph: 20, currentSpeedMph: 0, driverThrottle: 0, maxSpeedMph: 45, dt: 1 / 120 }),
  0,
  'Cruise should not accelerate when the driver leaves the throttle at neutral'
);
assert.equal(
  updateCruiseThrottle(idleCruiseState, { enabled: false, targetSpeedMph: 20, currentSpeedMph: 12, driverThrottle: .63, maxSpeedMph: 45, dt: 1 / 120 }),
  .63,
  'Disabled cruise should preserve direct throttle control'
);

function turnRadiusFeet(boat) {
  return len(boat.vx, boat.vy) / Math.max(Math.abs(boat.yawRate), 1e-9) * FEET_PER_UNIT;
}

function simulateHardTurnEntry(maxSpeedMph, turnSeconds = 2, dt = 1 / 120) {
  const boat = simulateBoat(maxSpeedMph, 0, 35, dt);
  for (let time = 0; time < turnSeconds; time += dt) {
    updateBoatPlanar(boat, { throttle: 1, steer: 1, maxSpeedMph, dt });
  }
  return boat;
}

function simulateConnected(
  dt,
  seconds = 28,
  maxSpeedMph = STANDARD_MAX_MPH,
  steerAmplitude = .92,
  straightSeconds = 7,
  throttleForStep = null,
  riderGrip = 75
) {
  const boat = makeBoat();
  const tube = makeTube(boat);
  const rider = { mass: 170, grip: riderGrip };
  const wakes = [];
  const ropeChain = createRope(towPoint(boat), tubeTowPoint(tube));
  let nextWake = .1;
  let maxTubeMph = 0;
  let maxTension = 0;
  let maxExtension = 0;
  let minimumClearance = Infinity;
  let minimumTowEyeClearance = Infinity;

  for (let time = 0; time < seconds; time += dt) {
    const steer = time < straightSeconds ? 0 : Math.sin((time - straightSeconds) * .72) * steerAmplitude;
    const throttle = throttleForStep ? throttleForStep({ boat, time, dt, maxSpeedMph }) : 1;
    updateBoatPlanar(boat, { throttle, steer, maxSpeedMph, dt });
    if (time + dt >= nextWake) {
      emitWake(wakes, boat);
      nextWake += .1;
    }
    updateWakes(wakes, dt);
    updateBoatWaterResponse(boat, (x, y) => sampleWater(wakes, x, y), dt);
    const result = updateTowSystem({ boat, tube, ropeChain, rider, wakes, dt });
    maxTubeMph = Math.max(maxTubeMph, result.planarSpeed * MPH_PER_UNIT);
    maxTension = Math.max(maxTension, tube.tension);
    const boatTow = towPoint(boat);
    const tubeEye = tubeTowPoint(tube);
    minimumTowEyeClearance = Math.min(minimumTowEyeClearance, Math.hypot(
      tubeEye.x - tube.x,
      tubeEye.y - tube.y,
      tubeEye.z - tube.z
    ));
    maxExtension = Math.max(maxExtension, Math.hypot(
      boatTow.x - tubeEye.x,
      boatTow.y - tubeEye.y,
      boatTow.z - tubeEye.z
    ) - CONFIG.ropeLength);
    for (let index = 0; index < ropeChain.length - 1; index++) {
      minimumClearance = Math.min(
        minimumClearance,
        segmentDistanceFromTube(ropeChain[index], ropeChain[index + 1], tube)
      );
    }
  }

  return {
    boat,
    tube,
    wakes,
    ropeChain,
    finalBoatMph: boat.speed * MPH_PER_UNIT,
    finalTubeMph: len(tube.vx, tube.vy) * MPH_PER_UNIT,
    maxTubeMph,
    maxTension,
    maxExtension,
    minimumClearance,
    minimumTowEyeClearance
  };
}

const towCruiseState = createCruiseState();
const towCruiseRun = simulateConnected(1 / 120, 40, 45, 0, 0, ({ boat, dt, maxSpeedMph }) => updateCruiseThrottle(towCruiseState, {
  enabled: true,
  targetSpeedMph: 20,
  currentSpeedMph: Math.max(0, boat.speed) * MPH_PER_UNIT,
  driverThrottle: 1,
  maxSpeedMph,
  dt
}));
assert.ok(
  Math.abs(towCruiseRun.finalBoatMph - 20) < .8,
  `Cruise should hold close to 20 mph while towing (${towCruiseRun.finalBoatMph.toFixed(2)} mph)`
);

// The horizontal, vertical, geometry, and speed conversions share one world
// scale. These checks prevent visually convenient constants from drifting back
// into otherwise physical equations.
assert.ok(Math.abs(CONFIG.gravity * FEET_PER_UNIT - 32.174) < 1e-9, 'Gravity should be 32.174 ft/s²');
assert.equal(STANDARD_GRAVITY_FT_PER_SECOND_SQUARED, 32.174, 'Earth gravity should have one canonical value');
assert.equal(CONFIG.gravity, STANDARD_GRAVITY, 'The simulator should default to Earth gravity');
assert.ok(properAccelerationG(0, 0, -CONFIG.gravity) < 1e-9, 'A freely falling tube should read approximately 0 g');
assert.ok(Math.abs(properAccelerationG(0, 0, 0) - 1) < 1e-9, 'A supported stationary tube should read 1 g');
assert.ok(Math.abs(properAccelerationG(0, 0, CONFIG.gravity) - 2) < 1e-9, 'One-g upward acceleration should read 2 g');
const gravityProbeBoat = makeBoat();
gravityProbeBoat.speed = 100;
const earthGravityWakes = [];
emitWake(earthGravityWakes, gravityProbeBoat);
const earthGroupSpeed = earthGravityWakes[0].groupSpeed;
CONFIG.gravity = STANDARD_GRAVITY * .25;
const reducedGravityWakes = [];
emitWake(reducedGravityWakes, gravityProbeBoat);
assert.ok(
  Math.abs(reducedGravityWakes[0].groupSpeed / earthGroupSpeed - .5) < 1e-9,
  'Gravity-wave group speed should scale with the square root of gravity'
);
CONFIG.gravity = STANDARD_GRAVITY;
assert.ok(Math.abs(CONFIG.ropeLength * FEET_PER_UNIT - 60) < 1e-9, 'Tow rope should be 60 ft');
assert.ok(Math.abs(CONFIG.tubeRadius * FEET_PER_UNIT - 2.5) < 1e-9, 'Tube should have a 5 ft circular diameter');
assert.equal(CONFIG.tubeWaterFriction, DEFAULT_TUBE_FRICTION, 'Tube water friction should default to 80%');
assert.ok(Math.abs(CONFIG.boatLength * UNITS_PER_FOOT * FEET_PER_UNIT - 21.75) < 1e-9, 'Wake Boat 22 length should be 21.75 ft');
assert.equal(CONFIG.tubeHalfLength, CONFIG.tubeHalfWidth, 'Tube contacts must remain circular');

const initialTowBoat = makeBoat();
const initialTowTube = makeTube(initialTowBoat);
const initialBoatTowPoint = towPoint(initialTowBoat);
const initialTubeTowPoint = tubeTowPoint(initialTowTube);
assert.ok(initialBoatTowPoint.z > initialTubeTowPoint.z, 'The boat tow point should begin above the tube tow eye');
assert.ok(
  Math.abs(Math.hypot(
    initialBoatTowPoint.x - initialTubeTowPoint.x,
    initialBoatTowPoint.y - initialTubeTowPoint.y,
    initialBoatTowPoint.z - initialTubeTowPoint.z
  ) - CONFIG.ropeLength) < 1e-7,
  'Initial tube placement should use the full three-dimensional rope length'
);
const initialRope = createRope(initialBoatTowPoint, initialTubeTowPoint);
const ropeSegmentLength = CONFIG.ropeLength / (CONFIG.ropeNodes - 1);
for (let index = 0; index < initialRope.length - 1; index++) {
  const a = initialRope[index], b = initialRope[index + 1];
  assert.ok(
    Math.abs(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) - ropeSegmentLength) < 1e-8,
    'Initial rope nodes should divide the full 3D rope length evenly'
  );
}
const rigidEyeDistance = Math.hypot(CONFIG.tubeTowOffset, CONFIG.tubeTowEyeHeightFt * UNITS_PER_FOOT);
for (const pitch of [-.5, 0, .5]) {
  const pitchedTube = {...initialTowTube, pitch};
  const eye = tubeTowPoint(pitchedTube);
  assert.ok(
    Math.abs(Math.hypot(eye.x - pitchedTube.x, eye.y - pitchedTube.y, eye.z - pitchedTube.z) - rigidEyeDistance) < 1e-8,
    'Tube tow eye should remain rigidly on the pitched tube rim'
  );
}
const pitchedTowBoat = {...makeBoat(), z: 1.7, pitch: .18};
const pitchedBoatTowPoint = towPoint(pitchedTowBoat);
const towOffset = CONFIG.boatLength * UNITS_PER_FOOT * CONFIG.boatTowPointRatio;
assert.ok(
  Math.abs(Math.hypot(
    pitchedBoatTowPoint.x - pitchedTowBoat.x,
    pitchedBoatTowPoint.y - pitchedTowBoat.y,
    pitchedBoatTowPoint.baseZ - pitchedTowBoat.z
  ) - towOffset) < 1e-8,
  'A pitched tow point should stay rigidly attached to its hull position'
);
assert.ok(
  Math.abs(pitchedBoatTowPoint.z - pitchedBoatTowPoint.baseZ - CONFIG.boatTowPointHeightFt * UNITS_PER_FOOT) < 1e-8,
  'Tow hardware should retain a fixed height above its pitched deck attachment'
);

for (const selectedMaximum of [12, STANDARD_MAX_MPH, 57, LAB_MAX_MPH]) {
  const boat = simulateBoat(selectedMaximum);
  const speed = boat.speed * MPH_PER_UNIT;
  assert.ok(speed > selectedMaximum * .97, `Boat should approach the selected ${selectedMaximum} mph maximum`);
  assert.ok(speed <= selectedMaximum + .05, `Boat should not exceed the selected ${selectedMaximum} mph maximum`);
}

const tubingTurnBoat = simulateBoat(20, 1);
assert.ok(tubingTurnBoat.yawRate > .55, 'Wake Boat 22 should retain hairpin authority at tubing speed');
assert.ok(tubingTurnBoat.speed * MPH_PER_UNIT > 10, 'A tubing-speed hairpin should keep moving while scrubbing hard');
assert.ok(turnRadiusFeet(tubingTurnBoat) < 38, 'Tubing-speed hard-over radius should remain a tight wake-boat hairpin');
assert.ok(turnRadiusFeet(tubingTurnBoat) > 22, 'Hairpin radius should remain physically larger than the hull');
assert.ok(Math.abs(tubingTurnBoat.lateralSpeed) > 10, 'A turn should create physical hull sideslip');

const fastTurnBoat = simulateBoat(40, 1);
assert.ok(fastTurnBoat.yawRate > .75, 'Inboard should settle into a tight pivot after a high-speed entry');
assert.ok(turnRadiusFeet(fastTurnBoat) < 38, 'Settled high-speed hard-over maneuver should become a hairpin');
assert.ok(fastTurnBoat.speed * MPH_PER_UNIT > 14, 'A hairpin should not stall the hull');
assert.ok(fastTurnBoat.speed * MPH_PER_UNIT < 25, 'A sustained hairpin should transition out of full planing speed');

const fastTurnEntryBoat = simulateHardTurnEntry(40);
assert.ok(turnRadiusFeet(fastTurnEntryBoat) < 40, 'A 40 mph hard-over entry should pivot sharply within two seconds');
assert.ok(len(fastTurnEntryBoat.vx, fastTurnEntryBoat.vy) * MPH_PER_UNIT > 29, 'High-speed entry should retain at least about three quarters of its speed after two seconds');
assert.ok(Math.abs(fastTurnEntryBoat.turnRollTarget) > .12, 'A high-speed hairpin should command visible inward hull roll');

CONFIG.hairpinStrength = .5;
const mildHairpinBoat = simulateHardTurnEntry(30);
CONFIG.hairpinStrength = 1.5;
const aggressiveHairpinBoat = simulateHardTurnEntry(30);
CONFIG.hairpinStrength = 1;
assert.ok(
  turnRadiusFeet(aggressiveHairpinBoat) < turnRadiusFeet(mildHairpinBoat) - 5,
  'Physics Lab hairpin strength should materially adjust hard-over turn radius'
);

const coastDownBoat = simulateBoat(LAB_MAX_MPH);
updateBoatPlanar(coastDownBoat, { throttle: 1, steer: 0, maxSpeedMph: 20, dt: 1 / 120 });
assert.ok(coastDownBoat.speed * MPH_PER_UNIT > 20, 'Lowering maximum speed should not act like a brake');
for (let step = 0; step < 120 * 45; step++) {
  updateBoatPlanar(coastDownBoat, { throttle: 1, steer: 0, maxSpeedMph: 20, dt: 1 / 120 });
}
assert.ok(coastDownBoat.speed * MPH_PER_UNIT <= 20.1, 'Hull drag should eventually coast down to the new setting');

assert.equal(Math.round(boatHeadingDegrees(-Math.PI / 2)), 0, 'North should read 000 degrees');
assert.equal(Math.round(boatHeadingDegrees(0)), 90, 'East should read 090 degrees');
assert.equal(Math.round(boatHeadingDegrees(Math.PI / 2)), 180, 'South should read 180 degrees');
assert.equal(Math.round(boatHeadingDegrees(Math.PI)), 270, 'West should read 270 degrees');

// Contact samples at bow, stern, port, and starboard create heave, pitch, roll,
// and a small planar response instead of treating the boat as a point mass.
const waveBoat = makeBoat();
const slopedWater = (x, y) => ({ height: x * .08 + y * .03, sx: .08, sy: .03, vz: 0, energy: 1 });
for (let step = 0; step < 120; step++) updateBoatWaterResponse(waveBoat, slopedWater, 1 / 120);
assert.ok(Math.abs(waveBoat.pitch) > .02, 'Longitudinal water slope should pitch the hull');
assert.ok(Math.abs(waveBoat.roll) > .02, 'Transverse water slope should roll the hull');
assert.ok(len(waveBoat.vx, waveBoat.vy) > 0, 'Wave slope should nudge the boat in the horizontal plane');

const wakeBoat = simulateBoat(20, 0, 8);
const emitted = [];
emitWake(emitted, wakeBoat);
assert.equal(emitted.length, 2, 'Planing hull should emit two wake arms');
assert.ok(emitted.every(wake => wake.omega > 0 && wake.groupSpeed > 0), 'Wake packets should carry dispersion data');
const firstWake = emitted[0];
const originalPhase = firstWake.phase;
updateWakes(emitted, 1);
assert.ok(firstWake.phase > originalPhase, 'Wake crests should advance through the group envelope');

// A relevant wake older than the former 500-packet cutoff must still affect
// water while it is visible.
const oldVisibleWake = { ...firstWake, x: 0, y: 0, age: 27, phase: 0, strength: .2, width: 18 };
const irrelevantWakes = Array.from({ length: 600 }, (_, index) => ({
  ...firstWake, x: 10000 + index * 10, y: 10000, age: 1, phase: 0, strength: .2, width: 18
}));
const oldWater = sampleWater([oldVisibleWake, ...irrelevantWakes], 0, 0);
assert.ok(Math.abs(oldWater.height) > .1, 'Every visible wake should remain physically sampleable');
assert.ok(Number.isFinite(oldWater.ux) && Number.isFinite(oldWater.uy), 'Wake samples should expose horizontal orbital water velocity');
assert.ok(
  Math.hypot(oldWater.ux, oldWater.uy) > .1,
  'A gravity-wave crest should carry measurable horizontal orbital flow'
);

const ropeInverseMass = 1 + 200 / CONFIG.boatWeightLb;
assert.equal(ropeTensionForState(0, 100, ropeInverseMass), 0, 'A slack rope must not carry compression or damping load');
const ropeStaticLoad = ropeTensionForState(CONFIG.ropeCompliance, 0, ropeInverseMass);
assert.ok(
  Math.abs(ropeStaticLoad - CONFIG.ropeWorkingLoad) < 1e-9,
  'The configured compliance extension should equal the working rope load'
);
assert.ok(
  ropeTensionForState(CONFIG.ropeCompliance * .5, 8, ropeInverseMass)
    > ropeTensionForState(CONFIG.ropeCompliance * .5, 0, ropeInverseMass),
  'A separating rope should add a damped shock load'
);

// Boat/tube contact uses a rounded hull, low restitution, glancing friction,
// inverse-mass response, and swept detection at extreme lab velocities.
const collisionRider = { mass: 170, grip: 75 };
const collisionBoat = makeBoat();
collisionBoat.angle = 0;
collisionBoat.vx = 20 / MPH_PER_UNIT;
collisionBoat.speed = collisionBoat.vx;
const collisionTube = makeTube(collisionBoat, 0);
collisionTube.x = (CONFIG.boatLength * .5 + 2.25) * UNITS_PER_FOOT;
collisionTube.y = 1.25 * UNITS_PER_FOOT;
collisionTube.vx = 0;
collisionTube.vy = 0;
const collisionMomentumBefore = CONFIG.boatWeightLb * collisionBoat.vx
  + (CONFIG.tubeWeightLb + collisionRider.mass) * collisionTube.vx;
const collisionResult = resolveBoatTubeCollision({
  boat: collisionBoat,
  tube: collisionTube,
  rider: collisionRider,
  previousBoat: { x: collisionBoat.x - collisionBoat.vx / 120, y: collisionBoat.y, angle: collisionBoat.angle },
  previousTube: { x: collisionTube.x, y: collisionTube.y, z: collisionTube.z },
  dt: 1 / 120
});
const collisionMomentumAfter = CONFIG.boatWeightLb * collisionBoat.vx
  + (CONFIG.tubeWeightLb + collisionRider.mass) * collisionTube.vx;
assert.equal(collisionResult.hit, true, 'An overlapping boat and tube should resolve a collision');
assert.ok(collisionResult.relativeSpeedMph > 10, 'Collision should measure closing speed at the hull contact');
assert.ok(collisionTube.vx > 0, 'The lighter tube should be driven away from the hull');
assert.ok(Math.abs(collisionTube.vy) > .05, 'An offset collision should glance sideways rather than rebound head-on');
assert.ok(collisionBoat.vx < 20 / MPH_PER_UNIT, 'The boat should receive the smaller opposite collision reaction');
assert.ok(collisionTube.collisionCompression > .1, 'Impact energy should compress the inflatable tube');
assert.ok(collisionTube.impact > .35, 'A substantial collision should reach the rider-impact system');
assert.ok(boatTubeSeparation(collisionBoat, collisionTube) > -.06 * UNITS_PER_FOOT, 'Collision correction should prevent visible hull overlap');
assert.ok(
  Math.abs(collisionMomentumAfter - collisionMomentumBefore) / Math.abs(collisionMomentumBefore) < .002,
  'Normal and friction impulses should preserve combined linear momentum'
);

const sweptBoat = makeBoat();
sweptBoat.angle = 0;
sweptBoat.x = 30 * UNITS_PER_FOOT;
sweptBoat.vx = 80 / MPH_PER_UNIT;
sweptBoat.speed = sweptBoat.vx;
const sweptTube = makeTube(sweptBoat, 0);
sweptTube.x = 0;
sweptTube.y = 0;
sweptTube.vx = 0;
sweptTube.vy = 0;
const sweptResult = resolveBoatTubeCollision({
  boat: sweptBoat,
  tube: sweptTube,
  rider: collisionRider,
  previousBoat: { x: -30 * UNITS_PER_FOOT, y: 0, angle: 0 },
  previousTube: { x: 0, y: 0, z: 0 },
  dt: 1 / 120
});
assert.equal(sweptResult.hit, true, 'Swept collision should catch a boat crossing the tube between frames');
assert.ok(boatTubeSeparation(sweptBoat, sweptTube) > -.02 * UNITS_PER_FOOT, 'Swept collision should place the tube outside the hull');

// Rope force acts on both bodies. With still water and no starting velocity,
// the first loaded step should preserve their combined linear momentum.
const reactionBoat = makeBoat();
const reactionTube = makeTube(reactionBoat);
reactionTube.y += 5;
const reactionRope = createRope(towPoint(reactionBoat), tubeTowPoint(reactionTube));
updateTowSystem({
  boat: reactionBoat,
  tube: reactionTube,
  ropeChain: reactionRope,
  rider: { mass: 170, grip: 75 },
  wakes: [],
  dt: 1 / 120
});
const combinedMomentumY = CONFIG.boatWeightLb * reactionBoat.vy
  + (170 + CONFIG.tubeWeightLb) * reactionTube.vy;
assert.ok(Math.abs(combinedMomentumY) < 1e-7, 'Tow force should have an equal and opposite boat reaction');

function verticalTowKick(towPointHeightFt) {
  CONFIG.boatTowPointHeightFt = towPointHeightFt;
  const boat = makeBoat();
  const tube = makeTube(boat);
  tube.y += 5;
  const ropeChain = createRope(towPoint(boat), tubeTowPoint(tube));
  updateTowSystem({
    boat,
    tube,
    ropeChain,
    rider: { mass: 170, grip: 200 },
    wakes: [],
    dt: 1 / 60
  });
  return { boat, tube };
}

const savedTowPointHeight = CONFIG.boatTowPointHeightFt;
const lowTowKick = verticalTowKick(.5);
const highTowKick = verticalTowKick(8);
CONFIG.boatTowPointHeightFt = savedTowPointHeight;
assert.ok(highTowKick.tube.pitch > lowTowKick.tube.pitch + .002, 'A higher tow point should create more tube nose-up pitch');
assert.ok(highTowKick.tube.z > lowTowKick.tube.z, 'A higher loaded tow point should lift the tube farther above the water');
assert.ok(highTowKick.boat.vz < lowTowKick.boat.vz, 'Vertical rope force should apply an opposite downward reaction to the boat');

function simulateTubeSlide(friction) {
  CONFIG.tubeWaterFriction = friction;
  const savedRopeLength = CONFIG.ropeLength;
  CONFIG.ropeLength = 10000;
  const slideBoat = makeBoat();
  const slideTube = makeTube(slideBoat);
  slideTube.vx = 72;
  slideTube.prevVx = 72;
  const slideRope = createRope(towPoint(slideBoat), tubeTowPoint(slideTube));
  for (let step = 0; step < 120; step++) {
    updateTowSystem({
      boat: slideBoat,
      tube: slideTube,
      ropeChain: slideRope,
      rider: { mass: 170, grip: 100 },
      wakes: [],
      dt: 1 / 120
    });
  }
  CONFIG.ropeLength = savedRopeLength;
  return len(slideTube.vx, slideTube.vy);
}

const lowFrictionSlideSpeed = simulateTubeSlide(.4);
const highFrictionSlideSpeed = simulateTubeSlide(1.8);
CONFIG.tubeWaterFriction = DEFAULT_TUBE_FRICTION;
assert.ok(
  lowFrictionSlideSpeed > highFrictionSlideSpeed * 1.4,
  `A slick tube should retain substantially more sliding speed than a high-friction tube (${lowFrictionSlideSpeed.toFixed(1)} vs ${highFrictionSlideSpeed.toFixed(1)})`
);

function towKickSpeed(riderMass, riderOn = true) {
  const kickBoat = makeBoat();
  const kickTube = makeTube(kickBoat);
  kickTube.riderOn = riderOn;
  if (!riderOn) kickTube.riderReturn = 3;
  kickTube.y += 5;
  const kickRope = createRope(towPoint(kickBoat), tubeTowPoint(kickTube));
  updateTowSystem({
    boat: kickBoat,
    tube: kickTube,
    ropeChain: kickRope,
    rider: { mass: riderMass, grip: 100 },
    wakes: [],
    dt: 1 / 60
  });
  return len(kickTube.vx, kickTube.vy);
}
assert.ok(towKickSpeed(100) > towKickSpeed(250) * 1.7, 'A lighter rider should accelerate more from the same rope force');
assert.ok(towKickSpeed(170, false) > towKickSpeed(170, true) * 1.45, 'An empty tube should accelerate more readily than a ridden tube');

// Grip responds to how abruptly the rope loads, not only its final tension.
const gradualLoadTube = {
  tension: 0, loadBaseline: 0, loadShock: 0, impact: 0,
  riderOn: true, riderReturn: 0, fallSplash: 0, splash: 0
};
const strongRider = { mass: 170, grip: 100 };
for (let tension = 0; tension <= 260; tension += 5) {
  gradualLoadTube.tension = tension;
  updateRiderGripState(gradualLoadTube, strongRider, .1);
}
assert.equal(gradualLoadTube.riderOn, true, 'A gradual sub-limit rope load should not unseat a strong rider');

const shockLoadTube = {
  tension: 260, loadBaseline: 0, loadShock: 0, impact: 0,
  riderOn: true, riderReturn: 0, fallSplash: 0, splash: 0
};
const shockResult = updateRiderGripState(shockLoadTube, strongRider, 1 / 120);
assert.equal(shockResult.shockOverload, true, 'A sudden high rope-load rise should register as a shock');
assert.equal(shockLoadTube.riderOn, false, 'A sudden high rope-load rise should pull the rider off');
for (let step = 0; step < 3 * 120 + 1; step++) {
  shockLoadTube.tension = 0;
  updateRiderGripState(shockLoadTube, strongRider, 1 / 120);
}
assert.equal(shockLoadTube.riderOn, true, 'A fallen rider should return after the recovery delay');

const ejectionTube = makeTube(makeBoat(), 0);
ejectionTube.x = 20;
ejectionTube.y = 10;
ejectionTube.vx = 105;
ejectionTube.prevVx = 82;
ejectionTube.roll = 0;
const ejectedRider = createFallenRider(ejectionTube, { mass: 170, grip: 75, color: '#78aef0' }, 'rope-shock', 180, 0);
assert.ok(ejectedRider.x < ejectionTube.x, 'A rope shock should place the rider behind the accelerating tube');
assert.equal(ejectedRider.vx, ejectionTube.prevVx, 'A released rider should retain the tube pre-impulse velocity');

const skipTube = makeTube(makeBoat());
skipTube.x = 1000;
skipTube.y = 1000;
skipTube.riderOn = false;
skipTube.riderReturn = 3;
skipTube.fallenRider = {
  x: 0, y: 0, z: .43 * UNITS_PER_FOOT, vx: 22 / MPH_PER_UNIT, vy: 0, vz: -7,
  angle: 0, tumble: 0, spinRate: 2, age: .4, floating: false,
  skipCount: 0, impacts: [], cause: 'rope-shock', color: '#78aef0'
};
const preSkipSpeed = len(skipTube.fallenRider.vx, skipTube.fallenRider.vy);
const skipResult = updateFallenRider(skipTube, { mass: 170, grip: 75 }, [], 1 / 120);
assert.equal(skipResult.skipped, true, 'A fast shallow rider impact should skip off the water');
assert.ok(skipTube.fallenRider.vz > 0, 'A water skip should create an upward rebound');
assert.ok(len(skipTube.fallenRider.vx, skipTube.fallenRider.vy) < preSkipSpeed, 'A water skip should dissipate horizontal energy');
assert.equal(skipTube.fallenRider.impacts.length, 1, 'A water contact should leave a stationary splash event');

const landingTube = makeTube(makeBoat());
landingTube.riderOn = false;
landingTube.riderReturn = 2;
landingTube.fallenRider = {
  x: landingTube.x, y: landingTube.y, z: landingTube.z + 1.5 * UNITS_PER_FOOT,
  vx: landingTube.vx, vy: landingTube.vy, vz: -8, angle: landingTube.angle,
  tumble: 0, spinRate: 1, age: .3, floating: false, skipCount: 0,
  impacts: [], cause: 'hard-landing', color: '#78aef0'
};
const landingResult = updateFallenRider(landingTube, { mass: 170, grip: 75 }, [], 1 / 120);
assert.equal(landingResult.reattached, true, 'A low-relative-speed rider trajectory intersecting the tube should land back on it');
assert.equal(landingTube.riderOn, true, 'Landing back on the tube should restore the rider mass and grip state');

// Replay snapshots the most recent trace and advances independently of the
// live arrays, so new recording cannot move or corrupt playback.
const replayTraces = {
  boat: Array.from({ length: 200 }, (_, index) => ({ x: index, y: 0, angle: 0, z: 0 })),
  tube: Array.from({ length: 200 }, (_, index) => ({ x: index, y: 60, angle: 0, z: 0 })),
  rider: Array.from({ length: 200 }, (_, index) => index >= 50 && index < 80
    ? { x: index - 50, y: 65, z: 2, angle: 0, tumble: index * .1 }
    : null)
};
const replayTest = createReplay(replayTraces);
assert.equal(replayTest.boatFrames.length, 150, 'Replay should retain a bounded recent window');
assert.equal(replayTest.ghost.boat.x, 50, 'Replay should begin at the start of the recent window');
replayTraces.boat[50].x = -1;
advanceReplay(replayTest, .06);
assert.equal(replayTest.ghost.boat.x, 50.5, 'Replay should interpolate between recorded frames');
assert.equal(replayTest.ghost.rider.x, .5, 'Replay should include and interpolate a visible fallen rider');
advanceReplay(replayTest, .06);
assert.equal(replayTest.ghost.boat.x, 51, 'Replay should advance through its private snapshot');
advanceReplay(replayTest, .12 * 150);
assert.equal(replayTest.active, false, 'Replay should stop cleanly after its final frame');
assert.equal(replayTest.ghost, null, 'Replay should clear its ghost when playback ends');
assert.equal(
  createReplay({ boat: replayTraces.boat.slice(0, 5), tube: replayTraces.tube.slice(0, 5) }).active,
  false,
  'Replay should stay disabled until enough trace exists'
);

const connected = simulateConnected(1 / 120);
allNumbersFinite(connected.boat, 'Connected boat state must remain finite');
allNumbersFinite(connected.tube, 'Connected tube state must remain finite');
assert.equal(Object.keys(connected.boat.waterContacts).length, 5, 'Debug data should expose all five boat water contacts');
for (const contact of Object.values(connected.boat.waterContacts)) {
  allNumbersFinite(contact, `${contact.name} boat water contact must remain finite`);
}
assert.equal(connected.tube.contacts.points.length, 4, 'Debug data should expose all four tube water contacts');
assert.ok(Number.isFinite(connected.tube.debugAz), 'Debug data should expose finite vertical tube acceleration');
assert.ok(connected.wakes.length > 0, 'Connected planing run should leave wake history');
assert.equal(connected.ropeChain.length, CONFIG.ropeNodes, 'Rope node count should match configuration');
const connectedTow = towPoint(connected.boat),connectedEye = tubeTowPoint(connected.tube);
assert.ok(Math.abs(connected.ropeChain[0].z-connectedTow.z)<1e-8,'Boat-end rope node should follow the physical tow-eye height');
assert.ok(Math.abs(connected.ropeChain.at(-1).z-connectedEye.z)<1e-8,'Tube-end rope node should follow the physical tow-eye height');
assert.ok(
  connected.minimumTowEyeClearance >= rigidEyeDistance - .03,
  'Pitching should not move the tube tow eye inside the tube body'
);
assert.ok(
  connected.maxExtension <= CONFIG.ropeCompliance + .02,
  `Tow line should stay inside its ${CONFIG.ropeCompliance.toFixed(2)} unit compliance band`
);
assert.ok(
  connected.minimumClearance >= CONFIG.tubeRadius - .03,
  `Rope segments should not cut through the tube (minimum ${connected.minimumClearance.toFixed(3)}, eye ${connected.minimumTowEyeClearance.toFixed(3)})`
);
assert.ok(
  connected.maxTubeMph < 52,
  `Tube whip speed should stay below an extreme nonphysical lead (${connected.maxTubeMph.toFixed(1)} mph)`
);
assert.ok(connected.maxTension > 5, 'Tow line should carry measurable load');

// Boat heave stays restrained on flat water, but a planing hull crossing a
// steep, finite ridge should briefly unload and then make a damped landing.
const flatBoat = makeBoat();
flatBoat.vx = 20 / MPH_PER_UNIT;
flatBoat.speed = flatBoat.vx;
for (let step = 0; step < 360; step++) {
  flatBoat.x += flatBoat.vx / 120;
  updateBoatWaterResponse(flatBoat, () => ({ height: 0, sx: 0, sy: 0, vz: 0, energy: 0 }), 1 / 120);
}
assert.equal(flatBoat.air, false, 'A planing boat should not launch from flat water');
assert.ok(Math.abs(flatBoat.z) < .02, 'Flat-water heave should settle at the surface');

const ridgeBoat = makeBoat();
ridgeBoat.angle = 0;
ridgeBoat.vx = 25 / MPH_PER_UNIT;
ridgeBoat.speed = ridgeBoat.vx;
ridgeBoat.x = -24 * UNITS_PER_FOOT;
const ridgeWidth = 5 * UNITS_PER_FOOT;
const ridgeHeight = 4 * UNITS_PER_FOOT;
let sawBoatAir = false;
let sawBoatLanding = false;
for (let step = 0; step < 600; step++) {
  ridgeBoat.x += ridgeBoat.vx / 120;
  updateBoatWaterResponse(ridgeBoat, x => {
    const q = x / ridgeWidth;
    const height = ridgeHeight * Math.exp(-.5 * q * q);
    return { height, sx: -height * q / ridgeWidth, sy: 0, vz: 0, energy: height / ridgeHeight };
  }, 1 / 120);
  sawBoatAir ||= ridgeBoat.air;
  sawBoatLanding ||= ridgeBoat.splash > .25;
}
assert.ok(sawBoatAir, 'A planing boat should briefly unload from a steep wake ridge');
assert.ok(sawBoatLanding, 'An airborne boat should produce a resolved landing impact');
assert.equal(ridgeBoat.air, false, 'The boat should return to water contact after the ridge');
allNumbersFinite(ridgeBoat, 'Boat launch and landing state must remain finite');

for (const friction of [.4, 1.8]) {
  CONFIG.tubeWaterFriction = friction;
  const frictionRun = simulateConnected(1 / 120, 20);
  allNumbersFinite(frictionRun.tube, `${friction * 100}% friction tube state must remain finite`);
  assert.ok(
    frictionRun.maxExtension <= CONFIG.ropeCompliance + .02,
    `${friction * 100}% tube friction should preserve the tow constraint`
  );
}
CONFIG.tubeWaterFriction = DEFAULT_TUBE_FRICTION;

const finalAttachment = tubeTowPoint(connected.tube);
const finalNearTube = connected.ropeChain[connected.ropeChain.length - 2];
const ropeExitAngle = Math.atan2(finalNearTube.y - finalAttachment.y, finalNearTube.x - finalAttachment.x);
let maximumTubeEndBend = 0;
for (let index = connected.ropeChain.length - 8; index < connected.ropeChain.length - 1; index++) {
  const a = connected.ropeChain[index - 1], b = connected.ropeChain[index], c = connected.ropeChain[index + 1];
  const ab = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
  const bc = { x: c.x - b.x, y: c.y - b.y, z: c.z - b.z };
  const cosine = clamp((ab.x * bc.x + ab.y * bc.y + ab.z * bc.z) / (Math.hypot(ab.x, ab.y, ab.z) * Math.hypot(bc.x, bc.y, bc.z) || 1), -1, 1);
  maximumTubeEndBend = Math.max(maximumTubeEndBend, Math.acos(cosine));
}
assert.ok(
  maximumTubeEndBend < 40 * Math.PI / 180,
  `Tube-end rope curvature should stay smooth (maximum bend ${(maximumTubeEndBend * 180 / Math.PI).toFixed(1)} degrees)`
);
assert.ok(
  Math.abs(normAngle(ropeExitAngle - connected.tube.angle)) <= CONFIG.tubeRopeContactAngle + .03,
  'Rope should leave the tow eye without wrapping through the tube'
);

// Smooth controls should produce closely matching outcomes at practical fixed
// timesteps. Use the 100% reference-damping case for this solver convergence
// guard; the lower-friction 80% default is intentionally more peak-sensitive.
CONFIG.tubeWaterFriction = 1;
const at60 = simulateConnected(1 / 60, 28, STANDARD_MAX_MPH, .92, 7, null, 200);
const at120 = simulateConnected(1 / 120, 28, STANDARD_MAX_MPH, .92, 7, null, 200);
const at240 = simulateConnected(1 / 240, 28, STANDARD_MAX_MPH, .92, 7, null, 200);
CONFIG.tubeWaterFriction = DEFAULT_TUBE_FRICTION;
for (const comparison of [at60, at240]) {
  assert.ok(Math.abs(comparison.finalBoatMph - at120.finalBoatMph) < 2.5, 'Boat result should converge across timesteps');
  assert.ok(Math.abs(comparison.finalTubeMph - at120.finalTubeMph) < 4.5, 'Tube result should converge across timesteps');
  assert.ok(
    Math.abs(comparison.maxTubeMph - at120.maxTubeMph) < 7,
    `Peak tube speed should converge across timesteps (${comparison.maxTubeMph.toFixed(1)} vs ${at120.maxTubeMph.toFixed(1)} mph)`
  );
}

const experimentalLabRun = simulateConnected(1 / 120, 26, LAB_MAX_MPH, .2, 17);
allNumbersFinite(experimentalLabRun.boat, '100 mph lab boat state must remain finite');
allNumbersFinite(experimentalLabRun.tube, '100 mph lab tube state must remain finite');
assert.ok(experimentalLabRun.finalBoatMph > 70, 'Experimental lab run should exercise high-speed physics');
assert.ok(
  experimentalLabRun.maxExtension <= CONFIG.ropeCompliance + .02,
  'Tow constraint should remain stable in the experimental 100 mph range'
);

// The single fictional boat profile must apply every physical baseline used by the game.
const profileResults = [];
for (const profile of Object.values(BOAT_PROFILES)) {
  CONFIG.boatTowAttachment = 'ski';
  applyBoatProfile(profile.id);
  assert.equal(CONFIG.boatModel, profile.label, `${profile.label} should apply its model name`);
  assert.equal(CONFIG.boatDriveType, profile.driveType, `${profile.label} should apply its drive type`);
  assert.equal(CONFIG.boatWeightLb, profile.weightLb, `${profile.label} should apply its mass`);
  assert.equal(CONFIG.boatEngineHp, profile.engineHp, `${profile.label} should apply its power`);
  assert.equal(CONFIG.vectorThrustSteering, profile.vectorThrustSteering, `${profile.label} should apply its propulsion steering contribution`);
  assert.equal(CONFIG.steeringLeverRatio, profile.steeringLeverRatio, `${profile.label} should apply its steering-force position`);
  assert.equal(CONFIG.steeringYawCoupling, profile.steeringYawCoupling, `${profile.label} should apply its steering yaw coupling`);
  assert.equal(CONFIG.boatTopSpeedMph, profile.topSpeedMph, `${profile.label} should apply its reference top speed`);
  assert.equal(CONFIG.boatTowPointHeightFt, profile.skiTowPointHeightFt, `${profile.label} should apply its ski tow-point height`);
  assert.equal(CONFIG.boatTowPointRatio, profile.skiTowPointRatio, `${profile.label} should apply its rear ski tow position`);
  const attachmentBoat = makeBoat();
  const skiTow = towPoint(attachmentBoat);
  const towerAttachment = applyBoatTowAttachment(profile, 'tower');
  const towerTow = towPoint(attachmentBoat);
  assert.equal(towerAttachment.heightFt, profile.towerTowPointHeightFt, `${profile.label} should apply its tower height`);
  assert.ok(towerTow.z > skiTow.z, `${profile.label} tower should attach higher than its ski tow point`);
  assert.ok(
    Math.hypot(towerTow.x - attachmentBoat.x, towerTow.y - attachmentBoat.y)
      < Math.hypot(skiTow.x - attachmentBoat.x, skiTow.y - attachmentBoat.y),
    `${profile.label} tower should apply rope force nearer the hull center`
  );
  applyBoatTowAttachment(profile, 'ski');
  assert.ok(profile.topSpeedMph >= 35 && profile.topSpeedMph <= LAB_MAX_MPH, `${profile.label} should have a plausible lab speed ceiling`);
  assert.ok(CONFIG.boatWakeFactor > 0, `${profile.label} should have positive wake output`);
  const profileTopBoat = simulateBoat(profile.topSpeedMph, 0, 40);
  assert.ok(
    profileTopBoat.speed * MPH_PER_UNIT > profile.topSpeedMph * .97,
    `${profile.label} should approach its selected reference top speed`
  );
  assert.ok(
    profileTopBoat.speed * MPH_PER_UNIT <= profile.topSpeedMph + .05,
    `${profile.label} should not exceed its selected reference top speed`
  );
  const profileBoat = simulateBoat(30, .45, 18);
  allNumbersFinite(profileBoat, `${profile.label} boat state must remain finite`);
  assert.ok(profileBoat.speed * MPH_PER_UNIT > 12, `${profile.label} should pull a tube at useful speed`);
  const profileWakes = [];
  emitWake(profileWakes, profileBoat);
  assert.equal(profileWakes.length, 2, `${profile.label} should emit two diverging wake arms`);
  const hardTurnBoat = simulateHardTurnEntry(30);
  profileResults.push({
    id: profile.id,
    drive: profile.driveType,
    topSpeedMph: profile.topSpeedMph,
    mph: profileBoat.speed * MPH_PER_UNIT,
    hardTurnMph: len(hardTurnBoat.vx, hardTurnBoat.vy) * MPH_PER_UNIT,
    hardTurnRadiusFt: turnRadiusFeet(hardTurnBoat),
    wakeAmplitude: profileWakes[0].amplitude * profileWakes[0].strength
  });
}
assert.deepEqual(
  Object.keys(BOAT_PROFILES),
  [DEFAULT_BOAT_ID],
  'Only the fictional starter boat should ship'
);
const starterBoatResult = profileResults[0];
assert.equal(starterBoatResult.id, DEFAULT_BOAT_ID, 'Profile test should exercise the starter boat');
assert.equal(starterBoatResult.drive, 'v-drive', 'Starter boat should retain its V-drive handling');
assert.ok(
  starterBoatResult.hardTurnMph > 25,
  'Starter boat should not shed speed excessively during a two-second 30 mph hard-over entry'
);
assert.ok(
  starterBoatResult.hardTurnRadiusFt < 40,
  'Starter boat should retain its tight V-drive turning radius'
);
applyBoatProfile(DEFAULT_BOAT_ID);
applyBoatTowAttachment(DEFAULT_BOAT_ID, 'ski');
CONFIG.hairpinStrength = 1;
CONFIG.wakeStrength = 1;

console.log('Physics smoke test passed', {
  connected120: {
    boatMph: connected.finalBoatMph.toFixed(1),
    tubeMph: connected.finalTubeMph.toFixed(1),
    maxTubeMph: connected.maxTubeMph.toFixed(1),
    maxTension: connected.maxTension.toFixed(0),
    peakG: connected.tube.peakG.toFixed(1)
  },
  timestepMaxTubeMph: [at60.maxTubeMph, at120.maxTubeMph, at240.maxTubeMph].map(value => value.toFixed(1)),
  experimentalLabMph: experimentalLabRun.finalBoatMph.toFixed(1),
  boatProfiles: profileResults.map(result => `${result.drive}:${result.mph.toFixed(1)}`)
});

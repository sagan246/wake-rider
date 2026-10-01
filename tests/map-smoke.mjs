import assert from 'node:assert/strict';
import { CONFIG, UNITS_PER_FOOT } from '../physics/config.js';
import { createFallenRider } from '../physics/rider.js';
import { BOAT_SHORE_RESPONSE, hasWaterClearance, isWater, nearestShore, resolveShoreCollision } from '../physics/shore.js';
import { createSimulator } from '../simulation/simulator.js';
import { getMap } from '../maps/catalog.js';

const point = (x, y) => ({ x, y });
const square = [point(-100, -100), point(100, -100), point(100, 100), point(-100, 100)];
const island = [point(-5, -30), point(5, -30), point(5, 30), point(-5, 30)];
const map = { id: 'test', rings: [square, island], spawn: { x: -50, y: 0, angle: 0 } };
assert.ok(isWater(map, -50, 0));
assert.ok(!isWater(map, 0, 0), 'An island is land regardless of its winding');
assert.ok(!isWater(map, 101, 0));
assert.equal(nearestShore(map, -50, 0).distance, 45);
assert.ok(isWater({ rings: [square.toReversed(), island.toReversed()] }, -50, 0));
assert.ok(!isWater({ rings: [square.toReversed(), island.toReversed()] }, 0, 0));

const fastBody = { x: 70, y: 0, vx: 12000, vy: 0 };
assert.ok(resolveShoreCollision(map, fastBody, { x: -70, y: 0 }, 4).hit);
assert.ok(fastBody.x < -9, 'A fast body cannot tunnel through the island to water beyond it');
assert.equal(fastBody.vx, 0);
const glance = { x: 110, y: 40, vx: 100, vy: 30 };
resolveShoreCollision(map, glance, { x: 70, y: 0 }, 4);
assert.ok(glance.x < 96 && glance.y > 20, 'Glancing impacts should slide along shore');
assert.ok(glance.vy > 0 && glance.vx === 0);
assert.ok(hasWaterClearance(map, glance.x, glance.y, 4));

// The boat's physical pass rebounds, while the default above remains suitable
// for validating network snapshots and containing positional corrections.
const bounce = { x: 105, y: 70, vx: 100, vy: 0 };
const bounceHit = resolveShoreCollision(map, bounce, { x: 85, y: 70 }, 4, BOAT_SHORE_RESPONSE);
assert.ok(bounceHit.hit && bounce.vx < -35, 'Head-on boat hits rebound into water');
assert.ok(bounce.x < 95, 'Remaining movement follows the rebound, not the bank');
assert.ok(Math.hypot(bounce.vx,bounce.vy) < 100, 'A bounce cannot create kinetic energy');
assert.ok(hasWaterClearance(map,bounce.x,bounce.y,4));
const skim = { x: 103, y: 80, vx: 60, vy: 100 };
resolveShoreCollision(map,skim,{x:85,y:50},4,BOAT_SHORE_RESPONSE);
assert.ok(skim.vx < 0 && skim.vy >= 97, 'Glancing hits retain nearly all motion along the bank');
assert.ok(hasWaterClearance(map,skim.x,skim.y,4));
const islandBounce = { x: 70, y: 0, vx: 12000, vy: 0 };
resolveShoreCollision(map,islandBounce,{x:-70,y:0},4,BOAT_SHORE_RESPONSE);
assert.ok(islandBounce.x < -9 && hasWaterClearance(map,islandBounce.x,islandBounce.y,4), 'Reflected high-speed movement cannot tunnel through an island');
const cornerBounce = { x: 120, y: 120, vx: 100, vy: 100 };
resolveShoreCollision(map,cornerBounce,{x:70,y:70},4,BOAT_SHORE_RESPONSE);
assert.ok(cornerBounce.vx < 0 && cornerBounce.vy < 0 && hasWaterClearance(map,cornerBounce.x,cornerBounce.y,4), 'A corner rebound resolves both banks');

const open = getMap('open');
const unbounded = { x: 1e8, y: -1e8, vx: 90, vy: -90 };
assert.ok(!resolveShoreCollision(open, unbounded, { x: 0, y: 0 }, 50).hit);
assert.equal(unbounded.x, 1e8, 'The original map remains unbounded');

const lake = getMap('oswego');
const rider = { mass: 130, grip: 75, color: '#78aef0' };
const simulator = createSimulator({ map: lake });
assert.equal(simulator.getState().map, lake);
const boatRadius = Math.hypot(CONFIG.boatLength, CONFIG.boatBeam) * UNITS_PER_FOOT * .5;
const bounceLake={id:'bounce-test',rings:[[point(-4000,-4000),point(4000,-4000),point(4000,4000),point(-4000,4000)]],spawn:{x:3850,y:0,angle:0}};
const bounceSim=createSimulator({map:bounceLake});
for(const body of [bounceSim.getState().boat,bounceSim.getState().tube])body.vx=200;
let firstImpactX=null,maxRetreat=0;
for(let frame=0;frame<960;frame++){
  const {state}=bounceSim.step({dt:1/120,throttle:{forward:1,reverse:0},steer:frame>240?.8:0,maxSpeedMph:45,cruiseEnabled:false,cruiseSpeedMph:20,rider});
  assert.ok(hasWaterClearance(bounceLake,state.boat.x,state.boat.y,boatRadius));
  assert.ok(hasWaterClearance(bounceLake,state.tube.x,state.tube.y,CONFIG.tubeRadius));
  if(firstImpactX===null&&state.boat.shoreBounceTime>0){firstImpactX=state.boat.x;assert.ok(state.boat.vx<0,'Actual towing simulation keeps the outward rebound');}
  if(firstImpactX!==null && frame<=240)maxRetreat=Math.max(maxRetreat,firstImpactX-state.boat.x);
}
assert.notEqual(firstImpactX,null,'Full-throttle shoreline impact was exercised');
assert.ok(maxRetreat>2*UNITS_PER_FOOT,'Holding forward does not cancel the bounce immediately');
assert.ok(4000-bounceSim.getState().boat.x>boatRadius+4*UNITS_PER_FOOT,'Steering after a bounce clears the bank');
function checkState(state) {
  assert.ok(hasWaterClearance(lake, state.boat.x, state.boat.y, boatRadius), 'Entire hull remains in water');
  assert.ok(hasWaterClearance(lake, state.tube.x, state.tube.y, CONFIG.tubeRadius), 'Tube remains in water');
  for (const body of [state.boat, state.tube, state.tube.fallenRider].filter(Boolean)) {
    for (const key of ['x', 'y', 'z', 'vx', 'vy', 'vz']) assert.ok(Number.isFinite(body[key]), `${key} remains finite`);
  }
  if (state.tube.fallenRider) {
    assert.ok(hasWaterClearance(lake, state.tube.fallenRider.x, state.tube.fallenRider.y, 1.5 * UNITS_PER_FOOT));
  }
  for (const node of state.ropeChain) {
    assert.ok(Number.isFinite(node.x) && Number.isFinite(node.y) && Number.isFinite(node.z));
  }
}
checkState(simulator.getState());
// Drive into the closest real shoreline, then steer/reverse away. Exercise
// high-speed towing, the rider's independent motion, and repeated impacts.
const shore = nearestShore(lake, simulator.getState().boat.x, simulator.getState().boat.y);
const boat = simulator.getState().boat;
boat.angle = Math.atan2(shore.y - boat.y, shore.x - boat.x);
let shoreContacts = 0;
for (let frame = 0; frame < 5400; frame++) {
  if (frame === 600) {
    const tube = simulator.getState().tube;
    tube.riderOn = false;
    tube.riderReturn = 12;
    tube.fallenRider = createFallenRider(tube, rider, 'hard-landing');
    const riderShore = nearestShore(lake, tube.x, tube.y);
    const direction = Math.atan2(riderShore.y - tube.y, riderShore.x - tube.x);
    tube.fallenRider.vx = Math.cos(direction) * 1800;
    tube.fallenRider.vy = Math.sin(direction) * 1800;
  }
  const reverse = frame >= 1800 && frame < 2600;
  const { state } = simulator.step({
    dt: 1 / 120, throttle: { forward: reverse ? 0 : 1, reverse: reverse ? 1 : 0 },
    steer: frame < 1800 ? 0 : Math.sin(frame / 700),
    maxSpeedMph: 100, cruiseEnabled: false, cruiseSpeedMph: 20, rider
  });
  checkState(state);
  if (nearestShore(lake, state.boat.x, state.boat.y).distance < boatRadius + 1) shoreContacts++;
}
assert.ok(shoreContacts > 10, 'Real shoreline collision was exercised');
assert.ok(simulator.startReplay());
const changed = simulator.setMap(open);
assert.equal(changed.map.id, 'open');
assert.equal(changed.boat.x, 0);
assert.equal(changed.replay.active, false);
assert.equal(changed.simTime, 0);
assert.equal(changed.wakes.length, 0);
assert.equal(changed.traces.boat.length, 0);
assert.equal(simulator.setMap(lake).map.id, 'oswego');

const originalRopeLength = CONFIG.ropeLength;
try {
  CONFIG.ropeLength = 2000 * UNITS_PER_FOOT;
  checkState(simulator.reset());
  const initialTube = { x: simulator.getState().tube.x, y: simulator.getState().tube.y };
  for (let frame = 0; frame < 120; frame++) {
    checkState(simulator.step({
      dt: 1 / 120, throttle: { forward: 0, reverse: 0 }, steer: 0,
      maxSpeedMph: 30, cruiseEnabled: false, cruiseSpeedMph: 20, rider
    }).state);
  }
  const tube = simulator.getState().tube;
  assert.ok(Math.hypot(tube.x - initialTube.x, tube.y - initialTube.y) < 50,
    'A long rope spawns with slack without launching or teleporting the tube');
} finally {
  CONFIG.ropeLength = originalRopeLength;
}
assert.equal(createSimulator().getState().map.id, 'open', 'Existing simulator callers keep their original map');
console.log('Lake map smoke test passed', { rings: lake.rings.length, shoreContacts });

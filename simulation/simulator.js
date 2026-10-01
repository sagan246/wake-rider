import { CONFIG, FEET_PER_UNIT, MPH_PER_UNIT, UNITS_PER_FOOT } from '../physics/config.js';
import { clamp, len } from '../physics/math.js';
import { createRope, solveTubeRope } from '../physics/rope.js';
import { emitWake, sampleWater, updateWakes } from '../physics/wake.js';
import { towPoint, updateBoatPlanar, updateBoatWaterResponse } from '../physics/boat.js';
import { tubeCenterBehindBoat, tubeTowPoint, updateTowSystem } from '../physics/tow.js';
import { resolveBoatTubeCollision } from '../physics/collision.js';
import { createBoatState, createTubeState } from '../physics/state.js';
import { advanceReplay, createReplay } from '../replay.js';
import { createCruiseState, updateCruiseThrottle } from '../physics/cruise.js';
import { BOAT_SHORE_RESPONSE, resolveShoreCollision } from '../physics/shore.js';
import { createSharedWakeField } from './shared-wakes.js';
import { startBoatBump } from '../physics/boat-bump.js';
import { startTubeGlide } from '../physics/tube-impact.js';

const WAKE_EMISSION_HZ = 10;
const TRACE_INTERVAL = .12;
const MAX_TRACE_FRAMES = 500;
const OPEN_MAP = Object.freeze({
  id: 'open', name: 'Open water', rings: [],
  spawn: { x: 0, y: 0, angle: -Math.PI / 2 }, bounds: null
});

export function createSimulator({ map: initialMap = OPEN_MAP, sharedWakes = false, wakeClock } = {}) {
  let map = initialMap;
  const cruiseState = createCruiseState();
  let boat;
  let tube;
  let wakes;
  let ropeChain;
  let traces;
  let replay;
  let simTime;
  let peaks;
  let sharedWakeField;
  let wakeSequence=0; // Never reuse a prediction ID after a reset or rejoin.

  function getState() {
    return { boat, tube, wakes, ropeChain, traces, replay, simTime, peaks, map };
  }

  function resetCruiseController() {
    cruiseState.integral = 0;
    cruiseState.output = 0;
  }

  function reset(spawn) {
    boat = createBoatState();
    Object.assign(boat, spawn || map.spawn || OPEN_MAP.spawn);
    resolveShoreCollision(map, boat, boat, boatShoreRadius());
    const tubeStart = tubeCenterBehindBoat(boat);
    tube = createTubeState(tubeStart, boat.angle);
    // A very long lab rope can exceed a cove's width. Starting at the first
    // shore along its path gives the rope slack without moving bodies on land.
    resolveShoreCollision(map, tube, boat, CONFIG.tubeRadius);
    wakes = [];
    sharedWakeField=createSharedWakeField(wakes,{clock:wakeClock});
    ropeChain = createRope(towPoint(boat), tubeTowPoint(tube));
    traces = { boat: [], tube: [], rider: [], clock: 0 };
    replay = { active: false, index: 0, ghost: null };
    simTime = 0;
    peaks = { boat: 0, tube: 0, rope: 0, air: 0 };
    resetCruiseController();
    return getState();
  }

  function setMap(nextMap) {
    map = nextMap || OPEN_MAP;
    return reset();
  }

  function boatShoreRadius() {
    // The enclosing circle also keeps the bow/stern clear while turning.
    return Math.hypot(CONFIG.boatLength, CONFIG.boatBeam) * UNITS_PER_FOOT * .5;
  }

  function refreshBoatSpeeds() {
    boat.speed = Math.max(0, boat.vx * Math.cos(boat.angle) + boat.vy * Math.sin(boat.angle));
    boat.lateralSpeed = -boat.vx * Math.sin(boat.angle) + boat.vy * Math.cos(boat.angle);
  }

  function applyNetworkCorrection({dx,dy,dvx,dvy,boatBump,tube: tubeChange}) {
    if (![dx,dy,dvx,dvy].every(Number.isFinite)) return;
    if(tubeChange&&!['dx','dy','dvx','dvy'].every(k=>Number.isFinite(tubeChange[k])))return;
    const previousBoat={x:boat.x,y:boat.y},previousTube={x:tube.x,y:tube.y};
    const previousRider=tube.fallenRider&&{x:tube.fallenRider.x,y:tube.fallenRider.y};
    // Move the complete tow system together so separation cannot stretch its rope.
    for(const body of [boat,tube,tube.fallenRider].filter(Boolean)){body.x+=dx;body.y+=dy;}
    for(const node of ropeChain){node.x+=dx;node.y+=dy;node.px+=dx;node.py+=dy;}
    boat.vx+=dvx;boat.vy+=dvy;
    if(boatBump)startBoatBump(boat,dvx,dvy);
    if(tubeChange){
      // A different boat hit our tube. Leave our boat and any fallen rider
      // where they are; refit the line without introducing Verlet velocity.
      tube.x+=tubeChange.dx;tube.y+=tubeChange.dy;
      tube.vx+=tubeChange.dvx;tube.vy+=tubeChange.dvy;
      startTubeGlide(tube,tubeChange.dvx,tubeChange.dvy);
      for(let i=0;i<ropeChain.length;i++){
        const node=ropeChain[i],weight=i/(ropeChain.length-1);
        node.x+=tubeChange.dx*weight;node.y+=tubeChange.dy*weight;
        node.px=node.x;node.py=node.y;node.pz=node.z;
      }
      const severity=Math.max(0,Math.min(1,tubeChange.impact||0));
      if(severity>0){
        tube.collisionCompression=Math.max(tube.collisionCompression||0,.05+severity*.29);
        tube.collisionCompressionVelocity=Math.max(tube.collisionCompressionVelocity||0,severity*.65);
        tube.collisionNormalX=tubeChange.normalX||0;tube.collisionNormalY=tubeChange.normalY||0;
        tube.collisionSplash=Math.max(tube.collisionSplash||0,.25+severity*.75);
        tube.collisionContactX=tube.x-tube.collisionNormalX*CONFIG.tubeRadius;
        tube.collisionContactY=tube.y-tube.collisionNormalY*CONFIG.tubeRadius;
        tube.collisionAge=0;tube.collisionImpactTime=.3;
        tube.impact=Math.max(tube.impact||0,severity);tube.splash=Math.max(tube.splash||0,severity*.7);
      }
    }
    resolveShoreCollision(map,boat,previousBoat,boatShoreRadius());
    resolveShoreCollision(map,tube,previousTube,CONFIG.tubeRadius);
    if(tube.fallenRider)resolveShoreCollision(map,tube.fallenRider,previousRider,1.5*UNITS_PER_FOOT);
    for(const node of ropeChain){node.px=node.x;node.py=node.y;node.pz=node.z;}
    solveTubeRope(ropeChain,towPoint(boat),tubeTowPoint(tube),tube,0);
    for(const node of ropeChain){node.px=node.x;node.py=node.y;node.pz=node.z;}
    tube.prevVx=tube.vx;tube.prevVy=tube.vy;
    refreshBoatSpeeds();
    return getState();
  }

  function recordTrace(dt) {
    traces.clock += dt;
    if (traces.clock < TRACE_INTERVAL) return;
    traces.clock -= TRACE_INTERVAL;
    const fallen = tube.fallenRider;
    traces.boat.push({ x: boat.x, y: boat.y, vx: boat.vx, vy: boat.vy, angle: boat.angle, z: boat.z });
    traces.tube.push({ x: tube.x, y: tube.y, vx: tube.vx, vy: tube.vy, angle: tube.angle, z: tube.z });
    traces.rider.push(fallen
      ? { x: fallen.x, y: fallen.y, z: fallen.z, angle: fallen.angle, tumble: fallen.tumble, color: fallen.color }
      : null);
    if (traces.boat.length > MAX_TRACE_FRAMES) {
      traces.boat.shift();
      traces.tube.shift();
      traces.rider.shift();
    }
  }

  function startReplay() {
    const nextReplay = createReplay(traces);
    if (!nextReplay.active) return false;
    replay = nextReplay;
    return true;
  }

  function step({
    dt,
    throttle,
    steer,
    maxSpeedMph,
    cruiseEnabled,
    cruiseSpeedMph,
    rider
  }) {
    simTime += dt;

    if (replay.active) {
      return {
        state: getState(),
        replayGhost: advanceReplay(replay, dt),
        metrics: null
      };
    }

    const previousBoat = { x: boat.x, y: boat.y, angle: boat.angle };
    const previousTube = { x: tube.x, y: tube.y, z: tube.z, air: tube.air, riderOn: tube.riderOn };
    const previousRider = tube.fallenRider && { x: tube.fallenRider.x, y: tube.fallenRider.y };
    const controlledForwardThrottle = updateCruiseThrottle(cruiseState, {
      enabled: cruiseEnabled,
      targetSpeedMph: cruiseSpeedMph,
      currentSpeedMph: Math.max(0, boat.speed) * MPH_PER_UNIT,
      driverThrottle: throttle.forward,
      maxSpeedMph,
      dt
    });
    const effectiveThrottle = controlledForwardThrottle - throttle.reverse * .48;

    const shoreRecovery = boat.shoreBounceTime > 0;
    boat.shoreBounceTime = Math.max(0, boat.shoreBounceTime - dt);
    updateBoatPlanar(boat, { throttle: effectiveThrottle, steer, maxSpeedMph, dt, shoreRecovery });
    const boatImpact = resolveShoreCollision(map, boat, previousBoat, boatShoreRadius(), BOAT_SHORE_RESPONSE);
    if (boatImpact.hit) {
      refreshBoatSpeeds();
      if (boatImpact.impactSpeed * MPH_PER_UNIT > 2) boat.shoreBounceTime = .65;
    }
    const boatAfterShore = { x: boat.x, y: boat.y };
    if (Math.floor(simTime * WAKE_EMISSION_HZ) !== Math.floor((simTime - dt) * WAKE_EMISSION_HZ)) {
      if(sharedWakes)sharedWakeField.predict(boat,++wakeSequence);
      else emitWake(wakes, boat);
    }
    if(sharedWakes)sharedWakeField.advance(dt);
    else updateWakes(wakes, dt);
    updateBoatWaterResponse(boat, (x, y) => sampleWater(wakes, x, y), dt);

    const towResult = updateTowSystem({ boat, tube, ropeChain, rider, wakes, dt });
    const water = towResult.water;
    let planarSpeed = towResult.planarSpeed;
    const collision = resolveBoatTubeCollision({ boat, tube, rider, previousBoat, previousTube, dt });
    if (collision.hit) {
      solveTubeRope(ropeChain, towPoint(boat), tubeTowPoint(tube), tube, dt);
      planarSpeed = len(tube.vx, tube.vy);
    }

    // Tow constraints and boat/tube contacts can change positions after the
    // integration above, so shoreline containment is the final constraint.
    const boatShore = resolveShoreCollision(map, boat, boatAfterShore, boatShoreRadius());
    const tubeShore = resolveShoreCollision(map, tube, previousTube, CONFIG.tubeRadius);
    if (tube.fallenRider) {
      resolveShoreCollision(map, tube.fallenRider, previousRider || previousTube, 1.5 * UNITS_PER_FOOT);
    }
    if (boatImpact.hit || boatShore.hit || tubeShore.hit) {
      refreshBoatSpeeds();
      planarSpeed = len(tube.vx, tube.vy);
      // Refit endpoints without integrating the Verlet rope for a second time.
      for (const node of ropeChain) { node.px = node.x; node.py = node.y; node.pz = node.z; }
      solveTubeRope(ropeChain, towPoint(boat), tubeTowPoint(tube), tube, 0);
      for (const node of ropeChain) { node.px = node.x; node.py = node.y; node.pz = node.z; }
      tube.prevVx = tube.vx;
      tube.prevVy = tube.vy;
    }

    recordTrace(dt);

    const boatMph = len(boat.vx, boat.vy) * MPH_PER_UNIT;
    const tubeMph = planarSpeed * MPH_PER_UNIT;
    const ropePct = Math.round(clamp(tube.tension / 300, 0, 1) * 100);
    const airFt = Math.max(0, tube.z - water.height) * FEET_PER_UNIT;
    peaks.boat = Math.max(peaks.boat, boatMph);
    peaks.tube = Math.max(peaks.tube, tubeMph);
    peaks.rope = Math.max(peaks.rope, ropePct);
    peaks.air = Math.max(peaks.air, airFt);

    return {
      state: getState(),
      replayGhost: null,
      metrics: {
        boatMph,
        tubeMph,
        ropePct,
        airFt,
        feltG: tube.feltG,
        peakG: tube.peakG,
        peaks
      }
    };
  }

  reset();

  return {
    setSharedWakeMode(enabled){sharedWakes=!!enabled;wakes.length=0;sharedWakeField=createSharedWakeField(wakes,{clock:wakeClock});},
    receiveSharedWakes(events,time,receipt){if(sharedWakes)sharedWakeField.receive(events,time,receipt);},
    getWakeSamples(){return sharedWakes?sharedWakeField.samples():[];},
    getState,
    reset,
    setMap,
    resetCruiseController,
    applyNetworkCorrection,
    startReplay,
    step
  };
}
